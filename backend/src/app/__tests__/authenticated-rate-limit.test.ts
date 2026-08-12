import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MemoryCache, type CachePort } from '../../platform/cache/index';
import { FixedClock } from '../../platform/clock/index';
import { parseConfig } from '../../platform/config/load-config';
import { CounterIdGen } from '../../platform/id-gen/index';
import { FakeLogger } from '../../platform/logger/index';
import { RecordingMail } from '../../platform/mail/index';
import { AUTHENTICATED_RATE_LIMIT } from '../../shared/constants/rate-limits';
import { createContainer, type Container } from '../container';
import { GLOBAL_RATE_LIMIT_KEY_PREFIX } from '../plugins/authenticated-rate-limit';
import { createServer } from '../server';

/**
 * THE GLOBAL AUTHENTICATED RATE LIMIT — plan §6.9, last row.
 *
 * ===========================================================================
 * IT WAS DECLARED FOR TWO BUILD CYCLES AND ENFORCED NOWHERE.
 *
 * `AUTHENTICATED_RATE_LIMIT` sat in `shared/constants/rate-limits.ts` from the
 * moment the identity module landed, deferred on "a second module having
 * routes". There are three now, and until it was wired, `/me/*` and
 * `/content/*` were entirely unthrottled for any caller holding a session —
 * every per-endpoint limit in the product sits on an UNAUTHENTICATED auth route.
 *
 * ===========================================================================
 * WHAT THESE TESTS ARE GUARDING AGAINST, SPECIFICALLY.
 *
 * The interesting failure is not "the limit is wrong". It is "the limit is
 * installed and counts nothing", which is what happens if the hook runs before
 * session validation: `request.actor` is undefined on every request, the hook
 * returns immediately, and a limiter that appears wired enforces zero. Nothing
 * goes red, because a rate limiter's normal state is to do nothing.
 *
 * So every test here drives a route with a real preHandler in front of it and
 * asserts on a 429 that actually arrives.
 *
 * The actor is attached by a stand-in preHandler rather than by a real login.
 * That is deliberate: it lets one file cover the per-user separation and the
 * cache-outage fallback without a database, and the REAL wiring — the hook
 * running after identity's `requireSession` on a real module route — is covered
 * against a real session in `identity.routes.test.ts`.
 */

const CONFIG = parseConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://foxxy:pw@localhost:5432/foxxy',
  REDIS_URL: 'redis://localhost:6379',
  CORS_READ_ORIGINS: 'http://localhost:3000',
  CORS_WRITE_ORIGINS: 'http://localhost:3000',
  SESSION_COOKIE_NAME: 'foxxy_session',
  APP_URL: 'http://localhost:3000',
  API_URL: 'https://api.foxxy.test',
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER_A = 'user-a';
const USER_B = 'user-b';

/** A cache that is completely unreachable. See the fallback test at the end. */
class DeadCache implements CachePort {
  get(): Promise<string | null> {
    return Promise.reject(new Error('cache unreachable'));
  }
  set(): Promise<void> {
    return Promise.reject(new Error('cache unreachable'));
  }
  del(): Promise<void> {
    return Promise.reject(new Error('cache unreachable'));
  }
  incr(): Promise<number> {
    return Promise.reject(new Error('cache unreachable'));
  }
  expire(): Promise<boolean> {
    return Promise.reject(new Error('cache unreachable'));
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

let container: Container;
let app: FastifyInstance;
let clock: FixedClock;
let logger: FakeLogger;

async function build(cache?: CachePort): Promise<void> {
  clock = new FixedClock('2026-02-03T04:05:06.000Z');
  logger = new FakeLogger();
  container = createContainer(CONFIG, {
    clock,
    idGen: new CounterIdGen(),
    logger,
    cache: cache ?? new MemoryCache(clock),
    mail: new RecordingMail(),
  });
  app = await createServer(container);

  /**
   * A stand-in for `requireSession`, registered the SAME way identity registers
   * the real one — as a ROUTE-level preHandler.
   *
   * That placement is the whole subject of this file. An app-level hook would
   * run before this and see no actor.
   */
  const asUser =
    (userId: string) =>
    (request: FastifyRequest): Promise<void> => {
      request.actor = { userId, role: 'student', tenantId: TENANT };
      return Promise.resolve();
    };

  app.get('/api/v1/me/thing', { preHandler: asUser(USER_A) }, () => ({ status: 'ok' }));
  app.get('/api/v1/me/other', { preHandler: asUser(USER_B) }, () => ({ status: 'ok' }));
  app.get('/api/v1/public/thing', () => ({ status: 'ok' }));

  await app.ready();
}

afterEach(async () => {
  await app.close();
  await container.shutdown();
});

const hit = (url: string): Promise<{ statusCode: number }> => app.inject({ method: 'GET', url });

describe('100 per minute, keyed by user id', () => {
  beforeEach(async () => {
    await build();
  });

  it('allows the first 100 requests in a window', async () => {
    // The control. Without it, the test below would pass just as happily against
    // a limiter that rejected everything.
    for (let i = 0; i < AUTHENTICATED_RATE_LIMIT.limit; i += 1) {
      expect((await hit('/api/v1/me/thing')).statusCode).toBe(200);
    }
  });

  it('REJECTS the 101st request in the same minute with a 429', async () => {
    for (let i = 0; i < AUTHENTICATED_RATE_LIMIT.limit; i += 1) {
      await hit('/api/v1/me/thing');
    }

    const overLimit = await hit('/api/v1/me/thing');
    expect(overLimit.statusCode).toBe(429);
  });

  it('lets the caller back in once the window has closed', async () => {
    /**
     * THROUGH THE INJECTED CLOCK, never a sleep.
     *
     * `MemoryCache` expires keys against the same clock, so advancing it past
     * the window is exactly what advancing wall time would do — in microseconds,
     * and deterministically. A test that slept for the window would be a
     * 60-second test, and 60-second tests get deleted.
     */
    for (let i = 0; i <= AUTHENTICATED_RATE_LIMIT.limit; i += 1) {
      await hit('/api/v1/me/thing');
    }
    expect((await hit('/api/v1/me/thing')).statusCode).toBe(429);

    clock.advanceMs(AUTHENTICATED_RATE_LIMIT.windowSeconds * 1000 + 1);

    expect((await hit('/api/v1/me/thing')).statusCode).toBe(200);
  });

  it('is PER USER, not global — exhausting one caller does not throttle another', async () => {
    /**
     * The failure this prevents is a total outage rather than a leak: one
     * runaway client, or one busy school, and every other user in the product is
     * refused. A single shared counter would pass "the 101st request is
     * rejected" perfectly.
     */
    for (let i = 0; i <= AUTHENTICATED_RATE_LIMIT.limit; i += 1) {
      await hit('/api/v1/me/thing');
    }
    expect((await hit('/api/v1/me/thing')).statusCode).toBe(429);

    expect((await hit('/api/v1/me/other')).statusCode).toBe(200);
  });

  it('does not throttle UNAUTHENTICATED requests', async () => {
    // No actor means no user id means no key. Those routes are covered by the
    // per-endpoint IP limits — keying this one by IP instead would put every
    // student in a school behind one NAT into a single 100/min bucket.
    for (let i = 0; i < AUTHENTICATED_RATE_LIMIT.limit + 20; i += 1) {
      expect((await hit('/api/v1/public/thing')).statusCode).toBe(200);
    }
  });

  it('counts each request ONCE, under its own key namespace', async () => {
    /**
     * "Must not double-count against the stricter per-endpoint limits."
     *
     * The mechanism is namespacing: this counter lives under
     * `rl:global:authenticated:` and identity's under `rl:identity:`. A request
     * that also consumes a per-endpoint budget therefore increments each counter
     * exactly once — never one twice, and never one INSTEAD of the other.
     *
     * Asserted on the counter itself rather than inferred from status codes,
     * because "the 101st was rejected" would look identical if a request
     * incremented twice and the limit were half what it says.
     */
    const cache = container.cache;
    for (let i = 0; i < 10; i += 1) {
      await hit('/api/v1/me/thing');
    }

    expect(await cache.get(`${GLOBAL_RATE_LIMIT_KEY_PREFIX}:${USER_A}`)).toBe('10');
  });
});

describe('the cache-outage fallback still works', () => {
  beforeEach(async () => {
    await build(new DeadCache());
  });

  it('keeps throttling from an in-process counter when the cache is unreachable', async () => {
    /**
     * D-034's rule, applied to this limiter: a cache outage must DEGRADE the
     * limit, never disable it and never break the request.
     *
     * The fallback is deliberately weaker — per instance rather than global, so
     * N instances admit up to N x the limit — and that is the correct trade. An
     * attacker who can also take down the cache gains a factor of N; a product
     * whose every authenticated route started returning 500 gains nothing.
     */
    for (let i = 0; i < AUTHENTICATED_RATE_LIMIT.limit; i += 1) {
      expect((await hit('/api/v1/me/thing')).statusCode).toBe(200);
    }

    expect((await hit('/api/v1/me/thing')).statusCode).toBe(429);
  });

  it('is still per user while degraded', async () => {
    for (let i = 0; i <= AUTHENTICATED_RATE_LIMIT.limit; i += 1) {
      await hit('/api/v1/me/thing');
    }

    expect((await hit('/api/v1/me/other')).statusCode).toBe(200);
  });

  it('WARNS on every activation — a silent fallback is a silent security downgrade', async () => {
    await hit('/api/v1/me/thing');

    const warnings = logger.lines.filter(
      (line) => line.level === 'warn' && line.obj.event === 'rate_limit.fallback_activated',
    );
    expect(warnings.length).toBeGreaterThan(0);
    // A DISTINCT metric from identity's: "authentication has degraded" and "the
    // global backstop has" are different pages in a runbook.
    expect(warnings[0]?.obj.metric).toBe('app.authenticated_rate_limit.in_process_fallback');
  });
});
