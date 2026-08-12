import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCache, type CachePort } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { FakeLogger } from '@/platform/logger/index';
import type { RateLimitRule } from '@/shared/constants/rate-limits';
import {
  InProcessRateLimitCounters,
  RATE_LIMIT_FALLBACK_METRIC,
  createRateLimiter,
  rateLimitKeys,
  type MetricsSink,
  type RateLimiter,
} from '../identity.rate-limit';

/**
 * The rate limiter, and its in-process fallback — 04-RESILIENCE-PLAN.md §6
 * (the Valkey row: Auth is "⚠️ in-process rate limits", not "❌") and §11
 * ("Rate-limit fallback: make the cache unavailable; assert login still works
 * under an in-process limiter").
 *
 * The login half of that §11 sentence is asserted end to end, against a real
 * database, in `identity.rate-limit-fallback.test.ts`. This file covers the
 * limiter's own branches.
 */

const RULE: RateLimitRule = { limit: 3, windowSeconds: 900 };
const KEY = rateLimitKeys.loginByIp('ip-hash');

/** A cache that is simply not there. Every call rejects, as ioredis would. */
class UnavailableCache implements CachePort {
  calls = 0;

  private fail(): Promise<never> {
    this.calls += 1;
    return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
  }

  get(): Promise<string | null> {
    return this.fail();
  }
  set(): Promise<void> {
    return this.fail();
  }
  del(): Promise<void> {
    return this.fail();
  }
  incr(): Promise<number> {
    return this.fail();
  }
  expire(): Promise<boolean> {
    return this.fail();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Counts increments so a test can prove `incr` succeeded and `expire` did not. */
class ExpireFailsCache extends MemoryCache {
  override expire(): Promise<boolean> {
    return Promise.reject(new Error('cache went away mid-request'));
  }
}

class RecordingMetrics implements MetricsSink {
  readonly increments: string[] = [];

  increment(metric: string): void {
    this.increments.push(metric);
  }
}

let clock: FixedClock;
let logger: FakeLogger;
let metrics: RecordingMetrics;

beforeEach(() => {
  clock = new FixedClock('2026-06-01T09:00:00.000Z');
  logger = new FakeLogger();
  metrics = new RecordingMetrics();
});

function limiterOn(cache: CachePort): RateLimiter {
  return createRateLimiter({ cache, clock, logger, metrics });
}

// ---------------------------------------------------------------------------
// The normal path: the SHARED counter in the cache.
// ---------------------------------------------------------------------------

describe('the cache-backed counter', () => {
  it('admits exactly the limit and refuses the next attempt', async () => {
    const limiter = limiterOn(new MemoryCache(clock));

    for (let attempt = 0; attempt < RULE.limit; attempt += 1) {
      await expect(limiter.consume(KEY, RULE)).resolves.toBeUndefined();
    }
    await expect(limiter.consume(KEY, RULE)).rejects.toMatchObject({
      code: 'RATE_LIMIT_EXCEEDED',
    });
  });

  it('sets the window on the FIRST attempt and never extends it', async () => {
    const cache = new MemoryCache(clock);
    const limiter = limiterOn(cache);

    await limiter.consume(KEY, RULE);
    clock.advanceSeconds(RULE.windowSeconds - 1);
    await limiter.consume(KEY, RULE);

    // If the second attempt had pushed the deadline forward, the counter would
    // still be alive one second later and this attempt would be the third.
    clock.advanceSeconds(2);
    await expect(limiter.consume(KEY, RULE)).resolves.toBeUndefined();
    expect(await cache.get(KEY)).toBe('1');
  });

  it('clears the counter on reset', async () => {
    const limiter = limiterOn(new MemoryCache(clock));
    for (let attempt = 0; attempt < RULE.limit; attempt += 1) await limiter.consume(KEY, RULE);

    await limiter.reset(KEY);

    await expect(limiter.consume(KEY, RULE)).resolves.toBeUndefined();
  });

  it('does not touch the fallback while the cache is healthy', async () => {
    const limiter = limiterOn(new MemoryCache(clock));
    await limiter.consume(KEY, RULE);

    expect(metrics.increments).toEqual([]);
    expect(logger.lines.filter((line) => line.msg?.includes('fell back'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE FALLBACK. Open item 2: a dead cache used to 500 every login.
// ---------------------------------------------------------------------------

describe('when the cache is unavailable', () => {
  it('KEEPS COUNTING rather than rejecting the request', async () => {
    const limiter = limiterOn(new UnavailableCache());

    // Before this existed, `cache.incr` rejecting propagated out of `consume`
    // and login returned 500. One dead container disabled authentication.
    await expect(limiter.consume(KEY, RULE)).resolves.toBeUndefined();
  });

  it('STILL ENFORCES THE LIMIT within this instance', async () => {
    const limiter = limiterOn(new UnavailableCache());

    for (let attempt = 0; attempt < RULE.limit; attempt += 1) {
      await expect(limiter.consume(KEY, RULE)).resolves.toBeUndefined();
    }
    await expect(limiter.consume(KEY, RULE)).rejects.toMatchObject({
      code: 'RATE_LIMIT_EXCEEDED',
    });
  });

  it('LOGS AT WARN on every activation — a silent fallback is a silent downgrade', async () => {
    const limiter = limiterOn(new UnavailableCache());

    await limiter.consume(KEY, RULE);
    await limiter.consume(KEY, RULE);

    const warnings = logger.lines.filter(
      (line) => line.level === 'warn' && line.obj.event === 'rate_limit.fallback_activated',
    );
    expect(warnings).toHaveLength(2);
  });

  it('EMITS A METRIC on every activation', async () => {
    const limiter = limiterOn(new UnavailableCache());

    await limiter.consume(KEY, RULE);
    await limiter.consume(KEY, RULE);

    expect(metrics.increments).toEqual([
      RATE_LIMIT_FALLBACK_METRIC,
      RATE_LIMIT_FALLBACK_METRIC,
    ]);
  });

  it('logs no key and no cache URL — the message only', async () => {
    const limiter = limiterOn(new UnavailableCache());
    await limiter.consume(rateLimitKeys.loginByEmail('email-hash-abc'), RULE);

    const serialised = JSON.stringify(logger.lines);
    expect(serialised).not.toContain('email-hash-abc');
    expect(serialised).not.toContain('redis://');
  });

  it('expires the in-process window on the injected clock, with no sleeping', async () => {
    const limiter = limiterOn(new UnavailableCache());
    for (let attempt = 0; attempt < RULE.limit; attempt += 1) await limiter.consume(KEY, RULE);
    await expect(limiter.consume(KEY, RULE)).rejects.toMatchObject({
      code: 'RATE_LIMIT_EXCEEDED',
    });

    clock.advanceSeconds(RULE.windowSeconds);

    await expect(limiter.consume(KEY, RULE)).resolves.toBeUndefined();
  });

  it('keeps each key on its own budget', async () => {
    const limiter = limiterOn(new UnavailableCache());
    const other = rateLimitKeys.loginByIp('a-different-ip');

    for (let attempt = 0; attempt < RULE.limit + 1; attempt += 1) {
      await limiter.consume(KEY, RULE).catch(() => undefined);
    }

    await expect(limiter.consume(other, RULE)).resolves.toBeUndefined();
  });

  it('never lets reset() throw — it runs straight after a successful login', async () => {
    const limiter = limiterOn(new UnavailableCache());
    await expect(limiter.reset(KEY)).resolves.toBeUndefined();
  });

  it('clears the in-process counter on reset too', async () => {
    const limiter = limiterOn(new UnavailableCache());
    for (let attempt = 0; attempt < RULE.limit; attempt += 1) await limiter.consume(KEY, RULE);

    await limiter.reset(KEY);

    await expect(limiter.consume(KEY, RULE)).resolves.toBeUndefined();
  });

  it('returns to the shared counter as soon as the cache recovers', async () => {
    // Two limiters over the same key: the outage one counts in process, the
    // healthy one counts in the cache and starts from zero. The fallback is
    // per-instance and per-outage by design — it is not a second source of
    // truth that has to be reconciled.
    const healthy = new MemoryCache(clock);
    await limiterOn(new UnavailableCache()).consume(KEY, RULE);

    const recovered = limiterOn(healthy);
    await recovered.consume(KEY, RULE);

    expect(await healthy.get(KEY)).toBe('1');
  });
});

describe('when incr succeeds but expire fails', () => {
  it('does not leave a TTL-less counter behind as a permanent lockout', async () => {
    const cache = new ExpireFailsCache(clock);
    const limiter = limiterOn(cache);

    await expect(limiter.consume(KEY, RULE)).resolves.toBeUndefined();

    // The counter with no expiry would sit above the limit forever; it is
    // removed and the attempt is counted in process instead.
    expect(await cache.get(KEY)).toBeNull();
    expect(metrics.increments).toEqual([RATE_LIMIT_FALLBACK_METRIC]);
  });
});

// ---------------------------------------------------------------------------
// The fallback store itself.
// ---------------------------------------------------------------------------

describe('InProcessRateLimitCounters', () => {
  it('counts up within a window', () => {
    const counters = new InProcessRateLimitCounters(clock);
    expect(counters.incr('k', 60)).toBe(1);
    expect(counters.incr('k', 60)).toBe(2);
  });

  it('starts a new window once the old one has expired', () => {
    const counters = new InProcessRateLimitCounters(clock);
    counters.incr('k', 60);
    clock.advanceSeconds(60);
    expect(counters.incr('k', 60)).toBe(1);
  });

  it('treats the expiry instant itself as expired, like every other deadline here', () => {
    const counters = new InProcessRateLimitCounters(clock);
    counters.incr('k', 10);
    clock.advanceSeconds(10);
    expect(counters.incr('k', 10)).toBe(1);
  });

  it('forgets a key on del', () => {
    const counters = new InProcessRateLimitCounters(clock);
    counters.incr('k', 60);
    counters.del('k');
    expect(counters.incr('k', 60)).toBe(1);
  });

  it('reports only live keys', () => {
    const counters = new InProcessRateLimitCounters(clock);
    counters.incr('a', 60);
    counters.incr('b', 10);

    expect(counters.size()).toBe(2);
    clock.advanceSeconds(30);
    expect(counters.size()).toBe(1);
  });
});
