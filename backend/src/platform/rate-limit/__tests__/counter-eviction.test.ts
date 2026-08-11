import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../../cache/index';
import { FixedClock } from '../../clock/index';
import { FakeLogger } from '../../logger/index';
import type { CachePort } from '../../cache/cache.port';
import {
  RATE_LIMIT_COUNTER_EVICTED_METRIC,
  createRateLimiter,
  type MetricsSink,
} from '../limiter';
import type { RateLimitRule } from '../../../shared/constants/rate-limits';

/**
 * =============================================================================
 * A RATE-LIMIT COUNTER THAT VANISHED WHILE ITS WINDOW WAS STILL OPEN — D-230.
 *
 * WHY THIS HAPPENS. Valkey is configured with `allkeys-lru`. Under memory
 * pressure it evicts the least recently used keys, and a rate-limit counter is
 * BY CONSTRUCTION among them: it is touched a handful of times and then not
 * again for fifteen minutes.
 *
 * WHY IT HAS NO SIGNAL. When one is evicted mid-window the next `incr` returns
 * 1, and the limiter reads that as a first attempt. An attacker on their fifth
 * login attempt is back to their first. There is NO ERROR: the cache is up,
 * `incr` succeeded, the breaker is closed, and the in-process fallback — which
 * does have a metric — never activates. Rate limiting silently stops limiting
 * while every signal in the system says it is working.
 *
 * This is the ninth instance of this codebase's recurring defect shape, and it
 * is the one where the enforcement is not merely absent but ACTIVELY REPORTING
 * SUCCESS.
 *
 * NOTHING HERE SLEEPS. The window is evaluated against an injected clock.
 * =============================================================================
 */

const RULE: RateLimitRule = { limit: 5, windowSeconds: 900 };
const KEY = 'login:ip:0f1e2d';

class RecordingMetrics implements MetricsSink {
  readonly counts = new Map<string, number>();

  increment(metric: string): void {
    this.counts.set(metric, (this.counts.get(metric) ?? 0) + 1);
  }

  totalFor(metric: string): number {
    return this.counts.get(metric) ?? 0;
  }
}

/**
 * A cache that counts, and can be told to LOSE a key the way eviction does.
 *
 * Deliberately not `MemoryCache` with a `del`: `reset()` also deletes, and the
 * point of the metric is to tell a deliberate clear apart from an eviction. A
 * separate `evict` makes the two indistinguishable to the limiter and clearly
 * different here.
 */
class EvictableCache implements CachePort {
  private readonly counters = new Map<string, number>();
  private readonly inner: MemoryCache;

  constructor(clock: FixedClock) {
    this.inner = new MemoryCache(clock);
  }

  evict(key: string): void {
    this.counters.delete(key);
  }

  incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return Promise.resolve(next);
  }

  del(key: string): Promise<void> {
    this.counters.delete(key);
    return this.inner.del(key);
  }

  expire(): Promise<boolean> {
    // True: the TTL was applied. The limiter treats a false here as a
    // TTL-less key and deletes it, which is a different failure entirely.
    return Promise.resolve(true);
  }

  get(key: string): Promise<string | null> {
    return this.inner.get(key);
  }

  set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    return this.inner.set(key, value, ttlSeconds);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

function build() {
  const clock = new FixedClock('2026-08-09T09:00:00.000Z');
  const cache = new EvictableCache(clock);
  const logger = new FakeLogger();
  const metrics = new RecordingMetrics();
  const limiter = createRateLimiter({ cache, clock, logger, metrics });
  return { limiter, cache, clock, logger, metrics };
}

describe('an evicted counter is detected and reported', () => {
  it('emits the metric when a window restarts before its deadline', async () => {
    // THE NAMED TEST. Delete the `observeWindowStart` check and this goes red —
    // and with it goes the only signal that rate limiting has stopped applying.
    const { limiter, cache, clock, metrics } = build();

    await limiter.consume(KEY, RULE);
    await limiter.consume(KEY, RULE);

    // Four minutes into a fifteen-minute window. The key is gone, and nothing
    // about the cache reports that it went.
    clock.advanceSeconds(240);
    cache.evict(KEY);

    await limiter.consume(KEY, RULE);

    expect(metrics.totalFor(RATE_LIMIT_COUNTER_EVICTED_METRIC)).toBe(1);
  });

  it('logs at warn, naming the rule and NEVER the key', async () => {
    // The key identifies an account or an IP. The window length is what tells
    // an operator which of the three limits lost its counter.
    const { limiter, cache, clock, logger } = build();

    await limiter.consume(KEY, RULE);
    clock.advanceSeconds(60);
    cache.evict(KEY);
    await limiter.consume(KEY, RULE);

    const line = logger.lines.find((entry) => entry.obj.event === 'rate_limit.counter_evicted');
    expect(line).toBeDefined();
    expect(line?.obj.windowSeconds).toBe(900);
    expect(line?.obj.limit).toBe(5);
    expect(JSON.stringify(line?.obj)).not.toContain(KEY);
  });

  it('does NOT fire when the window expired on time', async () => {
    // The control, and the reason the metric is trustworthy. A key evicted
    // after its window closed is indistinguishable from one that expired, so
    // the check can only ever MISS an eviction, never invent one. A metric that
    // under-reports is actionable; one that over-reports gets muted.
    const { limiter, cache, clock, metrics } = build();

    await limiter.consume(KEY, RULE);
    clock.advanceSeconds(901);
    cache.evict(KEY);

    await limiter.consume(KEY, RULE);

    expect(metrics.totalFor(RATE_LIMIT_COUNTER_EVICTED_METRIC)).toBe(0);
  });

  it('does NOT fire for a first-ever attempt', async () => {
    const { limiter, metrics } = build();

    await limiter.consume(KEY, RULE);

    expect(metrics.totalFor(RATE_LIMIT_COUNTER_EVICTED_METRIC)).toBe(0);
  });

  it('does NOT fire after a deliberate reset', async () => {
    // `reset` runs immediately after a SUCCESSFUL login. Without forgetting the
    // deadline, every successful login would report an eviction — which is
    // technically "the counter vanished early" and is not the failure the
    // metric names. A signal that fires on the happy path is a signal nobody
    // reads.
    const { limiter, clock, metrics } = build();

    await limiter.consume(KEY, RULE);
    await limiter.reset(KEY);
    clock.advanceSeconds(30);
    await limiter.consume(KEY, RULE);

    expect(metrics.totalFor(RATE_LIMIT_COUNTER_EVICTED_METRIC)).toBe(0);
  });

  it('reports each eviction, not just the first', async () => {
    // Repeated evictions mean sustained memory pressure, and the RATE is the
    // number that says how much limiting is being lost.
    const { limiter, cache, clock, metrics } = build();

    for (let i = 0; i < 3; i += 1) {
      await limiter.consume(KEY, RULE);
      clock.advanceSeconds(10);
      cache.evict(KEY);
    }
    await limiter.consume(KEY, RULE);

    expect(metrics.totalFor(RATE_LIMIT_COUNTER_EVICTED_METRIC)).toBe(3);
  });

  it('is a DISTINCT metric from the in-process fallback', async () => {
    // Two different degradations with two different remedies: "Valkey is gone"
    // versus "Valkey is up and shedding our keys". One name for both makes the
    // alert unactionable.
    const { limiter, cache, clock, metrics } = build();

    await limiter.consume(KEY, RULE);
    clock.advanceSeconds(10);
    cache.evict(KEY);
    await limiter.consume(KEY, RULE);

    expect(RATE_LIMIT_COUNTER_EVICTED_METRIC).not.toBe('rate_limit.in_process_fallback');
    expect(metrics.totalFor('rate_limit.in_process_fallback')).toBe(0);
  });

  it('still enforces the limit — detection must not replace counting', async () => {
    // The metric is how somebody finds out. It is not a fix, and a change that
    // made it one by, say, refusing the request would turn a memory-pressure
    // event into an outage.
    const { limiter } = build();

    for (let i = 0; i < 5; i += 1) await limiter.consume(KEY, RULE);

    await expect(limiter.consume(KEY, RULE)).rejects.toThrow();
  });
});
