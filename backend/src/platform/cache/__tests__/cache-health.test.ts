import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../clock/index';
import { CACHE_PROBE_KEY, createCacheProbe } from '../cache-health';
import { MemoryCache } from '../memory-cache';
import type { CachePort } from '../cache.port';

/**
 * =============================================================================
 * THE CACHE READINESS PROBE — D-230.
 *
 * WHY READINESS HAS TO COVER THE CACHE. `/health/ready` probed the database and
 * nothing else. The cache is where EVERY rate-limit counter lives, and
 * `platform/rate-limit` is deliberately built to survive its loss: when
 * `cache.incr` throws, counting moves into process memory so one dead container
 * cannot take authentication down with it. That trade is correct, and its own
 * header states the cost — "the fallback is DELIBERATELY WEAKER: per instance,
 * not global, so N instances admit up to N x the limit".
 *
 * What was missing is the other half. A replica in that state stayed in the
 * load balancer's rotation indefinitely, answering login and signup on a
 * counter that resets whenever it restarts. Nothing removed it, because nothing
 * asked.
 * =============================================================================
 */

const TIMEOUT_MS = 1_000;

function probeOf(cache: CachePort, clock = new FixedClock('2026-08-09T09:00:00.000Z')) {
  return { probe: createCacheProbe({ cache, timeoutMs: TIMEOUT_MS, clock }), clock };
}

describe('a reachable cache', () => {
  it('reports healthy', async () => {
    const clock = new FixedClock('2026-08-09T09:00:00.000Z');
    const { probe } = probeOf(new MemoryCache(clock), clock);

    await expect(probe.check()).resolves.toMatchObject({ reachable: true, failure: null });
  });

  it('treats a MISS as healthy — the probe key is supposed to be absent', async () => {
    // A `null` answer proves the round trip: connection, auth, protocol,
    // response. Reading it as unhealthy would take every replica out of
    // rotation permanently the first time anything worked.
    const clock = new FixedClock();
    const cache = new MemoryCache(clock);
    expect(await cache.get(CACHE_PROBE_KEY)).toBeNull();

    await expect(probeOf(cache, clock).probe.check()).resolves.toMatchObject({ reachable: true });
  });

  it('READS ONLY — it never writes to a store configured with allkeys-lru', async () => {
    // A `set` probe would add a write on every health check from every replica:
    // load applied to the store in proportion to how many things are watching
    // it, against the very eviction pressure that breaks rate limiting.
    const written: string[] = [];
    class WriteRecordingCache extends MemoryCache {
      override set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        written.push(key);
        return super.set(key, value, ttlSeconds);
      }
    }
    const clock = new FixedClock();

    await probeOf(new WriteRecordingCache(clock), clock).probe.check();

    expect(written).toEqual([]);
  });

  it('measures latency against the INJECTED clock', async () => {
    // Nothing sleeps (plan §9.5), and the probe must report the same time base
    // as everything else in the process.
    const clock = new FixedClock('2026-08-09T09:00:00.000Z');
    class SlowCache extends MemoryCache {
      override get(): Promise<string | null> {
        clock.advanceMs(37);
        return Promise.resolve(null);
      }
    }

    await expect(probeOf(new SlowCache(clock), clock).probe.check()).resolves.toMatchObject({
      latencyMs: 37,
    });
  });
});

/** A cache whose every read fails, the way a lost Valkey connection does. */
class UnreachableCache extends MemoryCache {
  override get(): Promise<string | null> {
    return Promise.reject(new Error('connect ECONNREFUSED 10.0.3.14:6379'));
  }
}

describe('an unreachable cache', () => {
  it('reports `unreachable` rather than throwing', async () => {
    // A readiness handler that had to catch would eventually have a call site
    // that did not, and an exception on the readiness path is a 500 where a 503
    // belongs.
    const clock = new FixedClock();

    await expect(probeOf(new UnreachableCache(clock), clock).probe.check()).resolves.toMatchObject({
      reachable: false,
      failure: 'unreachable',
    });
  });

  it('returns a CLASSIFICATION, never the ioredis message', async () => {
    // This value reaches an unauthenticated response body, and an ioredis error
    // carries the host and the port — the same defect `platform/db/health.ts`
    // had (D-229).
    const clock = new FixedClock();

    const health = await probeOf(new UnreachableCache(clock), clock).probe.check();

    expect(JSON.stringify(health)).not.toContain('10.0.3.14');
    expect(JSON.stringify(health)).not.toContain('6379');
    expect(health.failure).toBe('unreachable');
  });

  it('distinguishes a HANG from a refusal, and is bounded either way', async () => {
    // A readiness probe that hangs has already failed, and a load balancer
    // holding the connection open is worse than a fast 503. The two are
    // separated because they route to different runbook pages: one is "the
    // cache is gone", the other is "the cache is alive and overwhelmed".
    const clock = new FixedClock();
    class HangingCache extends MemoryCache {
      override get(): Promise<string | null> {
        return new Promise<string | null>(() => undefined);
      }
    }

    await expect(probeOf(new HangingCache(clock), clock).probe.check()).resolves.toMatchObject({
      reachable: false,
      failure: 'timeout',
    });
  }, 10_000);
});
