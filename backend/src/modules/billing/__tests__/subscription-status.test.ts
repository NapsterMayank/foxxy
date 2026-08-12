import { describe, expect, it } from 'vitest';
import type { PaymentEventKind } from '@/platform/payments/index';
import {
  applyPaymentEvent,
  effectiveStatus,
  type SubscriptionState,
} from '../domain/subscription-status';

/**
 * THE STATE MACHINE. Pure, so every interesting case can be enumerated with no
 * database and no clock of its own.
 *
 * The cases below are chosen for what they PREVENT rather than for coverage:
 * an out-of-order webhook truncating paid access, a replayed event reviving an
 * expired subscription, a new provider event type becoming a 5xx retry loop.
 */

const NOW = new Date('2026-08-10T12:00:00.000Z');
const IN_A_MONTH = new Date('2026-09-09T12:00:00.000Z');
const LAST_MONTH = new Date('2026-07-10T12:00:00.000Z');

function state(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return { status: 'pending', currentPeriodEnd: null, cancelledAt: null, ...overrides };
}

function facts(kind: PaymentEventKind, currentPeriodEnd: Date | null = null, periodDays = 30) {
  return { kind, currentPeriodEnd, now: NOW, periodDays };
}

// ---------------------------------------------------------------------------
// PAYMENT SUCCEEDS
// ---------------------------------------------------------------------------

describe('a successful payment activates', () => {
  it('moves pending to active and takes the event’s period end', () => {
    expect(applyPaymentEvent(state(), facts('subscription.activated', IN_A_MONTH))).toEqual({
      status: 'active',
      currentPeriodEnd: IN_A_MONTH,
      cancelledAt: null,
    });
  });

  it('projects a period end from the plan when the event states none', () => {
    const result = applyPaymentEvent(state(), facts('subscription.charged', null, 30));
    expect(result?.status).toBe('active');
    expect(result?.currentPeriodEnd?.toISOString()).toBe('2026-09-09T12:00:00.000Z');
  });

  it('treats a captured one-off payment as an activation — the YEARLY path', () => {
    // A yearly plan is sold as a one-time order, so its only evidence of payment
    // is `payment.captured`. A billing system that handles only the recurring
    // event silently ignores every annual customer.
    const result = applyPaymentEvent(state(), facts('payment.captured', null, 365));
    expect(result?.status).toBe('active');
    expect(result?.currentPeriodEnd?.toISOString()).toBe('2027-08-10T12:00:00.000Z');
  });

  it('NEVER SHORTENS an existing period end — the out-of-order webhook', () => {
    // A retried charge from three weeks ago carries a period end in the past.
    // Assigning it would truncate a customer's paid access to a date that has
    // already gone, and they would be locked out having just paid.
    const current = state({ status: 'active', currentPeriodEnd: IN_A_MONTH });
    const result = applyPaymentEvent(current, facts('subscription.charged', LAST_MONTH));
    expect(result?.currentPeriodEnd).toEqual(IN_A_MONTH);
  });

  it('clears the cancellation stamp on a reactivation', () => {
    const cancelled = state({
      status: 'cancelled',
      currentPeriodEnd: IN_A_MONTH,
      cancelledAt: NOW,
    });
    const result = applyPaymentEvent(cancelled, facts('subscription.activated', IN_A_MONTH));
    // A row that is both active and cancelled reads as neither.
    expect(result).toEqual({ status: 'active', currentPeriodEnd: IN_A_MONTH, cancelledAt: null });
  });

  it('leaves the period end null when neither the event nor the plan states one', () => {
    const result = applyPaymentEvent(state(), facts('subscription.charged', null, 0));
    // Reported active with no end — which `effectiveStatus` then treats as
    // EXPIRED rather than as unlimited. See its own tests.
    expect(result).toEqual({ status: 'active', currentPeriodEnd: null, cancelledAt: null });
  });
});

// ---------------------------------------------------------------------------
// PAYMENT FAILS
// ---------------------------------------------------------------------------

describe('a failed payment enters the grace period rather than cutting access', () => {
  it('moves active to past_due and keeps the period end', () => {
    const current = state({ status: 'active', currentPeriodEnd: IN_A_MONTH });
    expect(applyPaymentEvent(current, facts('payment.failed'))).toEqual({
      status: 'past_due',
      // NOT extended. The grace is exactly the remainder of the period they
      // already bought, and it lapses on its own with nothing having to run.
      currentPeriodEnd: IN_A_MONTH,
      cancelledAt: null,
    });
  });

  it('a second failure changes nothing — no repeated writes, no reset grace', () => {
    const current = state({ status: 'past_due', currentPeriodEnd: IN_A_MONTH });
    expect(applyPaymentEvent(current, facts('payment.failed'))).toBeNull();
  });
});

describe('a halted subscription ends immediately', () => {
  it('expires with the period end stamped to now', () => {
    // Unlike a cancellation, nothing was paid for the remaining time, so there
    // is nothing to honour. A NULL end here would violate the database CHECK.
    const current = state({ status: 'past_due', currentPeriodEnd: IN_A_MONTH });
    expect(applyPaymentEvent(current, facts('subscription.halted'))).toEqual({
      status: 'expired',
      currentPeriodEnd: NOW,
      cancelledAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// CANCELLATION
// ---------------------------------------------------------------------------

describe('a cancellation keeps the paid period', () => {
  it('retains the existing period end and stamps the cancellation', () => {
    const current = state({ status: 'active', currentPeriodEnd: IN_A_MONTH });
    expect(applyPaymentEvent(current, facts('subscription.cancelled'))).toEqual({
      status: 'cancelled',
      currentPeriodEnd: IN_A_MONTH,
      cancelledAt: NOW,
    });
  });

  it('cancelling something that never activated ends it now', () => {
    expect(applyPaymentEvent(state(), facts('subscription.cancelled'))).toEqual({
      status: 'cancelled',
      currentPeriodEnd: NOW,
      cancelledAt: NOW,
    });
  });

  it('does not overwrite an earlier cancellation stamp', () => {
    const earlier = new Date('2026-08-01T00:00:00.000Z');
    const current = state({
      status: 'cancelled',
      currentPeriodEnd: IN_A_MONTH,
      cancelledAt: earlier,
    });
    expect(applyPaymentEvent(current, facts('subscription.cancelled'))?.cancelledAt).toEqual(
      earlier,
    );
  });
});

// ---------------------------------------------------------------------------
// THE TWO NON-NEGOTIABLE REFUSALS
// ---------------------------------------------------------------------------

describe('an expired subscription is TERMINAL', () => {
  const expired = state({ status: 'expired', currentPeriodEnd: LAST_MONTH });

  it.each<PaymentEventKind>([
    'subscription.activated',
    'subscription.charged',
    'payment.captured',
    'payment.failed',
    'subscription.cancelled',
    'subscription.halted',
  ])('%s cannot revive it', (kind) => {
    // A replayed — or leaked — webhook must not restore access months later. A
    // resubscribe creates a NEW row, which is why the live-slot unique index is
    // partial.
    expect(applyPaymentEvent(expired, facts(kind, IN_A_MONTH))).toBeNull();
  });
});

describe('an event type we do not implement changes nothing', () => {
  it('returns no transition rather than throwing', () => {
    // Throwing would turn a new provider event type into a 5xx the provider
    // retries for hours. The event row is still written by the service, so the
    // history stays complete.
    expect(applyPaymentEvent(state({ status: 'active' }), facts('unknown', IN_A_MONTH))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EXPIRY IS COMPUTED, NEVER SWEPT
// ---------------------------------------------------------------------------

describe('effectiveStatus', () => {
  it('reports a stored `active` with a past period end as EXPIRED', () => {
    // The whole reason no cron job decides expiry: a row saying `active` whose
    // period ended yesterday is a row nobody has revisited.
    expect(effectiveStatus(state({ status: 'active', currentPeriodEnd: LAST_MONTH }), NOW)).toBe(
      'expired',
    );
  });

  it('reports a live period honestly for every granting status', () => {
    for (const status of ['active', 'past_due', 'cancelled'] as const) {
      expect(effectiveStatus(state({ status, currentPeriodEnd: IN_A_MONTH }), NOW)).toBe(status);
    }
  });

  it('treats a NULL period end as expired, not as unlimited', () => {
    // A grant with no expiry is a grant forever. The safe reading of a missing
    // end is "it is over", not "it never ends".
    expect(effectiveStatus(state({ status: 'active', currentPeriodEnd: null }), NOW)).toBe(
      'expired',
    );
  });

  it('leaves pending as pending — it is not about time', () => {
    expect(effectiveStatus(state({ status: 'pending' }), NOW)).toBe('pending');
  });

  it('is exclusive at the boundary: the instant it ends, it has ended', () => {
    expect(effectiveStatus(state({ status: 'active', currentPeriodEnd: NOW }), NOW)).toBe('expired');
  });

  it('stays expired regardless of the clock', () => {
    expect(effectiveStatus(state({ status: 'expired', currentPeriodEnd: IN_A_MONTH }), NOW)).toBe(
      'expired',
    );
  });
});
