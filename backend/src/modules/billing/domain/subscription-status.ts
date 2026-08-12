import type { PaymentEventKind } from '@/platform/payments/index';
import type { SubscriptionStatus } from '@/shared/contracts/billing.contract';

/**
 * ============================================================================
 * THE SUBSCRIPTION STATE MACHINE — pure, clock-injected, no I/O.
 *
 * One function decides what a payment event does to a subscription. It is
 * separated from the service so that the interesting cases — an out-of-order
 * charge, a replayed cancellation, an event type nobody has implemented — can
 * be enumerated exhaustively without a database, and so that the SERVICE has
 * nothing left to decide except how to write the answer down.
 *
 * ============================================================================
 * THREE RULES THAT LOOK LIKE DETAIL AND ARE NOT.
 *
 * 1. A PERIOD END IS NEVER SHORTENED BY AN EVENT.
 *    Webhooks arrive out of order — routinely, not exceptionally. A retried
 *    charge from three weeks ago carries a period end three weeks in the past,
 *    and an implementation that simply assigns it truncates a customer's paid
 *    access to a date that has already gone. So the new end is the LATER of the
 *    two. The failure this prevents is "I paid and it locked me out", which is
 *    also the failure most likely to be blamed on the card rather than on us.
 *
 * 2. `expired` IS TERMINAL. Nothing revives it.
 *    An expired row is the record of a subscription that has run out. A
 *    resubscribe creates a NEW row — which is why `subscriptions_one_live_idx`
 *    is partial. Allowing an old event to flip an expired row back to `active`
 *    would mean a replayed (or leaked) webhook could restore access months
 *    later, and the deduplication table is the only thing that would have stood
 *    in its way.
 *
 * 3. AN UNIMPLEMENTED EVENT CHANGES NOTHING, AND THAT IS AN ANSWER.
 *    Providers add event types without asking. `unknown` returns "no change",
 *    the event row is still written, and the subscription is untouched. The
 *    alternative — throwing — turns a harmless new event type into a 5xx that
 *    the provider retries for hours.
 * ============================================================================
 */

/** What a subscription looks like to this file. Deliberately tiny. */
export interface SubscriptionState {
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: Date | null;
  readonly cancelledAt: Date | null;
}

/** What an event says. Nothing provider-specific reaches here. */
export interface PaymentEventFacts {
  readonly kind: PaymentEventKind;
  /** The period end the event establishes, when it states one. */
  readonly currentPeriodEnd: Date | null;
  /** The injected clock's now. There is no `new Date()` in this file. */
  readonly now: Date;
  /** How long a period lasts, when the event states no end. */
  readonly periodDays: number;
}

/** `null` means "this event changes nothing" — a real answer, not a failure. */
export type StatusTransition = SubscriptionState | null;

const TERMINAL: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>(['expired']);

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function projectEnd(facts: PaymentEventFacts): Date | null {
  if (facts.currentPeriodEnd !== null) return facts.currentPeriodEnd;
  if (facts.periodDays <= 0) return null;
  return new Date(facts.now.getTime() + facts.periodDays * 24 * 60 * 60 * 1000);
}

export function applyPaymentEvent(
  current: SubscriptionState,
  facts: PaymentEventFacts,
): StatusTransition {
  // Rule 2. Checked before the switch, so no branch below can reach past it —
  // the same ordering `platform/authz` uses for the tenant check, and for the
  // same reason: a rule that runs only after another rule has said yes is not a
  // rule.
  if (TERMINAL.has(current.status)) return null;

  switch (facts.kind) {
    /**
     * The first successful payment, and every renewal.
     *
     * `payment.captured` is folded in here because a YEARLY plan is sold as a
     * one-time order rather than a recurring subscription, so its only evidence
     * of payment is a captured payment. A billing system that handles only the
     * recurring event silently ignores every annual customer.
     */
    case 'subscription.activated':
    case 'subscription.charged':
    case 'payment.captured': {
      const end = laterOf(current.currentPeriodEnd, projectEnd(facts));
      return {
        status: 'active',
        currentPeriodEnd: end,
        // A charge on a cancelled subscription is a reactivation; the
        // cancellation stamp goes with it, or the row would read as both.
        cancelledAt: null,
      };
    }

    /**
     * A charge failed. THE GRACE PERIOD, and it is deliberate.
     *
     * `past_due` still resolves to the paid grant while `current_period_end` is
     * in the future — a customer whose card expired keeps working while the
     * provider retries. Cutting access on the first failure loses a customer
     * who had already decided to pay, over a bank's fraud heuristic.
     *
     * The period end is NOT extended: the grace is exactly the remainder of the
     * period they already bought, and it lapses on its own with nothing having
     * to run.
     */
    case 'payment.failed': {
      if (current.status === 'past_due') return null;
      return {
        status: 'past_due',
        currentPeriodEnd: current.currentPeriodEnd,
        cancelledAt: current.cancelledAt,
      };
    }

    /**
     * The provider gave up after repeated failures. Access ends NOW.
     *
     * Unlike a cancellation, nothing was paid for the remaining time, so there
     * is nothing to honour. `current_period_end` is set to `now` rather than
     * left as it was, because the database CHECK requires a terminal row to
     * carry one and because "expired at" is the fact somebody will want.
     */
    case 'subscription.halted': {
      return { status: 'expired', currentPeriodEnd: facts.now, cancelledAt: current.cancelledAt };
    }

    /**
     * Cancelled — BUT ACCESS CONTINUES to the end of the paid period.
     *
     * They paid for the period; taking it back at the moment of cancellation is
     * theft dressed as a state machine. If no period end is known (a
     * cancellation of something that never activated), it becomes `now`, which
     * grants nothing — that is the honest reading of "cancelled before it ever
     * started" and it satisfies the CHECK that refuses a terminal row with a
     * null end.
     */
    case 'subscription.cancelled': {
      return {
        status: 'cancelled',
        currentPeriodEnd: current.currentPeriodEnd ?? facts.now,
        cancelledAt: current.cancelledAt ?? facts.now,
      };
    }

    // Rule 3. Recorded, never acted on.
    case 'unknown':
      return null;
  }

  /**
   * NO `default:` CLAUSE, deliberately.
   *
   * `PaymentEventKind` is a closed union and every member is named above, so a
   * `default` would be unreachable — and an unreachable branch in the file that
   * decides what a payment does is worse than untidy: it is the branch a new
   * event kind would silently fall into, granting or revoking nothing while
   * looking handled. Without it, adding a member to the union makes the
   * compiler point at this switch.
   *
   * The line below is what TypeScript needs to see a total function; it is
   * reached only if a value outside the union arrives at runtime, in which case
   * "change nothing" is the same answer `unknown` gets.
   */
  return null;
}

/**
 * The status a row ACTUALLY has right now, given the clock.
 *
 * ===========================================================================
 * THIS IS WHY NO CRON JOB IS NEEDED FOR EXPIRY, AND WHY THERE MUST NOT BE ONE
 * AS THE ONLY MECHANISM.
 *
 * A stored status is a claim made at the time of the last event. A row that says
 * `active` with a period end in the past is not active — it is a row nobody has
 * revisited. If expiry were a background job, then every minute of job downtime
 * would be a minute of free paid access, and a job that silently stopped would
 * be indistinguishable from a business that was doing well.
 *
 * So expiry is computed, not scheduled: `getEntitlements` calls this on every
 * request. A sweeper that rewrites stale rows is welcome later as HOUSEKEEPING
 * — it must never become the thing that decides.
 * ===========================================================================
 */
export function effectiveStatus(state: SubscriptionState, now: Date): SubscriptionStatus {
  if (state.status === 'expired') return 'expired';
  if (state.status === 'pending') return 'pending';

  // `active`, `past_due` and `cancelled` all depend on the clock. A missing
  // period end on any of them cannot be honoured — a grant with no expiry is a
  // grant forever, so it reads as expired rather than as unlimited.
  if (state.currentPeriodEnd === null) return 'expired';
  return state.currentPeriodEnd.getTime() > now.getTime() ? state.status : 'expired';
}
