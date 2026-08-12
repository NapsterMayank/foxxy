import type { Entitlements, SubscriptionStatus } from '@/shared/contracts/billing.contract';
import { FREE_PLAN, FREE_PLAN_CODE, planOrFree } from './plans';
import { effectiveStatus, type SubscriptionState } from './subscription-status';

/**
 * ============================================================================
 * WHAT A USER MAY DO RIGHT NOW — pure, clock-injected, no I/O.
 *
 * FOUR RULES, AND EVERY ONE OF THEM IS THE ANSWER TO A REAL FAILURE.
 *
 * 1. AN ENTITLEMENT IS A POSITIVE GRANT, NEVER THE ABSENCE OF A DENIAL.
 *    This function returns the list of features that ARE granted. It never
 *    returns "not restricted". The difference matters on the day a feature
 *    moves from free to paid: with a positive grant, every consumer that has
 *    not been updated starts refusing it (visible, annoying, fixed in an hour);
 *    with a negative one, every consumer that has not been updated keeps giving
 *    it away (invisible, indefinite). The free tier is therefore a REAL list
 *    with real members, so that an empty list can safely mean "nothing".
 *
 * 2. IT IS COMPUTED AT REQUEST TIME AND NEVER CACHED IN THE SESSION.
 *    Exactly the reasoning behind §7 rule 3 for parent-child link revocation: a
 *    permission that lives on a session is a permission that survives its own
 *    revocation until the user logs out. A cancelled card, a halted
 *    subscription and a lapsed period must all take effect on the very next
 *    request, and the only way that is structurally true is if nothing
 *    remembers the answer.
 *
 * 3. AN EXPIRED SUBSCRIPTION CANNOT REACH A PAID FEATURE — and "expired" is
 *    decided by the CLOCK, not by the stored status. A row saying `active` with
 *    a period end in the past is a row nobody has revisited, not a live
 *    subscription. See `effectiveStatus`.
 *
 * 4. `pending` GRANTS NOTHING PAID. A subscription that has been created but
 *    not paid for is exactly the state an attacker would like access from:
 *    creating one costs nothing. Access begins when the provider says money
 *    arrived, and not one instant earlier.
 * ============================================================================
 */

/** The statuses under which a PAID grant may still be live. */
const GRANTING: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([
  'active',
  // Grace: a failed charge does not remove access before the period they
  // already paid for has run out.
  'past_due',
  // Cancelled: they paid for the period, so they keep it to the end.
  'cancelled',
]);

export interface EntitlementInput {
  /** Null when the user has never subscribed. The common case, not an error. */
  readonly subscription: (SubscriptionState & { readonly planCode: string }) | null;
  readonly now: Date;
}

/** The free grant, as a value. Used whenever nothing paid is live. */
export function freeEntitlements(): Entitlements {
  return {
    planCode: FREE_PLAN_CODE,
    isPaid: false,
    features: [...FREE_PLAN.features],
    // The free tier does not lapse, so there is nothing to count down to. Null
    // rather than a far-future date: a sentinel year would eventually arrive.
    activeUntil: null,
  };
}

export function resolveEntitlements(input: EntitlementInput): Entitlements {
  const { subscription } = input;
  if (subscription === null) return freeEntitlements();

  /**
   * TWO CONDITIONS, AND THE FIRST IS NOT REDUNDANT WITH THE SECOND.
   *
   * `effectiveStatus` already reports a null period end as `expired`, so the
   * second test alone would be correct. The first is written anyway because it
   * is what NARROWS the type: without it, `activeUntil` below needs a
   * `?? null` fallback whose null branch can never be taken — a dead branch in
   * the function that decides who has paid for what. Stating the condition
   * makes the impossible case impossible to express rather than merely
   * untaken.
   */
  const periodEnd = subscription.currentPeriodEnd;
  const status = effectiveStatus(subscription, input.now);
  if (periodEnd === null || !GRANTING.has(status)) return freeEntitlements();

  /**
   * `planOrFree`, not `findPlan`. A stored row referencing a RETIRED plan code
   * degrades to the free grant rather than throwing — a pricing change must not
   * lock an existing customer out of a product they can still see. The checkout
   * path uses `findPlan` and refuses, which is the opposite behaviour on
   * purpose: selling somebody a misspelt plan takes their money for nothing.
   */
  const plan = planOrFree(subscription.planCode);

  return {
    planCode: plan.code,
    isPaid: plan.purchasable,
    features: [...plan.features],
    activeUntil: periodEnd.toISOString(),
  };
}

/**
 * Does this grant include a given feature?
 *
 * The ONE function every other module should call. `entitlements.planCode ===
 * 'pro'` at a call site is the shape that decays: it hardcodes the catalogue in
 * a place nobody edits when the catalogue changes.
 */
export function hasFeature(
  entitlements: Entitlements,
  feature: Entitlements['features'][number],
): boolean {
  return entitlements.features.includes(feature);
}
