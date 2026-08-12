import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../../cache/index';
import { FixedClock } from '../../clock/index';
import { RateLimitError } from '../../errors/index';
import { FakeLogger } from '../../logger/index';
import { createRateLimiter, type MetricsSink, type RateLimiter } from '../limiter';
import type { RateLimitRule } from '../../../shared/constants/rate-limits';

/**
 * =============================================================================
 * `Retry-After` REPORTED THE FULL WINDOW, ALWAYS — D-266 (H6).
 *
 * `consume` threw `new RateLimitError(rule.windowSeconds)` regardless of how
 * much of the window had actually elapsed. Trip the login limiter fourteen
 * minutes and fifty seconds into its fifteen-minute window and the client was
 * told to wait FIFTEEN MINUTES for a lockout with ten seconds left on it.
 *
 * WHY THAT IS NOT COSMETIC. `Retry-After` is obeyed. A mobile client, a
 * retrying SDK and our own frontend all wait exactly as long as they are told,
 * so the honest ten seconds became fifteen minutes for every well-behaved
 * caller — and ONLY a caller that ignored the header discovered it could have
 * retried sooner. The limiter penalised correct behaviour and rewarded
 * ignoring it.
 *
 * WHY NOTHING CAUGHT IT. The window genuinely never extends: `countInCache`
 * calls `expire` once, on attempt 1, precisely so a lockout cannot creep
 * forward. So the underlying limit was correct the whole time and only the
 * ADVERTISED wait was wrong. No error, no metric, no failing test — just users
 * reporting that it "locks me out for ages" against a rule that reads
 * 5-per-15-minutes and is accurate.
 *
 * NOTHING HERE SLEEPS. Elapsed time is an injected `FixedClock`.
 * =============================================================================
 */

const RULE: RateLimitRule = { limit: 5, windowSeconds: 900 };
const KEY = 'rl:identity:login:ip:0f1e2d';

const NO_METRICS: MetricsSink = {
  increment: (): void => {
    /* not the subject of this file */
  },
};

function build(clock: FixedClock): RateLimiter {
  return createRateLimiter({
    cache: new MemoryCache(clock),
    clock,
    logger: new FakeLogger(),
    metrics: NO_METRICS,
  });
}

/** Consumes until the limit trips and returns the error that was thrown. */
async function tripLimiter(limiter: RateLimiter, attempts: number): Promise<RateLimitError> {
  let caught: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await limiter.consume(KEY, RULE);
    } catch (error) {
      caught = error;
    }
  }
  if (!(caught instanceof RateLimitError)) {
    throw new Error('expected the limiter to refuse an attempt');
  }
  return caught;
}

describe('Retry-After reports what is LEFT of the window', () => {
  it('reports the remaining seconds, not the whole window', async () => {
    const clock = new FixedClock('2026-03-01T00:00:00.000Z');
    const limiter = build(clock);

    // Open the window with the first attempt, then spend almost all of it.
    await limiter.consume(KEY, RULE);
    clock.advanceSeconds(890);

    const error = await tripLimiter(limiter, RULE.limit + 1);

    // Ten seconds left, not nine hundred. This is the whole defect.
    expect(error.retryAfterSeconds).toBe(10);
  });

  it('never exceeds the window, and never advertises the full window mid-way', async () => {
    const clock = new FixedClock('2026-03-01T00:00:00.000Z');
    const limiter = build(clock);

    await limiter.consume(KEY, RULE);
    clock.advanceSeconds(450);

    const error = await tripLimiter(limiter, RULE.limit + 1);

    expect(error.retryAfterSeconds).toBe(450);
    expect(error.retryAfterSeconds).toBeLessThan(RULE.windowSeconds);
  });

  it('reports the FULL window when the limit trips immediately', async () => {
    // No time has passed, so "what is left" and "the whole window" are the same
    // number — the old behaviour was right in exactly this one case, which is
    // how it survived review.
    const clock = new FixedClock('2026-03-01T00:00:00.000Z');
    const limiter = build(clock);

    const error = await tripLimiter(limiter, RULE.limit + 1);

    expect(error.retryAfterSeconds).toBe(RULE.windowSeconds);
  });

  it('ROUNDS UP, so it never advertises a retry that is certain to be refused', async () => {
    // 1.2s remaining rounded DOWN puts the client back 200ms early and refused
    // again — a retry loop indistinguishable from an attack. Rounding to zero
    // would invite an immediate retry.
    const clock = new FixedClock('2026-03-01T00:00:00.000Z');
    const limiter = build(clock);

    await limiter.consume(KEY, RULE);
    clock.advanceMs(899_200);

    const error = await tripLimiter(limiter, RULE.limit + 1);

    expect(error.retryAfterSeconds).toBe(1);
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('falls back to the FULL window when this process never saw the window open', async () => {
    /**
     * The deliberate conservative case, and it is why the deadline map is a
     * fallback rather than an authority. A window opened by another replica or
     * before a restart leaves no local entry. Guessing "nearly over" there
     * would send a caller straight back into a refusal; over-reporting is the
     * safe direction and is the behaviour that already shipped.
     *
     * Reproduced by consuming through a limiter that shares the cache — so the
     * counter is already above the limit — but has its own, empty deadline map.
     */
    const clock = new FixedClock('2026-03-01T00:00:00.000Z');
    const cache = new MemoryCache(clock);
    const first = createRateLimiter({ cache, clock, logger: new FakeLogger(), metrics: NO_METRICS });
    const second = createRateLimiter({
      cache,
      clock,
      logger: new FakeLogger(),
      metrics: NO_METRICS,
    });

    for (let i = 0; i < RULE.limit; i += 1) await first.consume(KEY, RULE);
    clock.advanceSeconds(600);

    await expect(second.consume(KEY, RULE)).rejects.toMatchObject({
      retryAfterSeconds: RULE.windowSeconds,
    });
  });

  it('reports the full window again once a NEW window has opened', async () => {
    // The counter must not inherit the old deadline: a fresh window is a fresh
    // fifteen minutes, and reporting the tail of the previous one would
    // under-report — the opposite error, and the one that causes retry storms.
    const clock = new FixedClock('2026-03-01T00:00:00.000Z');
    const limiter = build(clock);

    await limiter.consume(KEY, RULE);
    clock.advanceSeconds(901);

    const error = await tripLimiter(limiter, RULE.limit + 1);

    expect(error.retryAfterSeconds).toBe(RULE.windowSeconds);
  });
});
