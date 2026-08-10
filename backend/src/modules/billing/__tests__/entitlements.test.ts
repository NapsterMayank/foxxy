import { describe, expect, it } from 'vitest';
import type { SubscriptionStatus } from '@/shared/contracts/billing.contract';
import { freeEntitlements, hasFeature, resolveEntitlements } from '../domain/entitlements';
import { FREE_PLAN_CODE } from '../domain/plans';

/**
 * ENTITLEMENTS — the answer to "what may this person do right now".
 *
 * Every assertion here is about a DENIAL or about a GRANT being positive. The
 * happy path ("a paying customer gets the paid features") is one test; the
 * other nine are the ways a billing system accidentally gives the product away.
 */

const NOW = new Date('2026-08-10T12:00:00.000Z');
const FUTURE = new Date('2026-09-09T12:00:00.000Z');
const PAST = new Date('2026-07-10T12:00:00.000Z');

function sub(
  status: SubscriptionStatus,
  currentPeriodEnd: Date | null,
  planCode = 'monthly',
): { status: SubscriptionStatus; currentPeriodEnd: Date | null; cancelledAt: Date | null; planCode: string } {
  return { status, currentPeriodEnd, cancelledAt: null, planCode };
}

describe('no subscription is the free grant, not an error and not nothing', () => {
  it('resolves to the free tier with real features', () => {
    const result = resolveEntitlements({ subscription: null, now: NOW });
    expect(result).toEqual(freeEntitlements());
    expect(result.planCode).toBe(FREE_PLAN_CODE);
    expect(result.isPaid).toBe(false);
    expect(result.features.length).toBeGreaterThan(0);
    // The free tier does not lapse, so there is nothing to count down to.
    expect(result.activeUntil).toBeNull();
  });
});

describe('a live paid subscription grants the paid features', () => {
  it('grants them, marks itself paid, and reports when it lapses', () => {
    const result = resolveEntitlements({ subscription: sub('active', FUTURE), now: NOW });
    expect(result.planCode).toBe('monthly');
    expect(result.isPaid).toBe(true);
    expect(hasFeature(result, 'foxy.unlimited')).toBe(true);
    expect(result.activeUntil).toBe(FUTURE.toISOString());
  });

  it('still grants the free features — paying never removes anything', () => {
    const result = resolveEntitlements({ subscription: sub('active', FUTURE), now: NOW });
    expect(hasFeature(result, 'practice.basic')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE DENIALS
// ---------------------------------------------------------------------------

describe('AN EXPIRED SUBSCRIPTION CANNOT REACH A PAID FEATURE', () => {
  it('a stored `active` whose period has passed grants only the free tier', () => {
    // The headline requirement of §8.8, and the reason expiry is COMPUTED
    // rather than swept: nothing has to run for this to be true.
    const result = resolveEntitlements({ subscription: sub('active', PAST), now: NOW });
    expect(result.isPaid).toBe(false);
    expect(hasFeature(result, 'foxy.unlimited')).toBe(false);
    expect(result).toEqual(freeEntitlements());
  });

  it('an explicitly expired row grants only the free tier', () => {
    const result = resolveEntitlements({ subscription: sub('expired', FUTURE), now: NOW });
    expect(hasFeature(result, 'practice.unlimited')).toBe(false);
  });

  it('one millisecond past the end is already expired', () => {
    const endsNow = resolveEntitlements({ subscription: sub('active', NOW), now: NOW });
    expect(endsNow.isPaid).toBe(false);
  });
});

describe('a PENDING subscription grants nothing paid', () => {
  it('created but unpaid is the free tier', () => {
    // Creating a subscription costs nothing, so `pending` is exactly the state
    // an attacker would like access from. Access begins when the provider says
    // money arrived and not one instant earlier.
    const result = resolveEntitlements({
      subscription: sub('pending', FUTURE),
      now: NOW,
    });
    expect(result.isPaid).toBe(false);
    expect(hasFeature(result, 'foxy.unlimited')).toBe(false);
  });
});

describe('a NULL period end is never treated as unlimited', () => {
  it('an active row with no end grants only the free tier', () => {
    const result = resolveEntitlements({ subscription: sub('active', null), now: NOW });
    expect(result.isPaid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE GRACE CASES — denial is not the only thing that has to be right
// ---------------------------------------------------------------------------

describe('grace and cancellation keep access they were paid for', () => {
  it('past_due within the paid period keeps the paid features', () => {
    // A failed charge must not cut off a customer who had already decided to
    // pay, over a bank's fraud heuristic.
    const result = resolveEntitlements({ subscription: sub('past_due', FUTURE), now: NOW });
    expect(hasFeature(result, 'practice.unlimited')).toBe(true);
  });

  it('past_due beyond the paid period does NOT', () => {
    const result = resolveEntitlements({ subscription: sub('past_due', PAST), now: NOW });
    expect(hasFeature(result, 'practice.unlimited')).toBe(false);
  });

  it('cancelled keeps access to the end of the period', () => {
    const result = resolveEntitlements({ subscription: sub('cancelled', FUTURE), now: NOW });
    expect(result.isPaid).toBe(true);
    expect(result.activeUntil).toBe(FUTURE.toISOString());
  });

  it('cancelled past the period does not', () => {
    const result = resolveEntitlements({ subscription: sub('cancelled', PAST), now: NOW });
    expect(result.isPaid).toBe(false);
  });
});

describe('a retired plan code degrades rather than throwing', () => {
  it('resolves to the free grant', () => {
    // A pricing change must not lock an existing customer out of a product they
    // can still see. The CHECKOUT path deliberately does the opposite and
    // refuses an unknown code.
    const result = resolveEntitlements({
      subscription: sub('active', FUTURE, 'retired-2024'),
      now: NOW,
    });
    expect(result.planCode).toBe(FREE_PLAN_CODE);
    expect(result.isPaid).toBe(false);
  });
});

describe('hasFeature is the only shape a caller should write', () => {
  it('answers from the grant list rather than from the plan code', () => {
    const free = freeEntitlements();
    expect(hasFeature(free, 'practice.basic')).toBe(true);
    expect(hasFeature(free, 'parent.digest')).toBe(false);
  });
});
