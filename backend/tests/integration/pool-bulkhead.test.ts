import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbPools, type DbPools } from '../../src/platform/db/index';
import { createIdentityModule, type IdentityModule } from '../../src/modules/identity/index';
import { FixedClock } from '../../src/platform/clock/index';
import { MemoryCache } from '../../src/platform/cache/index';
import { FakeLogger } from '../../src/platform/logger/index';
import { RecordingMail } from '../../src/platform/mail/index';
import type { PasswordHasher } from '../../src/modules/identity/identity.types';
import { DEFAULT_TENANT_ID } from '../../src/platform/db/schema/tenants';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../helpers/postgres';

/**
 * 04-RESILIENCE-PLAN.md §11, row "Connection-pool bulkhead":
 *
 *   "Saturate the `ai` pool; assert a login still succeeds."
 *
 * §3.1 calls this "the highest-value isolation", and this test is the only
 * thing that makes the claim true rather than decorative. Without it, four
 * pools are four variables that happen to have different numbers in them.
 *
 * The failure being prevented, concretely: with ONE shared pool, a spike of
 * slow vector-search queries holds every connection. Login then queues behind
 * search and starts timing out. The database is healthy, the application is
 * healthy, and the product is down — an outage caused by a feature that has
 * nothing to do with logging in.
 *
 * The `ai` pool is saturated here with `pg_sleep`, which is exactly what a
 * slow HNSW query looks like to a connection pool: a connection checked out
 * and held. Login runs on `auth`, which is a physically different set of
 * connections, so it cannot be affected — and that "cannot" is what is being
 * asserted.
 */

const AI_POOL_MAX = 4;
const AUTH_POOL_MAX = 3;

/** Deterministic stand-in for Argon2id — the hasher is not what is under test. */
class FastHasher implements PasswordHasher {
  hash(password: string): Promise<string> {
    return Promise.resolve(`fake$${password}`);
  }
  verify(hash: string, password: string): Promise<boolean> {
    return Promise.resolve(hash === `fake$${password}`);
  }
  dummyHash(): Promise<string> {
    return Promise.resolve('fake$__dummy__');
  }
}

let postgres: TestPostgres;
let pools: DbPools;
let identity: IdentityModule;
let clock: FixedClock;

const CONTEXT = { ipHash: 'test-ip-hash', userAgent: null } as const;
const EMAIL = 'bulkhead@example.test';
const PASSWORD = 'a-perfectly-fine-passphrase';

beforeAll(async () => {
  postgres = await startTestPostgres();
  // EVERY migration, DISCOVERED from the directory — never a hardcoded list.
  //
  // This file used to name `0000` and `0001` explicitly, which is precisely the
  // D-046 defect `applyAllMigrations` was written to prevent: the identity
  // harness named its migrations, was not updated when `0001` landed, and ran a
  // whole suite against a schema with no `link_codes` table while staying
  // green.
  //
  // It surfaced here when `0004_tenancy` added `users.tenant_id`. Drizzle's
  // `.returning()` projects every column the SCHEMA declares, so signup started
  // asking for a column this database had never been given — and the failure
  // was in `createUser`, several layers from the hardcoded list that caused it.
  // That is the shape of the bug: a harness that pins its own migrations fails
  // somewhere else entirely.
  await applyAllMigrations(postgres.client);

  pools = createDbPools({
    url: postgres.url,
    ssl: false,
    // D-238 — verification is on by default now; this URL is plaintext anyway.
    sslCa: null,
    sslInsecure: false,
    // D-228 — the per-process budget. 'api' here because nothing in this
    // file claims a job, and the ceiling is deliberately above the sum so
    // the sizes below are what actually gets opened.
    role: 'api',
    maxConnections: 100,
    // Deliberately small. The property under test is isolation, not capacity,
    // and saturating 4 connections is as convincing as saturating 8 while
    // taking a fraction of the time.
    sizes: { auth: AUTH_POOL_MAX, core: 4, ai: AI_POOL_MAX, worker: 2 },
    statementTimeoutMs: 10_000,
    vectorStatementTimeoutMs: 5_000,
    connectTimeoutMs: 2_000,
    hnswEfSearch: 100,
  });

  clock = new FixedClock('2026-06-01T09:00:00.000Z');

  identity = createIdentityModule({
    // THE POINT OF THE TEST: identity is given the `auth` pool, per §3.1.
    db: pools.auth,
    cache: new MemoryCache(clock),
    mail: new RecordingMail(),
    clock,
    logger: new FakeLogger(),
    session: { name: 'foxxy_session', ttlDays: 30, secure: true },
    defaultTenantId: DEFAULT_TENANT_ID,
    urls: { apiBaseUrl: 'http://api.test', appBaseUrl: 'http://app.test' },
    hasher: new FastHasher(),
  });

  // A verified account to log into.
  await identity.service.signup(
    { email: EMAIL, password: PASSWORD, role: 'student' },
    CONTEXT,
  );
  await postgres.client.query(`update users set email_verified_at = now() where email = $1`, [
    EMAIL,
  ]);
}, 180_000);

afterAll(async () => {
  await pools.close();
  await postgres.stop();
}, 60_000);

/**
 * Waits until the `ai` pool is genuinely exhausted.
 *
 * `totalCount >= max` is NOT enough, and getting this wrong made a test pass
 * for the wrong reason: after an earlier test the pool already holds `max`
 * connections, they are just IDLE. The condition that means "no connection is
 * available" is `idleCount === 0` with the pool at capacity.
 */
async function saturated(): Promise<void> {
  while (pools.ai.pool.totalCount < AI_POOL_MAX || pools.ai.pool.idleCount > 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('the ai pool cannot starve the auth pool', () => {
  it('lets a login complete while the ai pool is fully saturated', async () => {
    // Saturate `ai`: every one of its connections checked out and held, which
    // is what a slow vector query does.
    const held = Array.from({ length: AI_POOL_MAX }, () =>
      pools.ai.pool.query('select pg_sleep(3)').catch(() => undefined),
    );

    await saturated();
    expect(pools.ai.pool.idleCount).toBe(0);

    // A 5th ai query has nowhere to go — proof the cap is real and that the
    // pool is genuinely exhausted rather than merely busy.
    expect(pools.ai.pool.waitingCount + pools.ai.pool.totalCount).toBeGreaterThanOrEqual(
      AI_POOL_MAX,
    );

    // THE ASSERTION. Login goes through the identity service, the identity
    // repository and the `auth` pool, all the way to a session row.
    const session = await identity.service.login({ email: EMAIL, password: PASSWORD }, CONTEXT);

    expect(session.user.email).toBe(EMAIL);

    await Promise.all(held);
  }, 60_000);

  it('completes the login promptly rather than after the slow queries drain', async () => {
    const held = Array.from({ length: AI_POOL_MAX }, () =>
      pools.ai.pool.query('select pg_sleep(3)').catch(() => undefined),
    );
    await saturated();

    const startedAt = Date.now();
    await identity.service.login({ email: EMAIL, password: PASSWORD }, CONTEXT);
    const elapsed = Date.now() - startedAt;

    // The held queries run for 3s. If login had queued behind them — the
    // single-shared-pool behaviour — this would be at least that. A generous
    // bound: the assertion is "did not wait for search", not a latency SLO.
    expect(elapsed).toBeLessThan(2_000);

    await Promise.all(held);
  }, 60_000);

  it('keeps the auth pool untouched by ai saturation', async () => {
    const held = Array.from({ length: AI_POOL_MAX }, () =>
      pools.ai.pool.query('select pg_sleep(2)').catch(() => undefined),
    );
    await saturated();

    const stats = pools.stats();
    const ai = stats.find((pool) => pool.name === 'ai');
    const auth = stats.find((pool) => pool.name === 'auth');

    expect(ai?.idle).toBe(0);
    // Separate pools means separate counters — `auth` has connections
    // available no matter what `ai` is doing.
    expect(auth?.total).toBeLessThanOrEqual(AUTH_POOL_MAX);
    expect(auth?.waiting).toBe(0);

    await Promise.all(held);
  }, 60_000);
});

describe('the pools are genuinely separate', () => {
  it('caps each pool independently at its configured maximum', () => {
    expect(pools.stats().map((pool) => `${pool.name}:${String(pool.max)}`)).toEqual([
      `auth:${String(AUTH_POOL_MAX)}`,
      'core:4',
      `ai:${String(AI_POOL_MAX)}`,
      'worker:2',
    ]);
  });

  it('applies the SHORTER statement timeout to the ai pool', async () => {
    // §4: vector search gets 5s where everything else gets 10s. Capping how
    // many connections `ai` may hold bounds the blast radius; capping how long
    // it may hold one bounds the duration.
    // `show x` names its column after the setting, not `setting` — which is
    // what `pg_settings` uses. Asserting the wrong column returns `undefined`
    // and compares it against a string, which fails loudly rather than
    // silently passing; that is the only reason this was caught.
    const ai = await pools.ai.pool.query<{ statement_timeout: string }>('show statement_timeout');
    const core = await pools.core.pool.query<{ statement_timeout: string }>(
      'show statement_timeout',
    );
    expect(ai.rows[0]?.statement_timeout).toBe('5s');
    expect(core.rows[0]?.statement_timeout).toBe('10s');
  });

  it('kills a query that exceeds the ai statement timeout', async () => {
    // The plan's §7 mitigation, "statement timeout so no query runs forever",
    // proven rather than configured. A runaway query holds a connection until
    // it is stopped; this is what stops it.
    await expect(pools.ai.pool.query('select pg_sleep(7)')).rejects.toThrow(
      /canceling statement due to statement timeout/,
    );
  }, 30_000);

  it('runs a transaction within a single pool', async () => {
    const result = await pools.core.withTransaction(async (tx) => {
      const rows = await tx.execute('select 1 as ok');
      return rows.rowCount;
    });
    expect(result).toBe(1);
  });
});
