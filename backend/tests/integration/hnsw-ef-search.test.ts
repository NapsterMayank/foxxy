import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbPools, type DbPools } from '../../src/platform/db/index';
import { parseConfig } from '../../src/platform/config/load-config';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../helpers/postgres';
import { insertRagChunk, makeEmbedding, makeRagChunk, toVectorLiteral } from '../fixtures/index';

/**
 * `hnsw.ef_search` on the `ai` pool — D-041, closed by D-049.
 *
 * THE MEASUREMENT THIS PINS, restated because it is genuinely surprising: an
 * HNSW index scan returns NO MORE ROWS THAN `ef_search`, whatever the LIMIT
 * says. pgvector's default is 40. Plan §8.4 step 3 asks retrieval for the top
 * 50. So with the default, `limit 50` returns 40 rows — no error, no warning,
 * no truncation notice.
 *
 * The reason that matters more than the arithmetic: the symptom is a thin
 * result set, and a thin result set from a corpus that has just been imported
 * reads as "we do not have this content". The response to that misreading is
 * to go and ingest content that is already there — days of work, and possibly
 * money, spent on a setting.
 *
 * Two tests below, and BOTH are needed. The first asserts the top-50 query
 * genuinely returns 50 on the pool retrieval will use. The second drives the
 * same query at `ef_search = 40` and asserts it returns 40 — because a test
 * that only proves the good case cannot tell you whether it is passing due to
 * the setting or in spite of it. If pgvector's behaviour changed and the cap
 * disappeared, the first test would keep passing and would have stopped
 * measuring anything.
 */

const CHUNK_COUNT = 200;
const TOP_N = 50;
const PGVECTOR_DEFAULT_EF_SEARCH = 40;

let postgres: TestPostgres;
let pools: DbPools;
let queryVector: string;

/**
 * The query retrieval will issue: nearest neighbours by cosine distance, no
 * filter, `limit 50`.
 *
 * `enable_seqscan = off` forces the HNSW plan. At seed scale the planner
 * frequently prefers an exact sort — which is faster AND perfectly accurate,
 * and would therefore return 50 rows regardless of `ef_search`, quietly
 * turning both tests below into tests of nothing. The production corpus is
 * ~16,000 rows and will use the index; forcing it here is how a small-corpus
 * test says something about a large-corpus code path.
 */
async function topNIds(handle: DbPools['ai'], efSearch?: number): Promise<string[]> {
  const client = await handle.pool.connect();
  try {
    // An EXPLICIT transaction, because `SET LOCAL` outside one is a no-op that
    // only emits a warning. The first draft of this file omitted the BEGIN and
    // the override below silently did nothing — the control test returned 50
    // and looked like pgvector had stopped capping at `ef_search`. Worth
    // recording: a settings override that quietly fails to apply is the same
    // class of bug as the one this whole file exists to prevent.
    await client.query('begin');
    await client.query('set local enable_seqscan = off');
    if (efSearch !== undefined) {
      await client.query(`set local hnsw.ef_search = ${String(efSearch)}`);
    }
    const result = await client.query<{ id: string }>(
      `select id from rag_chunks order by embedding <=> $1::vector limit ${String(TOP_N)}`,
      [queryVector],
    );
    await client.query('commit');
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await applyAllMigrations(postgres.client);

  // Comfortably more chunks than the top-50 ask, so a short result can only
  // come from the index and never from the corpus running out.
  for (let index = 0; index < CHUNK_COUNT; index += 1) {
    await insertRagChunk(
      postgres.client,
      makeRagChunk(`ef-${String(index)}`, { chunkIndex: index }),
    );
  }
  queryVector = toVectorLiteral(makeEmbedding('ef-query'));

  const config = parseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: postgres.url,
    REDIS_URL: 'redis://localhost:6379',
    CORS_READ_ORIGINS: 'http://localhost:3000',
    CORS_WRITE_ORIGINS: 'http://localhost:3000',
    SESSION_COOKIE_NAME: 'foxxy_session',
    APP_URL: 'http://app.test',
    API_URL: 'http://api.test',
  });

  pools = createDbPools({
    url: config.db.url,
    ssl: false,
    // D-238 — verification is on by default now; this URL is plaintext anyway.
    sslCa: null,
    sslInsecure: false,
    // D-228 — the per-process budget. 'api' here because nothing in this
    // file claims a job, and the ceiling is deliberately above the sum so
    // the sizes below are what actually gets opened.
    role: 'api',
    maxConnections: 100,
    sizes: { auth: 2, core: 2, ai: 2, worker: 2 },
    statementTimeoutMs: 10_000,
    vectorStatementTimeoutMs: 10_000,
    connectTimeoutMs: 2_000,
    // FROM CONFIG, not a literal. The value under test is the one a deployment
    // would actually get; hardcoding 100 here would test the number rather
    // than the wiring, and the wiring is the part that was missing.
    hnswEfSearch: config.db.hnswEfSearch,
  });
}, 180_000);

afterAll(async () => {
  await pools.close();
  await postgres.stop();
}, 60_000);

describe('the ai pool carries hnsw.ef_search from config', () => {
  it('defaults to 100 — above the top-50 retrieval asks for', () => {
    const config = parseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://x/y',
      REDIS_URL: 'redis://localhost:6379',
      CORS_READ_ORIGINS: 'http://localhost:3000',
    CORS_WRITE_ORIGINS: 'http://localhost:3000',
      SESSION_COOKIE_NAME: 'foxxy_session',
      APP_URL: 'http://app.test',
      API_URL: 'http://api.test',
    });
    expect(config.db.hnswEfSearch).toBe(100);
    expect(config.db.hnswEfSearch).toBeGreaterThanOrEqual(TOP_N);
  });

  it('applies it to every ai connection as a startup parameter', async () => {
    // A startup parameter rather than a `SET`, for the same reason as the
    // statement timeout (D-028): a `SET` can be missed on a connection created
    // during a reconnect storm, and the connection nobody accounted for is
    // exactly the one that silently under-retrieves.
    const result = await pools.ai.pool.query<{ ef: string }>(`select current_setting('hnsw.ef_search') as ef`);
    expect(result.rows[0]?.ef).toBe('100');
  });

  it('does NOT set it on the core pool, which never touches the index', async () => {
    const client = await pools.core.pool.connect();
    try {
      // pgvector's C module — and with it the `hnsw.*` settings — loads lazily
      // on first use of a vector type, so a fresh backend does not recognise
      // the parameter at all. Touching a vector first makes this assert the
      // VALUE rather than an incidental "unrecognized parameter" error, which
      // would pass for the wrong reason.
      await client.query(`select '[1,2,3]'::vector`);
      const result = await client.query<{ ef: string }>(`select current_setting('hnsw.ef_search') as ef`);
      expect(result.rows[0]?.ef).toBe(String(PGVECTOR_DEFAULT_EF_SEARCH));
    } finally {
      client.release();
    }
  });
});

describe('a top-50 vector query returns 50 rows', () => {
  it('returns exactly 50 over the seeded chunks, on the ai pool', async () => {
    const ids = await topNIds(pools.ai);
    expect(ids).toHaveLength(TOP_N);
    // Distinct, so 50 is 50 real neighbours and not a repeated row.
    expect(new Set(ids).size).toBe(TOP_N);
  });

  it('returns only 40 at pgvector’s default — the measurement, still true', async () => {
    // The control. Without this, the test above could pass because pgvector
    // stopped capping at `ef_search` and would have quietly stopped measuring
    // anything. If THIS test ever fails, the cap is gone and the setting can
    // be reconsidered — deliberately, rather than by nobody noticing.
    const ids = await topNIds(pools.ai, PGVECTOR_DEFAULT_EF_SEARCH);
    expect(ids).toHaveLength(PGVECTOR_DEFAULT_EF_SEARCH);
  });
});
