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

  /**
   * D-229 — A STATUS AND NOTHING ELSE.
   *
   * This test used to assert the OPPOSITE: that the body carried a `checks` map
   * naming what failed. It also carried a `database` object with the raw pg
   * error string in it, and a node-postgres connection failure reads
   * `connect ECONNREFUSED 10.0.3.14:5432` or
   * `password authentication failed for user "foxxy_app"`. Host, port, username
   * and the application's own private address, to anything that can open a
   * socket, at the exact moment the database is down.
   *
   * Readiness is consumed by a load balancer, which reads the STATUS CODE. The
   * body was for humans, and the humans it reached were not only ours.
   */
  it('returns a status and NOTHING else — no checks map, no vendor detail', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.json()).toEqual({ status: 'not_ready' });
  }, 20_000);

  it('leaks no host, port or username with the database down', async () => {
    // The named mutation for D-229. Re-render `cause.message` into this body
    // and this assertion is what goes red.
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.body).not.toContain('127.0.0.1');
    expect(response.body).not.toContain('foxxy');
    expect(response.body).not.toContain('ECONNREFUSED');
    expect(response.body).not.toMatch(/:\d{2,5}\b/u);
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
      // D-228 — SIX WAS THE OLD ANSWER, and six in this process plus six in the
      // worker is how 44 became 88 of a default `max_connections=100`. An api
      // process only ever ENQUEUES onto the worker pool (one indexed INSERT,
      // plus the metrics sink), so the role profile caps it at two. Restore the
      // role cap to `null` and this line goes red.
      'worker:2',
    ]);
  }, 20_000);

  it('never leaks the connection string, which carries the password', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    expect(response.body).not.toContain('pw@');
    expect(response.body).not.toContain('foxxy:pw');
  }, 20_000);

  /**
   * D-229 — `/health/deps` may name WHICH dependency is unhealthy, never WHY in
   * vendor terms.
   *
   * `db/health.ts` carried a comment at the old line 107 acknowledging exactly
   * this risk, beside code that did not act on it. The failure is now a closed
   * union — 'unreachable' | 'timeout' | 'schema_incomplete' — which cannot grow
   * a hostname because it is not a string.
   */
  it('classifies the failure without a vendor message', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    const body: { database: { failure: string | null } } = response.json();

    expect(body.database.failure).toBe('unreachable');
    expect(response.body).not.toContain('ECONNREFUSED');
    expect(response.body).not.toContain('127.0.0.1');
    expect(response.body).not.toContain('5432');
  }, 20_000);

  it('reports the cache alongside the database — D-230', async () => {
    // Readiness probed the database and nothing else, so a replica with no
    // Valkey stayed in rotation serving logins on the in-process rate-limit
    // fallback. `/health/deps` has to be able to show which half is broken.
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    const body: { cache: { reachable: boolean; failure: string | null } } = response.json();

    expect(body.cache.reachable).toBe(true);
    expect(body.cache.failure).toBeNull();
  }, 20_000);
});

/**
 * =============================================================================
 * D-230 — READINESS COVERS THE CACHE.
 *
 * The database is UP for this block (a probe that always fails would make a
 * cache regression invisible), and the cache is what breaks. If the cache check
 * is deleted from `/health/ready`, this whole block goes red and nothing else
 * does.
 *
 * The database being "up" is faked at the container's edge rather than with a
 * container: what is under test is the readiness EXPRESSION, not SQL.
 * =============================================================================
 */
describe('GET /health/ready — with the CACHE down', () => {
  /** A cache whose every read fails, the way a lost Valkey connection does. */
  class UnreachableCache extends MemoryCache {
    override get(): Promise<string | null> {
      return Promise.reject(new Error('connect ECONNREFUSED 10.0.3.14:6379'));
    }
  }

  let cacheApp: FastifyInstance;
  let cacheContainer: Container;

  beforeEach(async () => {
    cacheContainer = createContainer(CONFIG, {
      clock,
      idGen: new CounterIdGen(),
      logger: new FakeLogger(),
      cache: new UnreachableCache(clock),
      mail: new RecordingMail(),
    });
    cacheApp = await createServer(
      {
        ...cacheContainer,
        // The database half reports healthy, so only the cache can fail this.
        databaseProbe: {
          manifest: cacheContainer.databaseProbe.manifest,
          check: () =>
            Promise.resolve({
              reachable: true,
              migrationsApplied: true,
              latencyMs: 1,
              failure: null,
              pools: [],
            }),
        },
      },
      { isShuttingDown: () => false },
    );
    await cacheApp.ready();
  });

  afterEach(async () => {
    await cacheApp.close();
    await cacheContainer.shutdown();
  });

  it('returns 503 — a replica that cannot rate-limit must leave the rotation', async () => {
    const response = await cacheApp.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
  });

  it('still says only `not_ready`, with no vendor detail about the cache either', async () => {
    // An ioredis error carries the host and port just as a pg error does.
    const response = await cacheApp.inject({ method: 'GET', url: '/health/ready' });

    expect(response.json()).toEqual({ status: 'not_ready' });
    expect(response.body).not.toContain('10.0.3.14');
    expect(response.body).not.toContain('6379');
  });

  it('names the cache as the unhealthy dependency on /health/deps', async () => {
    const response = await cacheApp.inject({ method: 'GET', url: '/health/deps' });
    const body: {
      cache: { reachable: boolean; failure: string | null };
      database: { reachable: boolean };
    } = response.json();

    // WHICH, never WHY: an operator can route to the right runbook page from
    // this and cannot learn an address from it.
    expect(body.cache).toMatchObject({ reachable: false, failure: 'unreachable' });
    expect(body.database.reachable).toBe(true);
  });
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
