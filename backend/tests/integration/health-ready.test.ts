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

  it('reports every check as passing', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.json()).toMatchObject({
      status: 'ready',
      checks: { database: true, migrations: true, config: true },
    });
  });

  it('reports no error', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    const body: { database: { error?: string } } = response.json();
    expect(body.database.error).toBeUndefined();
  });
});

describe('GET /health/deps — against a real migrated database', () => {
  it('reports the database reachable and migrated', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    expect(response.json()).toMatchObject({
      database: { reachable: true, migrationsApplied: true },
    });
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
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        checks: { database: true, migrations: false },
      });
    } finally {
      await postgres.client.query('alter schema drizzle_parked rename to drizzle');
    }

    // And it recovers — the check reflects current state rather than latching.
    const recovered = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(recovered.statusCode).toBe(200);
  }, 60_000);
});
