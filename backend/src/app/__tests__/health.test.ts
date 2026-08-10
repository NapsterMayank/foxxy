import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FixedClock } from '../../platform/clock/index';
import { MemoryCache } from '../../platform/cache/index';
import { parseConfig } from '../../platform/config/load-config';
import { CounterIdGen } from '../../platform/id-gen/index';
import { FakeLogger } from '../../platform/logger/index';
import { RecordingMail } from '../../platform/mail/index';
import { createContainer, type Container } from '../container';
import { createServer } from '../server';

/**
 * 04-RESILIENCE-PLAN.md §11, row "Health checks":
 *
 *   "Take the database down; assert `/health/live` stays 200 and
 *    `/health/ready` returns 503."
 *
 * This is the test that stops a ten-second database blip from becoming a
 * multi-minute outage. If liveness checked the database, every instance would
 * fail it simultaneously, the orchestrator would restart the whole fleet at
 * once, and the database would come back to a stampede of cold processes.
 * Getting these two the wrong way round is one of the most expensive mistakes
 * in this document, and it is invisible until the day it happens.
 *
 * "Database down" here is a port nothing listens on, which fails with
 * ECONNREFUSED deterministically — rather than a plausible-looking port where
 * a developer's own Postgres might be running and answering.
 */

const DEAD_DATABASE = 'postgres://foxxy:pw@127.0.0.1:1/foxxy';

const CONFIG = parseConfig({
  NODE_ENV: 'test',
  DATABASE_URL: DEAD_DATABASE,
  REDIS_URL: 'redis://localhost:6379',
  CORS_READ_ORIGINS: 'http://localhost:3000',
  CORS_WRITE_ORIGINS: 'http://localhost:3000',
  SESSION_COOKIE_NAME: 'foxxy_session',
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:4000',
  // Keep the probe's own patience short: this suite asserts a FAILING probe,
  // and waiting the production 10s for a connection refusal is dead time.
  DATABASE_POOL_AUTH_MAX: '2',
});

let container: Container;
let app: FastifyInstance;
let clock: FixedClock;
let shuttingDown: boolean;

beforeEach(async () => {
  clock = new FixedClock('2026-02-03T04:05:06.000Z');
  shuttingDown = false;
  container = createContainer(CONFIG, {
    clock,
    idGen: new CounterIdGen(),
    logger: new FakeLogger(),
    cache: new MemoryCache(clock),
    mail: new RecordingMail(),
  });
  app = await createServer(container, { isShuttingDown: () => shuttingDown });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await container.shutdown();
});

describe('GET /health/live — with the database DOWN', () => {
  it('stays 200', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
  });

  it('touches nothing external — it answers before any connection could be made', async () => {
    // The config points at a port nothing listens on. A liveness check that
    // consulted the database could not possibly answer 200 here.
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.json()).toEqual({
      status: 'ok',
      env: 'test',
      time: '2026-02-03T04:05:06.000Z',
    });
  });

  it('reads the injected clock rather than the wall clock', async () => {
    clock.advanceSeconds(90);
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.json()).toMatchObject({ time: '2026-02-03T04:06:36.000Z' });
  });

  it('stays 200 during a shutdown — the process is alive, just draining', async () => {
    // Liveness must NOT fail during a drain. Failing it would have the
    // orchestrator kill the process mid-drain, dropping the very requests
    // the drain exists to finish.
    shuttingDown = true;
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
  });
});

describe('GET /health/ready — with the database DOWN', () => {
  it('returns 503', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
  }, 20_000);

  it('says which check failed', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.json()).toMatchObject({
      status: 'not_ready',
      checks: { database: false, migrations: false, config: true },
    });
  }, 20_000);

  it('returns 503 immediately once shutdown has begun, before probing anything', async () => {
    // §12, step 1. The load balancer has to stop routing BEFORE the socket
    // closes, or the requests it sends in between are simply lost.
    shuttingDown = true;
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'shutting_down' });
  });
});

describe('GET /health/deps', () => {
  it('is always 200, even with the database down', async () => {
    // Never used for routing. If it returned a failure status somebody would
    // eventually point a probe at it, and a degraded dependency would start
    // restarting healthy processes.
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    expect(response.statusCode).toBe(200);
  }, 20_000);

  it('reports the database as unreachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    expect(response.json()).toMatchObject({
      database: { reachable: false, migrationsApplied: false },
    });
  }, 20_000);

  it('reports every circuit breaker and its state', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    const body: { breakers: { name: string; state: string }[] } = response.json();
    expect(body.breakers.map((breaker) => breaker.name)).toEqual([
      'cache',
      'http',
      'llm',
      'embed',
      'mail',
      'payments',
    ]);
    expect(body.breakers.every((breaker) => breaker.state === 'closed')).toBe(true);
  }, 20_000);

  it('reports the process metrics snapshot — §5, the other half', async () => {
    // The breaker block says what state each dependency is in RIGHT NOW. This
    // says what has been HAPPENING: how many times a breaker tripped, how many
    // calls were refused without a network attempt, how many rate-limit
    // fallbacks fired.
    //
    // A breaker that is closed at the moment you look, having opened eleven
    // times in the last hour, is indistinguishable from a healthy one without
    // these counters. That is exactly the "silent outage" §5 names.
    container.metrics.counter('test.health.deps', 2, { port: 'cache' });

    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    const body: { metrics: { name: string; value: number; tags: Record<string, string> }[] } =
      response.json();

    const emitted = body.metrics.find((metric) => metric.name === 'test.health.deps');
    expect(emitted?.value).toBe(2);
    expect(emitted?.tags).toEqual({ port: 'cache' });
  }, 20_000);

  it('reads those metrics from MEMORY, with the database down', async () => {
    // The whole reason `/health/deps` reports the in-process snapshot rather
    // than querying `metrics_events`: the most common breakage is the database,
    // and an endpoint that needed a query to tell you the database is
    // unreachable would be unavailable exactly when it is needed.
    //
    // This suite runs against a dead database throughout, so reaching this
    // assertion at all is the proof.
    container.metrics.counter('test.health.offline');
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    const body: { metrics: { name: string }[] } = response.json();
    expect(body.metrics.map((metric) => metric.name)).toContain('test.health.offline');
  }, 20_000);

  it('reports each connection pool separately — the §3.1 bulkheads', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    const body: { database: { pools: { name: string; max: number }[] } } = response.json();
    expect(body.database.pools.map((pool) => `${pool.name}:${String(pool.max)}`)).toEqual([
      'auth:2',
      'core:20',
      'ai:8',
      'worker:6',
    ]);
  }, 20_000);

  it('never leaks the connection string, which carries the password', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    expect(response.body).not.toContain('pw@');
    expect(response.body).not.toContain('foxxy:pw');
  }, 20_000);
});

describe('GET /health — the deprecated alias', () => {
  it('still answers 200 so nothing pointed at it breaks', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });

  it('aliases LIVENESS, not readiness — it must not consult the database', async () => {
    // Silently upgrading an existing `/health` probe to one that touches the
    // database would introduce the exact trap §8 warns about, in a change
    // whose stated purpose is to prevent it.
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const alias = await app.inject({ method: 'GET', url: '/health' });
    expect(alias.json()).toEqual(live.json());
  });
});
