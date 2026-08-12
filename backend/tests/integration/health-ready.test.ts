import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type DbHandle } from '../../src/platform/db/index';
import { MemoryCache } from '../../src/platform/cache/index';
import { FixedClock } from '../../src/platform/clock/index';
import { parseConfig } from '../../src/platform/config/load-config';
import { CounterIdGen } from '../../src/platform/id-gen/index';
import { FakeLogger } from '../../src/platform/logger/index';
import { RecordingMail } from '../../src/platform/mail/index';
import { createContainer, type Container } from '../../src/app/container';
import { createServer } from '../../src/app/server';
import { startTestPostgres, type TestPostgres } from '../helpers/postgres';

/**
 * The other half of the §11 health-check row.
 *
 * `src/app/__tests__/health.test.ts` proves readiness fails with the database
 * down. This proves it SUCCEEDS with a real, migrated database — because a
 * readiness check that always answers 503 also satisfies "503 when the
 * database is down", and would take the service permanently out of rotation.
 * Both directions, or the assertion is worthless.
 *
 * Migrations are applied through the real migrator rather than by replaying
 * SQL, because the readiness check asks whether `drizzle.__drizzle_migrations`
 * has rows — and that bookkeeping table only exists when the migrator wrote it.
 * That is deliberate: it is what distinguishes "schema present" from "schema
 * managed", and rolling a deploy in front of an unmigrated database is exactly
 * the failure it prevents.
 */

let postgres: TestPostgres;
let migrator: DbHandle;
let container: Container;
let app: FastifyInstance;

beforeAll(async () => {
  postgres = await startTestPostgres();

  migrator = createDb({ url: postgres.url, poolMax: 2, ssl: false });
  await migrate(migrator.db, { migrationsFolder: './drizzle/migrations' });

  const clock = new FixedClock('2026-02-03T04:05:06.000Z');
  container = createContainer(
    parseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: postgres.url,
      REDIS_URL: 'redis://localhost:6379',
      CORS_READ_ORIGINS: 'http://localhost:3000',
    CORS_WRITE_ORIGINS: 'http://localhost:3000',
      SESSION_COOKIE_NAME: 'foxxy_session',
      APP_URL: 'http://localhost:3000',
      API_URL: 'http://localhost:4000',
    }),
    {
      clock,
      idGen: new CounterIdGen(),
      logger: new FakeLogger(),
      cache: new MemoryCache(clock),
      mail: new RecordingMail(),
    },
  );

  app = await createServer(container);
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app.close();
  await container.shutdown();
  await migrator.close();
  await postgres.stop();
}, 60_000);

describe('GET /health/ready — against a real migrated database', () => {
  it('returns 200', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
  });

  /**
   * D-229 — THE BODY IS A STATUS AND NOTHING ELSE, and that is the assertion.
   *
   * This used to read `toMatchObject({ status, checks: { database, migrations,
   * config } })` and it is stale by DESIGN, not by accident: the `checks` map
   * and its sibling `database` object were REMOVED because they rendered the
   * raw pg error — carrying the host, the port and the database username — to
   * any unauthenticated caller the moment the database went down. Restoring
   * either of them to make this file green would re-open the leak the fix
   * closed, so the assertion is inverted instead: the shape is now pinned as
   * EXACTLY `{ status }`, which makes a future re-widening a failing test
   * rather than a silent regression.
   *
   * The three detail legs moved to the `/health/deps` block below, which is the
   * endpoint that exists for that question — with ONE exception, recorded
   * honestly rather than faked:
   *
   *   `checks.config` HAS NO HOME ON `/health/deps` and has not been recreated.
   *   It was vacuous where it stood: config is parsed by `parseConfig` at boot
   *   and a process whose config did not parse never binds a socket, so nothing
   *   can reach this route to be told `config: false`. It could only ever
   *   report `true`. `/health/deps` reports live dependency state, and config is
   *   not a live dependency; the boot gates in `createContainer` are what
   *   assert it, at the only time the answer can be anything but `true`.
   */
  it('returns a status and NOTHING else — no checks map, no vendor detail', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('leaks no host, port or database username on the ready path', async () => {
    // The concrete property behind D-229, asserted against the connection
    // string this very test is using rather than against a pattern.
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    const body = response.body;
    const { hostname, port, username } = new URL(postgres.url);
    expect(body).not.toContain(hostname);
    expect(body).not.toContain(port);
    expect(body).not.toContain(username);
    expect(body).not.toMatch(/error|password|ECONNREFUSED/i);
  });
});

describe('GET /health/deps — against a real migrated database', () => {
  it('reports the database reachable and migrated', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    expect(response.json()).toMatchObject({
      database: { reachable: true, migrationsApplied: true },
    });
  });

  /**
   * `checks.database` / `checks.migrations` from the old `/health/ready` body,
   * rehomed. Same two facts, on the endpoint whose job it is to carry them.
   */
  it('carries the per-dependency detail that readiness deliberately dropped', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    expect(response.json()).toMatchObject({
      database: { reachable: true, migrationsApplied: true, failure: null },
      cache: { reachable: true, failure: null },
    });
  });

  /**
   * The old `reports no error` case. `failure` replaced the free-text `error`
   * string and is a CLOSED UNION — 'unreachable' | 'timeout' |
   * 'schema_incomplete' — which is why it cannot grow a hostname: it is not a
   * string field. This asserts both halves: healthy is `null`, and the field
   * is incapable of carrying vendor text.
   */
  it('names WHICH dependency is unhealthy, never WHY in vendor terms', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    const body: {
      database: { failure: string | null; error?: string };
      cache: { failure: string | null; error?: string };
    } = response.json();

    expect(body.database.failure).toBeNull();
    expect(body.cache.failure).toBeNull();
    // The free-text field is gone from both, not merely empty.
    expect(body.database).not.toHaveProperty('error');
    expect(body.cache).not.toHaveProperty('error');

    const { hostname, username } = new URL(postgres.url);
    expect(response.body).not.toContain(hostname);
    expect(response.body).not.toContain(username);
  });

  it('reports live counts for all four pools', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    const body: { database: { pools: { name: string; max: number; total: number }[] } } =
      response.json();
    expect(body.database.pools.map((pool) => pool.name)).toEqual([
      'auth',
      'core',
      'ai',
      'worker',
    ]);
    // The probe runs on `core`, deliberately — probing through `auth` would
    // let a health checker consume the one pool that must never be starved.
    expect(body.database.pools.find((pool) => pool.name === 'core')?.total).toBeGreaterThan(0);
    expect(body.database.pools.find((pool) => pool.name === 'auth')?.total).toBe(0);
  });
});

describe('the migration bookkeeping is what readiness actually checks', () => {
  it('turns readiness 503 when the migration history is wiped', async () => {
    // A database that is reachable but unmigrated is completely unable to
    // serve a request. Proving readiness NOTICES is the whole point of
    // checking migrations rather than only connectivity.
    //
    // The history is RENAMED rather than dropped, so the test leaves the
    // database exactly as it found it. Dropping it is not reversible: re-
    // running the migrator against tables that still exist fails on the first
    // `CREATE TABLE`, which would leave every later test in this file running
    // against an unmigrated-looking database.
    await postgres.client.query('alter schema drizzle rename to drizzle_parked');
    try {
      // READINESS: the status code and the coarse status word. That is the
      // whole contract — a load balancer reads the code and nothing else, and
      // D-229 removed the body detail because the body reached anyone who
      // could open a socket, at exactly the moment it had most to give away.
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: 'not_ready' });

      // DEPS: the same distinction the old `checks: { database: true,
      // migrations: false }` drew, rehomed — and strictly sharper, because it
      // also pins WHICH classification the probe chose. `database: true,
      // migrations: false` and `schema_incomplete` say the same thing; only
      // the latter separates "unmigrated" from "unreachable" and "timeout",
      // which are three different runbook pages.
      const deps = await app.inject({ method: 'GET', url: '/health/deps' });
      expect(deps.statusCode).toBe(200);
      expect(deps.json()).toMatchObject({
        database: {
          reachable: true,
          migrationsApplied: false,
          failure: 'schema_incomplete',
        },
      });
    } finally {
      await postgres.client.query('alter schema drizzle_parked rename to drizzle');
    }

    // And it recovers — the check reflects current state rather than latching.
    const recovered = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(recovered.statusCode).toBe(200);
  }, 60_000);
});
