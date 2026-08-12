import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index';
import type { Database, DbExecutor, DbHandle } from './client';
import { resolvePoolSizes, type ProcessRole } from './pool-budget';

/**
 * SEPARATE CONNECTION POOLS — 04-RESILIENCE-PLAN.md §3.1.
 *
 * "The highest-value isolation." Also the cheapest, which is why it is worth
 * being precise about what it buys.
 *
 * F4 in the failure model — "Postgres saturated, connection pool exhausted" —
 * is rated High likelihood and its blast radius is "looks like a total
 * outage". With ONE shared pool, a single slow query path is enough: vector
 * search under load takes 4 seconds a query, twenty of them arrive, and every
 * connection is held. Login now queues behind search. The database is healthy,
 * the application is healthy, and the product is down.
 *
 * With four pools, that same spike exhausts the `ai` pool and NOTHING ELSE
 * NOTICES. Retrieval degrades; login is untouched, because login physically
 * cannot use a connection that belongs to another pool.
 *
 *   auth    10   identity, sessions   — must never be starved
 *   core    20   ordinary traffic
 *   ai       8   vector search        — capped so it cannot exhaust the others
 *   worker   6   background jobs      — never competes with live traffic
 *
 * ===========================================================================
 * THOSE FOUR NUMBERS ARE A REQUEST, NOT A BUDGET — and the budget is
 * PER PROCESS. Corrected in D-228; the sentence that used to sit here was
 * actively misleading.
 *
 * It read: "44 total, comfortably inside a default `max_connections` of 100."
 * 44 is ONE process's sum, and there are two — `main.ts` and `worker-main.ts`
 * both call `createContainer`, so both built all four pools and the real figure
 * was 88 of 100 with a single replica of each. One extra replica, or the
 * overlap of a rolling deploy, crosses `max_connections`; the symptom is every
 * pool failing at once plus a `psql` that cannot connect to find out why.
 *
 * What is enforced now:
 *
 *   PER PROCESS   `resolvePoolSizes` trims by ROLE (an api never claims a job;
 *                 a worker never serves a login) and then scales the whole set
 *                 down proportionally to `DATABASE_POOL_MAX`. At the defaults:
 *                 api  10 + 20 + 8 + 2 = 40
 *                 worker 2 +  4 + 8 + 6 = 20
 *
 *   ACROSS        cannot be enforced from inside one process; it is the
 *   REPLICAS      operator's sum and it is stated so it can be checked:
 *                     api_replicas x 40  +  worker_replicas x 20
 *                       + headroom for psql and for a rolling deploy's overlap
 *                       <= max_connections
 *                 One of each is 60 of 100. A rolling api deploy briefly makes
 *                 that 100, which is why the ceiling is a variable.
 *
 * See `pool-budget.ts` for the arithmetic, which is a tested pure function
 * rather than a paragraph.
 *
 * `withTransaction` operates within a SINGLE pool. A transaction spanning two
 * pools is two transactions, and the second one committing after the first
 * fails is precisely the partial write the plan forbids.
 */

export type PoolName = 'auth' | 'core' | 'ai' | 'worker';

export const POOL_NAMES: readonly PoolName[] = ['auth', 'core', 'ai', 'worker'];

export interface DbPoolSizes {
  readonly auth: number;
  readonly core: number;
  readonly ai: number;
  readonly worker: number;
}

export interface DbPoolsConfig {
  readonly url: string;
  readonly ssl: boolean;
  /**
   * The provider's CA, PEM. `null` means "use Node's trust store", which is
   * correct for every managed Postgres whose root is a public CA.
   */
  readonly sslCa: string | null;
  /**
   * TLS WITHOUT CERTIFICATE VERIFICATION. `true` only when an operator has set
   * `DATABASE_SSL_INSECURE` deliberately — see the note on `createNamedPool`.
   */
  readonly sslInsecure: boolean;
  /** The REQUESTED sizes. `resolvePoolSizes` decides what is actually opened. */
  readonly sizes: DbPoolSizes;
  /** Which process this is. An api does not need the `worker` pool (D-228). */
  readonly role: ProcessRole;
  /** `DATABASE_POOL_MAX` — the ceiling across all four pools in THIS process. */
  readonly maxConnections: number;
  /** §4 — the Postgres statement timeout for ordinary queries. */
  readonly statementTimeoutMs: number;
  /** §4 — the shorter statement timeout applied to the `ai` pool. */
  readonly vectorStatementTimeoutMs: number;
  /** §4 — how long establishing a connection may take. */
  readonly connectTimeoutMs: number;
  /**
   * `hnsw.ef_search` for EVERY POOL RETRIEVAL CAN RUN ON — `ai` and `worker`.
   *
   * An HNSW index scan returns no more rows than this, and pgvector's default
   * is 40 while §8.4 asks for the top 50 (D-041). Set here, on the connection,
   * so retrieval cannot under-retrieve by forgetting to set it — see the note
   * on `createNamedPool`.
   */
  readonly hnswEfSearch: number;
}

/** A named pool: everything `DbHandle` offers, plus which pool it is. */
export interface NamedDbHandle extends DbHandle {
  readonly name: PoolName;
  readonly max: number;
}

export interface DbPools {
  readonly auth: NamedDbHandle;
  readonly core: NamedDbHandle;
  readonly ai: NamedDbHandle;
  readonly worker: NamedDbHandle;
  /** Every pool, for health reporting and shutdown. */
  all(): readonly NamedDbHandle[];
  stats(): readonly DbPoolStats[];
  /** Closes every pool. Safe to call twice. */
  close(): Promise<void>;
}

export interface DbPoolStats {
  readonly name: PoolName;
  readonly max: number;
  readonly total: number;
  readonly idle: number;
  readonly waiting: number;
}

/**
 * Builds the Postgres startup options for a pool.
 *
 * EVERYTHING HERE IS A CONNECTION PARAMETER RATHER THAN A `SET`, for the same
 * reason in both cases: a `SET` can be missed. A connection created during a
 * reconnect storm, or handed out before a setup query ran, would silently have
 * no timeout and no search breadth at all — and the one query that runs
 * forever, or the one that quietly returns 40 rows, is the one on the
 * connection nobody could account for. As startup parameters these are
 * properties OF the connection rather than something that must be applied to
 * it (D-028).
 *
 * `hnsw.ef_search` is set on every pool that runs vector search — `ai` in the
 * API process and `worker` in the background one, because `buildModules` gives
 * retrieval the `worker` pool there. Postgres
 * accepts a namespaced setting it does not yet recognise as a placeholder and
 * reconciles it when pgvector loads, so this works even on a connection made
 * before `create extension vector` has run — which a migration harness does.
 */
function startupOptions(statementTimeoutMs: number, efSearch: number | undefined): string {
  const options = [`-c statement_timeout=${String(statementTimeoutMs)}`];
  if (efSearch !== undefined) {
    options.push(`-c hnsw.ef_search=${String(efSearch)}`);
  }
  return options.join(' ');
}

/**
 * The TLS options for a pool — D-238.
 *
 * ===========================================================================
 * THIS USED TO BE `{ rejectUnauthorized: false }`, UNCONDITIONALLY.
 *
 * That is TLS with the authentication removed. The connection is encrypted
 * against a passive listener and completely open to an active one, because ANY
 * certificate is accepted — including one an attacker generates. Whoever sits
 * between this process and a managed Postgres reads every row, every session
 * token and the credentials in the connection string, and nothing anywhere
 * reports it: the handshake succeeds, the queries work, and "we use SSL" stays
 * technically true.
 *
 * Verification is on by default now. `DATABASE_SSL_CA` is the correct answer
 * for a provider whose root Node does not already trust;
 * `DATABASE_SSL_INSECURE` restores the old behaviour and is named so that it
 * cannot be read in a deployment manifest without knowing what it costs.
 */
function sslOptions(cfg: DbPoolsConfig): pg.PoolConfig['ssl'] {
  if (!cfg.ssl) return undefined;
  if (cfg.sslInsecure) return { rejectUnauthorized: false };
  return {
    rejectUnauthorized: true,
    ...(cfg.sslCa === null ? {} : { ca: cfg.sslCa }),
  };
}

function createNamedPool(
  name: PoolName,
  cfg: DbPoolsConfig,
  max: number,
  statementTimeoutMs: number,
  efSearch?: number,
): NamedDbHandle {
  const ssl = sslOptions(cfg);
  const pool = new pg.Pool({
    connectionString: cfg.url,
    max,
    connectionTimeoutMillis: cfg.connectTimeoutMs,
    options: startupOptions(statementTimeoutMs, efSearch),
    ...(ssl === undefined ? {} : { ssl }),
  });

  // pg emits `error` on an idle client that the server closed. Without a
  // listener Node treats it as an unhandled error event and kills the process
  // — a database blip becoming a process death, which is exactly the failure
  // this whole file exists to prevent.
  pool.on('error', () => {
    /* the pool discards the client and carries on; the next checkout reconnects */
  });

  const db: Database = drizzle(pool, { schema });

  return {
    name,
    max,
    db,
    pool,
    withTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
      return db.transaction((tx) => fn(tx));
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export function createDbPools(cfg: DbPoolsConfig): DbPools {
  /**
   * THE BUDGET IS APPLIED HERE, ONCE, BEFORE A SINGLE POOL IS BUILT (D-228).
   *
   * Not at the four call sites below — a per-pool clamp is four places for the
   * ceiling to be forgotten, and the one that gets forgotten is the one added
   * next year.
   */
  const sizes = resolvePoolSizes(cfg.sizes, cfg.role, cfg.maxConnections);

  const auth = createNamedPool('auth', cfg, sizes.auth, cfg.statementTimeoutMs);
  const core = createNamedPool('core', cfg, sizes.core, cfg.statementTimeoutMs);
  // The `ai` pool is the one that gets the SHORT statement timeout. Vector
  // search is the expensive, spiky query path (§3.1), so it is capped both in
  // how many connections it may hold and in how long it may hold one.
  //
  // It also gets `hnsw.ef_search`. Putting it here rather than in the retrieval
  // module is the whole point: the setting has to be present on every
  // connection a vector query could run on, and a module-level `SET` is one
  // that some future second query path forgets.
  const ai = createNamedPool(
    'ai',
    cfg,
    sizes.ai,
    cfg.vectorStatementTimeoutMs,
    cfg.hnswEfSearch,
  );
  /**
   * ==========================================================================
   * THE WORKER POOL CARRIES `hnsw.ef_search` TOO, AND IT IS NOT DECORATION.
   *
   * This setting used to be on `ai` alone, described in three separate comments
   * as "the only pool that gets it". That description was true and the
   * conclusion drawn from it was wrong, because `app/routes.ts` builds
   * `retrieval` — the one module that scans the HNSW index — on
   * `pools.worker` whenever `forWorker` is set:
   *
   *     db: forWorker ? container.pools.worker : container.poolFor('retrieval')
   *
   * So in the worker process the vector query ran on a connection where
   * `hnsw.ef_search` had never been set, pgvector fell back to its default of
   * 40, and a `limit 50` returned 40 rows. Not an error, not a log line, not
   * even a wrong answer — just a top-50 that is quietly a top-40, in the one
   * process nobody is watching a latency graph for. The symptom is a corpus
   * that reads as slightly thin in background jobs and normal in the API, which
   * is the hardest possible shape of bug to be handed.
   *
   * The general rule this restores: THE SETTING FOLLOWS THE QUERY, NOT THE
   * POOL'S NAME. `auth` and `core` still do not get it — no vector query can
   * reach them, and `content` reads `rag_chunks` on `core` only by primary key.
   * If a future module runs a vector scan on either, this is the line that has
   * to change with it.
   * ==========================================================================
   */
  const worker = createNamedPool(
    'worker',
    cfg,
    sizes.worker,
    cfg.statementTimeoutMs,
    cfg.hnswEfSearch,
  );

  const pools: readonly NamedDbHandle[] = [auth, core, ai, worker];
  let closed = false;

  return {
    auth,
    core,
    ai,
    worker,
    all(): readonly NamedDbHandle[] {
      return pools;
    },
    stats(): readonly DbPoolStats[] {
      return pools.map((handle) => ({
        name: handle.name,
        max: handle.max,
        total: handle.pool.totalCount,
        idle: handle.pool.idleCount,
        waiting: handle.pool.waitingCount,
      }));
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // `allSettled`: one pool failing to close must not leave the other three
      // open. Shutdown is not the place to be strict about error handling.
      await Promise.allSettled(pools.map((handle) => handle.close()));
    },
  };
}
