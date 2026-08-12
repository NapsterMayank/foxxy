import { afterEach, describe, expect, it } from 'vitest';
import { createDbPools, type DbPools, type PoolName } from '../pools';

/**
 * =============================================================================
 * `hnsw.ef_search` AND THE STATEMENT TIMEOUTS, IN THE FAST LANE.
 *
 * WHY THIS FILE EXISTS. `tests/integration/hnsw-ef-search.test.ts` proves the
 * setting WORKS — it runs a real HNSW scan at 40 and at 100 and shows pgvector
 * capping the row count. That test is the important one and this does not
 * replace it. But it needs Docker, so on every machine and every CI lane
 * without a Postgres the question "is the parameter set on the pool retrieval
 * actually runs on?" had no answer at all.
 *
 * And that question had the WRONG answer for as long as it went unasked.
 * `app/routes.ts` builds retrieval on `pools.worker` in the worker process:
 *
 *     db: forWorker ? container.pools.worker : container.poolFor('retrieval')
 *
 * while `hnsw.ef_search` was set on `ai` alone. The worker's vector query ran
 * without it, pgvector applied its default of 40, and `limit 50` returned 40
 * rows — no error, no log line, in the process nobody watches. This asserts the
 * parameter on EVERY pool retrieval can be handed, which is the part a
 * Docker-gated test cannot be relied on to catch.
 *
 * These pools are never connected to. `pg.Pool` establishes nothing until a
 * client is checked out, so constructing one is a pure read of the config that
 * WOULD be sent as Postgres startup options.
 * =============================================================================
 */

/**
 * The pools `buildModules` can give `retrieval` — `ai` in the API process,
 * `worker` in the background one. If that list ever grows, this constant and
 * `app/routes.ts` have to change together.
 */
const POOLS_RETRIEVAL_RUNS_ON: readonly PoolName[] = ['ai', 'worker'];

const EF_SEARCH = 100;

let pools: DbPools | undefined;

function build(): DbPools {
  pools = createDbPools({
    url: 'postgres://user:pw@localhost:5433/never_connected',
    ssl: false,
    // D-238 — verification is on by default now; this URL is plaintext anyway.
    sslCa: null,
    sslInsecure: false,
    // D-228 — the per-process budget. 'api' here because nothing in this
    // file claims a job, and the ceiling is deliberately above the sum so
    // the sizes below are what actually gets opened.
    role: 'api',
    maxConnections: 100,
    sizes: { auth: 10, core: 20, ai: 8, worker: 6 },
    statementTimeoutMs: 30_000,
    vectorStatementTimeoutMs: 5_000,
    connectTimeoutMs: 5_000,
    hnswEfSearch: EF_SEARCH,
  });
  return pools;
}

/** What Postgres would receive as startup options for a pool. */
function startupOptionsOf(handle: { readonly pool: { readonly options: unknown } }): string {
  const { options } = handle.pool;
  if (typeof options !== 'object' || options === null) return '';
  const value = (options as { readonly options?: unknown }).options;
  return typeof value === 'string' ? value : '';
}

afterEach(async () => {
  await pools?.close();
  pools = undefined;
});

describe('hnsw.ef_search is set on every pool retrieval can run on', () => {
  it.each(POOLS_RETRIEVAL_RUNS_ON)('sets it on the %s pool', (name) => {
    /**
     * D-041/D-049. An HNSW index scan returns NO MORE ROWS THAN `ef_search`
     * whatever the LIMIT says, and pgvector's default is 40 while §8.4 asks for
     * the top 50. Missing, the symptom is a top-50 that is quietly a top-40 —
     * which reads as a thin corpus, not as a setting.
     */
    const handle = build()[name];

    expect(startupOptionsOf(handle)).toContain(`hnsw.ef_search=${String(EF_SEARCH)}`);
  });

  it('THE WORKER POOL SPECIFICALLY — the pool the defect was on', () => {
    // Stated separately from the parameterised case above so that deleting the
    // worker from that list cannot silently delete this coverage too.
    expect(startupOptionsOf(build().worker)).toContain('hnsw.ef_search=100');
  });

  it('does NOT set it on auth or core, which no vector query can reach', () => {
    // Not tidiness — the rule being asserted is "the setting follows the
    // QUERY". A setting sprayed everywhere stops documenting anything, and the
    // next person cannot tell which pools were reasoned about.
    const built = build();

    expect(startupOptionsOf(built.auth)).not.toContain('hnsw.ef_search');
    expect(startupOptionsOf(built.core)).not.toContain('hnsw.ef_search');
  });

  it('passes it as a CONNECTION PARAMETER, never as a `SET` the code must remember', () => {
    // D-028. A `SET` can be missed: a connection made during a reconnect storm,
    // or handed out before a setup query ran, would silently have no search
    // breadth — and the connection nobody accounted for is the one that
    // under-retrieves.
    expect(startupOptionsOf(build().ai)).toMatch(/^-c |\s-c /u);
  });
});

describe('the statement timeouts still follow the §3.1 cost profile', () => {
  it('gives the ai pool the SHORT vector timeout', () => {
    // Asserted here because it travels in the same startup-options string as
    // `ef_search`: a change to one is a change to the other's only carrier.
    expect(startupOptionsOf(build().ai)).toContain('statement_timeout=5000');
  });

  it('gives auth, core and worker the ordinary one', () => {
    const built = build();

    for (const handle of [built.auth, built.core, built.worker]) {
      expect(startupOptionsOf(handle)).toContain('statement_timeout=30000');
    }
  });

  it('keeps the worker on the ordinary timeout despite now carrying ef_search', () => {
    // The two settings are independent. Adding search breadth to the worker
    // must not also hand a background job the 5-second vector ceiling, which
    // would start failing digests that were never vector queries.
    expect(startupOptionsOf(build().worker)).not.toContain('statement_timeout=5000');
  });
});
