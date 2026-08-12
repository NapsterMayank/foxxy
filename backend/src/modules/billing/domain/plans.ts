import type { EntitlementFeature } from '@/shared/contracts/billing.contract';

/**
 * ============================================================================
 * THE PLAN CATALOGUE — pure data, no clock, no database, no provider.
 *
 * A TABLE RATHER THAN A SEQUENCE OF `if`s, for the same reason `notify`'s
 * channel routing is a table: adding a plan must be a ROW EDIT, not a change to
 * every call site that asks "is this user paid?". Nothing outside this file
 * names a plan code in a conditional.
 *
 * ============================================================================
 * `free` IS A PLAN WITH REAL GRANTS, NOT THE ABSENCE OF A PLAN.
 *
 * This is the single most important line in the module. The natural
 * implementation of a free tier is "no subscription row, so no restrictions
 * apply yet" — i.e. free access is what you get when no check has denied you.
 * That inverts the safety property: any code path that fails to look up a
 * subscription, or that throws before it does, silently grants the free tier;
 * and the day a feature moves from free to paid, every one of those paths keeps
 * granting it.
 *
 * So `free` has an explicit feature list and every consumer asks "is this
 * feature in my grant?". A missing grant is an EMPTY list, which grants nothing
 * at all — that is what a bug should produce, rather than a working free tier
 * that nobody notices is being handed out by accident.
 *
 * ============================================================================
 * NOTHING HERE ASSUMES WHO PAYS.
 *
 * A plan is a bundle of features at a price. Whether a parent buys it, a school
 * buys it for a hundred students, or it is granted as part of a pilot is a
 * question about the SUBSCRIPTION row, not about the plan — see `payer` in
 * `platform/payments`. If the B2B pilot wins, `school_seat` is one more row
 * below and no other file changes.
 * ============================================================================
 */

export const FREE_PLAN_CODE = 'free';

export interface Plan {
  readonly code: string;
  /** Paise. An integer, because money is never a float. */
  readonly amountMinorUnits: number;
  readonly currency: string;
  /** How long one paid period lasts. Used to project a period end. */
  readonly periodDays: number;
  /** THE POSITIVE GRANT. Never derived from the price. */
  readonly features: readonly EntitlementFeature[];
  /** False for `free`: it is never sold, so it is never sent to a provider. */
  readonly purchasable: boolean;
}

const FREE_FEATURES: readonly EntitlementFeature[] = Object.freeze([
  'practice.basic',
  'foxy.basic',
]);

/**
 * Paid plans grant the free features TOO, spelled out rather than implied.
 *
 * Writing `[...FREE_FEATURES, …]` is what keeps "paying takes something away"
 * impossible; deriving it as "free unless paid" is what makes it possible.
 */
const PAID_FEATURES: readonly EntitlementFeature[] = Object.freeze([
  ...FREE_FEATURES,
  'practice.unlimited',
  'foxy.unlimited',
  'parent.digest',
]);

/**
 * THE FREE GRANT, declared before the table and then placed INTO it.
 *
 * One object, referenced twice, rather than a literal in `PLANS` plus a lookup
 * back out of it. The lookup would be `Plan | undefined` and would need either
 * a non-null assertion (banned by lint) or a fallback — and a fallback is a
 * second definition of the free tier, waiting to drift from the first.
 *
 * A free grant does not lapse, so `periodDays` is 0 and is never used to
 * project a period end.
 */
export const FREE_PLAN: Plan = Object.freeze({
  code: FREE_PLAN_CODE,
  amountMinorUnits: 0,
  currency: 'INR',
  periodDays: 0,
  features: FREE_FEATURES,
  purchasable: false,
});

export const PLANS: Readonly<Record<string, Plan>> = Object.freeze({
  [FREE_PLAN_CODE]: FREE_PLAN,
  monthly: Object.freeze({
    code: 'monthly',
    amountMinorUnits: 29_900,
    currency: 'INR',
    periodDays: 30,
    features: PAID_FEATURES,
    purchasable: true,
  }),
  yearly: Object.freeze({
    code: 'yearly',
    amountMinorUnits: 299_000,
    currency: 'INR',
    periodDays: 365,
    features: PAID_FEATURES,
    purchasable: true,
  }),
});

/** The plan, or null. NEVER a free-plan fallback — see `planOrFree` below. */
export function findPlan(code: string): Plan | null {
  return PLANS[code] ?? null;
}

/**
 * The plan for a code, falling back to `free`.
 *
 * SEPARATE FROM `findPlan`, and the separation is the point. The CHECKOUT path
 * must use `findPlan` and refuse an unknown code — silently selling somebody
 * the free plan because their code was misspelt takes their money for nothing.
 * The ENTITLEMENT path uses this one, because a stored row referencing a
 * retired plan code must degrade to free rather than throw and lock the user
 * out of a product they can still see.
 */
export function planOrFree(code: string): Plan {
  return findPlan(code) ?? FREE_PLAN;
}

/** Every plan a customer may actually buy. `free` is not one of them. */
export function purchasablePlans(): readonly Plan[] {
  return Object.values(PLANS).filter((plan) => plan.purchasable);
}
