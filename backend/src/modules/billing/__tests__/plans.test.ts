import { describe, expect, it } from 'vitest';
import {
  FREE_PLAN,
  FREE_PLAN_CODE,
  PLANS,
  findPlan,
  planOrFree,
  purchasablePlans,
} from '../domain/plans';

/**
 * The catalogue is data, so most of these assertions are about SHAPE rather
 * than arithmetic. The two that are not — that `free` is a real grant, and that
 * paying never removes a feature — are the ones the module's safety rests on.
 */

describe('the free tier is a positive grant', () => {
  it('has real features rather than an empty list', () => {
    // If `free` were empty, "the lookup failed" and "you are on the free tier"
    // would be the same value, and every bug in the entitlement path would look
    // like a working free tier.
    expect(FREE_PLAN.features.length).toBeGreaterThan(0);
    expect(FREE_PLAN.features).toContain('practice.basic');
  });

  it('is never purchasable — it is never sent to a payment provider', () => {
    expect(FREE_PLAN.purchasable).toBe(false);
    expect(FREE_PLAN.amountMinorUnits).toBe(0);
  });

  it('is the SAME OBJECT as the table row, not a copy', () => {
    // Two literals would be two definitions of the free tier, and they would
    // drift the first time somebody edited one of them.
    expect(PLANS[FREE_PLAN_CODE]).toBe(FREE_PLAN);
  });
});

describe('paying never takes a feature away', () => {
  it('every purchasable plan is a superset of the free grant', () => {
    for (const plan of purchasablePlans()) {
      for (const feature of FREE_PLAN.features) {
        expect(plan.features).toContain(feature);
      }
    }
  });

  it('every purchasable plan costs something and lasts some time', () => {
    const purchasable = purchasablePlans();
    expect(purchasable.length).toBeGreaterThan(0);
    for (const plan of purchasable) {
      expect(plan.amountMinorUnits).toBeGreaterThan(0);
      expect(plan.periodDays).toBeGreaterThan(0);
      expect(Number.isInteger(plan.amountMinorUnits)).toBe(true);
    }
  });

  it('`free` is not offered for sale', () => {
    expect(purchasablePlans().map((plan) => plan.code)).not.toContain(FREE_PLAN_CODE);
  });
});

describe('findPlan and planOrFree behave OPPOSITELY on an unknown code, deliberately', () => {
  it('findPlan refuses — the checkout path must not sell a misspelt plan', () => {
    expect(findPlan('does-not-exist')).toBeNull();
    expect(findPlan('monthly')?.code).toBe('monthly');
  });

  it('planOrFree degrades — an entitlement read must not lock out a live customer', () => {
    // A retired plan code on a stored row. Throwing here would take the product
    // away from somebody who is still paying for it.
    expect(planOrFree('retired-2024').code).toBe(FREE_PLAN_CODE);
    expect(planOrFree('yearly').code).toBe('yearly');
  });
});
