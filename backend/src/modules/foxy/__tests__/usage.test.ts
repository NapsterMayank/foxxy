import { describe, expect, it } from 'vitest';
import { FOXY_DAILY_MESSAGE_LIMIT, FOXY_PLANS } from '@/shared/constants/foxy';
import {
  USAGE_TTL_SECONDS,
  decideUsage,
  secondsUntilReset,
  usageCacheKey,
  usageDayKey,
} from '../domain/usage';

/**
 * ============================================================================
 * THE USAGE RULE — pure arithmetic, tested at every boundary.
 *
 * An off-by-one here is either a free message every day for every account or a
 * student blocked one message early. NEITHER SHOWS UP AS AN ERROR ANYWHERE, so
 * the boundary is asserted at limit-1, limit and limit+1 for every plan rather
 * than at one convenient number.
 * ============================================================================
 */

const CLOCK = new Date('2026-06-01T09:00:00.000Z');

describe('decideUsage — the boundary', () => {
  it.each(FOXY_PLANS)('admits up to the limit and refuses beyond it for %s', (plan) => {
    const limit = FOXY_DAILY_MESSAGE_LIMIT[plan];

    expect(decideUsage(0, plan).allowed).toBe(true);
    expect(decideUsage(limit - 1, plan).allowed).toBe(true);
    // `used` is the count BEFORE this message, so `used === limit` means the
    // allowance is spent.
    expect(decideUsage(limit, plan).allowed).toBe(false);
    expect(decideUsage(limit + 1, plan).allowed).toBe(false);
  });

  it('reports the remaining count AFTER this message, floored at zero', () => {
    const limit = FOXY_DAILY_MESSAGE_LIMIT.free;
    expect(decideUsage(0, 'free').remaining).toBe(limit - 1);
    expect(decideUsage(limit - 1, 'free').remaining).toBe(0);
    expect(decideUsage(limit, 'free').remaining).toBe(0);
    expect(decideUsage(limit + 50, 'free').remaining).toBe(0);
  });

  it('echoes the plan’s limit so a caller never has to look it up', () => {
    expect(decideUsage(0, 'plus').limit).toBe(FOXY_DAILY_MESSAGE_LIMIT.plus);
  });

  it('gives a paid plan strictly more than a free one', () => {
    // Otherwise the limit is not a plan feature, it is a constant with two names.
    expect(FOXY_DAILY_MESSAGE_LIMIT.plus).toBeGreaterThan(FOXY_DAILY_MESSAGE_LIMIT.free);
  });
});

describe('the counter key', () => {
  it('is namespaced, per user, and per UTC day', () => {
    expect(usageCacheKey('user-1', CLOCK)).toBe('foxy:usage:user-1:2026-06-01');
  });

  it('changes at UTC midnight and not before', () => {
    expect(usageDayKey(new Date('2026-06-01T23:59:59.999Z'))).toBe('2026-06-01');
    expect(usageDayKey(new Date('2026-06-02T00:00:00.000Z'))).toBe('2026-06-02');
  });

  it('keeps two users apart', () => {
    expect(usageCacheKey('a', CLOCK)).not.toBe(usageCacheKey('b', CLOCK));
  });

  it('lives longer than a day, so an early start does not get a second allowance', () => {
    // An exact 24 hours would expire the key mid-morning the following day.
    expect(USAGE_TTL_SECONDS).toBeGreaterThan(24 * 60 * 60);
  });
});

describe('secondsUntilReset', () => {
  it('counts to the next UTC midnight', () => {
    expect(secondsUntilReset(new Date('2026-06-01T23:00:00.000Z'))).toBe(3600);
    expect(secondsUntilReset(new Date('2026-06-01T00:00:00.000Z'))).toBe(24 * 3600);
  });

  it('is never zero — a Retry-After of 0 invites an immediate retry loop', () => {
    expect(secondsUntilReset(new Date('2026-06-01T23:59:59.999Z'))).toBeGreaterThanOrEqual(1);
  });
});
