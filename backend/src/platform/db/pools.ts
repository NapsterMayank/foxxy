import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index';
import type { Database, DbExecutor, DbHandle } from './client';

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
 * 44 total, comfortably inside a default `max_connections` of 100 with room
 * for administrative access — which matters, because the moment you most need
 * `psql` is the moment the pools are full.
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
  readonly sizes: DbPoolSizes;
  /** §4 — the Postgres statement timeout for ordinary queries. */
  readonly statementTimeoutMs: number;
  /** §4 — the shorter statement timeout applied to the `ai` pool. */
  readonly vectorStatementTimeoutMs: number;
  /** §4 — how long establishing a connection may take. */
  readonly connectTimeoutMs: number;
  /**
   * `hnsw.ef_search` for the `ai` pool — the pool vector search runs on.
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
 * `hnsw.ef_search` is set only on the pool that runs vector search. Postgres
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

function createNamedPool(
  name: PoolName,
  cfg: DbPoolsConfig,
  max: number,
  statementTimeoutMs: number,
  efSearch?: number,
): NamedDbHandle {
  const pool = new pg.Pool({
    connectionString: cfg.url,
    max,
    connectionTimeoutMillis: cfg.connectTimeoutMs,
    options: startupOptions(statementTimeoutMs, efSearch),
    ...(cfg.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
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
  const auth = createNamedPool('auth', cfg, cfg.sizes.auth, cfg.statementTimeoutMs);
  const core = createNamedPool('core', cfg, cfg.sizes.core, cfg.statementTimeoutMs);
  // The `ai` pool is the one that gets the SHORT statement timeout. Vector
  // search is the expensive, spiky query path (§3.1), so it is capped both in
  // how many connections it may hold and in how long it may hold one.
  //
  // It is also the ONLY pool that gets `hnsw.ef_search`. Putting it here rather
  // than in the retrieval module is the whole point: the setting has to be
  // present on every connection a vector query could run on, and a module-level
  // `SET` is one that some future second query path forgets. The other three
  // pools never touch the HNSW index, so the setting would be noise on them.
  const ai = createNamedPool(
    'ai',
    cfg,
    cfg.sizes.ai,
    cfg.vectorStatementTimeoutMs,
    cfg.hnswEfSearch,
  );
  const worker = createNamedPool('worker', cfg, cfg.sizes.worker, cfg.statementTimeoutMs);

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
