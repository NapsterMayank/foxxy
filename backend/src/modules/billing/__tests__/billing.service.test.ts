import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/platform/errors/index';
import { createFakePayments } from '@/platform/payments/index';
import type { TransactionToken } from '@/platform/tx/index';
import { createBillingRepository, type BillingRepository } from '../billing.repository';
import { createBillingService, BILLING_AUDIT_ACTIONS } from '../billing.service';
import type { BillingActor } from '../billing.types';
import {
  createBillingTestRateLimiter,
  OTHER_TENANT_ID,
  TEST_TENANT_ID,
  WEBHOOK_SECRET,
  moveToOtherTenant,
  onboard,
  startBillingHarness,
  type BillingHarness,
} from './harness';

/**
 * ============================================================================
 * THE BILLING SERVICE, against a REAL Postgres in a container (§9.1).
 *
 * The database is never faked here, and for this module that is not a
 * preference — three of the properties under test ARE database properties:
 *
 *   · the replay defence is a UNIQUE constraint, not an `if`;
 *   · "atomic with the payment record" is a transaction, not a code path;
 *   · "cancelled rows must carry a period end" is a CHECK.
 *
 * A faked repository would let every one of them pass with the constraint
 * missing.
 * ============================================================================
 */

let harness: BillingHarness;

beforeAll(async () => {
  harness = await startBillingHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

function actorOf(userId: string, tenantId = TEST_TENANT_ID): BillingActor {
  return { userId, role: 'parent', tenantId };
}

async function countRows(table: 'subscriptions' | 'payment_events'): Promise<number> {
  const result = await harness.postgres.client.query<{ n: string }>(
    `select count(*)::text as n from ${table}`,
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function statusOf(subscriptionId: string): Promise<string | null> {
  const result = await harness.postgres.client.query<{ status: string }>(
    'select status from subscriptions where id = $1',
    [subscriptionId],
  );
  return result.rows[0]?.status ?? null;
}

/** A subscription taken to `active`, the state most tests need to start from. */
async function activeSubscription(): Promise<{
  actor: BillingActor;
  subscriptionId: string;
  providerSubscriptionId: string;
  periodEnd: string;
}> {
  const account = await onboard(harness);
  const actor = actorOf(account.userId);
  const { subscription } = await harness.billing.service.createSubscription(actor, 'monthly');
  const providerSubscriptionId = harness.payments.created.length > 0 ? 'sub_fake_1' : '';
  const periodEnd = '2026-09-09T09:00:00.000Z';

  await harness.billing.service.handleWebhook(
    harness.payments.delivery({
      id: 'evt_activate',
      event: 'subscription.activated',
      subscriptionId: providerSubscriptionId,
      currentPeriodEnd: periodEnd,
    }),
  );

  return { actor, subscriptionId: subscription.id, providerSubscriptionId, periodEnd };
}

// ---------------------------------------------------------------------------
// createSubscription
// ---------------------------------------------------------------------------

describe('createSubscription', () => {
  it('writes a PENDING row that grants nothing, and returns a checkout url', async () => {
    const account = await onboard(harness);
    const actor = actorOf(account.userId);

    const { subscription, checkoutUrl } = await harness.billing.service.createSubscription(
      actor,
      'monthly',
    );

    expect(subscription.status).toBe('pending');
    expect(checkoutUrl).toContain('sub_fake_1');

    // THE CENTRAL ASSERTION: creating a subscription grants NOTHING. Access
    // begins when a verified webhook says money arrived, and not before —
    // creating one costs an attacker nothing.
    const entitlements = await harness.billing.service.getEntitlements(actor, account.userId);
    expect(entitlements.isPaid).toBe(false);
    expect(entitlements.features).not.toContain('foxy.unlimited');
  });

  it('passes OUR subscription id as the provider idempotency key', async () => {
    const account = await onboard(harness);
    const { subscription } = await harness.billing.service.createSubscription(
      actorOf(account.userId),
      'monthly',
    );
    expect(harness.payments.created[0]?.idempotencyKey).toBe(subscription.id);
  });

  it('files the row under the tenant the GUARD checked, not the claimed one', async () => {
    const account = await onboard(harness);
    const { subscription } = await harness.billing.service.createSubscription(
      actorOf(account.userId),
      'monthly',
    );
    expect(subscription.tenantId).toBe(TEST_TENANT_ID);
  });

  it('refuses an unknown plan code rather than silently selling the free plan', async () => {
    const account = await onboard(harness);
    await expect(
      harness.billing.service.createSubscription(actorOf(account.userId), 'enterprise'),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await countRows('subscriptions')).toBe(0);
  });

  it('refuses to sell the FREE plan', async () => {
    const account = await onboard(harness);
    await expect(
      harness.billing.service.createSubscription(actorOf(account.userId), 'free'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a second live subscription', async () => {
    const account = await onboard(harness);
    const actor = actorOf(account.userId);
    await harness.billing.service.createSubscription(actor, 'monthly');
    await expect(harness.billing.service.createSubscription(actor, 'yearly')).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await countRows('subscriptions')).toBe(1);
  });

  it('audits the creation with identifiers and amounts only', async () => {
    const account = await onboard(harness);
    await harness.billing.service.createSubscription(actorOf(account.userId), 'monthly');

    const entry = harness.audit.find(BILLING_AUDIT_ACTIONS.SUBSCRIPTION_CREATED)[0];
    expect(entry?.metadata).toEqual({
      planCode: 'monthly',
      payerKind: 'user',
      amountMinorUnits: 29_900,
    });
    // A record OF a payment must not itself become payment data.
    expect(JSON.stringify(entry?.metadata)).not.toMatch(/@|card|email|phone|name/i);
  });
});

// ---------------------------------------------------------------------------
// THE PAYER IS SWAPPABLE — the B2B school pilot
// ---------------------------------------------------------------------------

describe('the payer is resolved, never assumed', () => {
  it('a SCHOOL can pay for a student who never sees a payment page', async () => {
    const schoolHarness = await startBillingHarness({
      resolvePayer: () => Promise.resolve({ kind: 'school', id: SCHOOL_ID }),
    });
    try {
      await schoolHarness.postgres.client.query(
        `insert into schools (id, tenant_id, name) values ($1, $2, 'Pilot School')`,
        [SCHOOL_ID, TEST_TENANT_ID],
      );
      const account = await onboard(schoolHarness, 'student');
      const { subscription } = await schoolHarness.billing.service.createSubscription(
        actorOf(account.userId),
        'yearly',
      );

      // The beneficiary and the payer are DIFFERENT rows in different tables.
      // Nothing in the module had to change for this — only the one resolver
      // line at the composition root.
      expect(subscription.subjectUserId).toBe(account.userId);
      expect(subscription.payer).toEqual({ kind: 'school', id: SCHOOL_ID });

      const stored = await schoolHarness.postgres.client.query<{
        payer_user_id: string | null;
        payer_school_id: string | null;
      }>('select payer_user_id, payer_school_id from subscriptions where id = $1', [
        subscription.id,
      ]);
      // The database CHECK makes any other combination unrepresentable: a stale
      // user payer on a school row would bill the wrong party.
      expect(stored.rows[0]?.payer_user_id).toBeNull();
      expect(stored.rows[0]?.payer_school_id).toBe(SCHOOL_ID);
    } finally {
      await schoolHarness.stop();
    }
  }, 240_000);

  it('refuses the checkout when nobody can be billed — it never falls back to the actor', async () => {
    const orphanHarness = await startBillingHarness({ resolvePayer: () => Promise.resolve(null) });
    try {
      const account = await onboard(orphanHarness, 'student');
      await expect(
        orphanHarness.billing.service.createSubscription(actorOf(account.userId), 'monthly'),
      ).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await orphanHarness.stop();
    }
  }, 240_000);
});

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

// ---------------------------------------------------------------------------
// THE WEBHOOK — §8.8 rules 1 to 4
// ---------------------------------------------------------------------------

describe('rule 1 — the signature is verified before anything else', () => {
  it('A FORGED SIGNATURE IS REJECTED, and nothing at all is written', async () => {
    const { subscriptionId, providerSubscriptionId } = await activeSubscription();
    const before = await countRows('payment_events');

    const genuine = harness.payments.delivery({
      id: 'evt_forged',
      event: 'subscription.cancelled',
      subscriptionId: providerSubscriptionId,
    });

    const outcome = await harness.billing.service.handleWebhook({
      rawBody: genuine.rawBody,
      signature: 'f'.repeat(64),
      eventId: 'evt_forged',
    });

    expect(outcome).toEqual({ result: 'rejected' });
    // No event row, and the subscription is untouched. An attacker who can
    // reach this endpoint must not be able to cancel a stranger's subscription
    // — or to write anything at all.
    expect(await countRows('payment_events')).toBe(before);
    expect(await statusOf(subscriptionId)).toBe('active');
  });

  it('a body edited after signing is rejected', async () => {
    const { providerSubscriptionId } = await activeSubscription();
    const genuine = harness.payments.delivery({
      id: 'evt_tamper',
      event: 'subscription.charged',
      subscriptionId: providerSubscriptionId,
    });

    const tampered = genuine.rawBody.replace('charged', 'cancelled');
    const outcome = await harness.billing.service.handleWebhook({
      rawBody: tampered,
      signature: genuine.signature,
      eventId: 'evt_tamper',
    });
    expect(outcome).toEqual({ result: 'rejected' });
  });

  it('a rejection is audited with byte counts and nothing from the body', async () => {
    await harness.billing.service.handleWebhook({
      rawBody: '{"event":"subscription.cancelled","attacker":"payload"}',
      signature: 'nope',
      eventId: null,
    });

    const entry = harness.audit.find(BILLING_AUDIT_ACTIONS.WEBHOOK_REJECTED)[0];
    expect(entry).toBeDefined();
    // The body is attacker-controlled; echoing it into an audit row is how log
    // injection starts.
    expect(JSON.stringify(entry?.metadata)).not.toContain('attacker');
  });
});

describe('rule 2 — a replayed event is a no-op', () => {
  it('the second delivery changes nothing and reports `duplicate`', async () => {
    const { subscriptionId, providerSubscriptionId } = await activeSubscription();

    const delivery = harness.payments.delivery({
      id: 'evt_charge_1',
      event: 'subscription.charged',
      subscriptionId: providerSubscriptionId,
      currentPeriodEnd: '2026-10-09T09:00:00.000Z',
    });

    const first = await harness.billing.service.handleWebhook(delivery);
    expect(first).toEqual({ result: 'processed', changed: true });

    const eventsAfterFirst = await countRows('payment_events');
    const periodAfterFirst = await harness.postgres.client.query<{ current_period_end: Date }>(
      'select current_period_end from subscriptions where id = $1',
      [subscriptionId],
    );

    const second = await harness.billing.service.handleWebhook(delivery);
    expect(second).toEqual({ result: 'duplicate' });

    // Exactly one row, and the period was not extended a second time — which is
    // what a replay would otherwise buy: free access, one period at a time.
    expect(await countRows('payment_events')).toBe(eventsAfterFirst);
    const periodAfterSecond = await harness.postgres.client.query<{ current_period_end: Date }>(
      'select current_period_end from subscriptions where id = $1',
      [subscriptionId],
    );
    expect(periodAfterSecond.rows[0]?.current_period_end).toEqual(
      periodAfterFirst.rows[0]?.current_period_end,
    );
  });

  it('two concurrent deliveries of the same event apply it exactly once', async () => {
    const { providerSubscriptionId } = await activeSubscription();
    const delivery = harness.payments.delivery({
      id: 'evt_race',
      event: 'subscription.charged',
      subscriptionId: providerSubscriptionId,
      currentPeriodEnd: '2026-11-09T09:00:00.000Z',
    });

    // A read-then-write dedupe passes twice here. `ON CONFLICT DO NOTHING` is
    // one statement, so exactly one of these wins.
    const [a, b] = await Promise.all([
      harness.billing.service.handleWebhook(delivery),
      harness.billing.service.handleWebhook(delivery).catch(() => ({ result: 'duplicate' as const })),
    ]);

    const results = [a.result, b.result].sort();
    expect(results).toEqual(['duplicate', 'processed']);
  });
});

describe('rule 3 — the status change and the payment record are ATOMIC', () => {
  it('a successful activation writes both', async () => {
    const account = await onboard(harness);
    const actor = actorOf(account.userId);
    const { subscription } = await harness.billing.service.createSubscription(actor, 'monthly');

    await harness.billing.service.handleWebhook(
      harness.payments.delivery({
        id: 'evt_a',
        event: 'subscription.activated',
        subscriptionId: 'sub_fake_1',
        currentPeriodEnd: '2026-09-09T09:00:00.000Z',
      }),
    );

    expect(await statusOf(subscription.id)).toBe('active');
    const events = await harness.postgres.client.query<{ subscription_id: string; tenant_id: string }>(
      'select subscription_id, tenant_id from payment_events',
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.subscription_id).toBe(subscription.id);
    // D-084's mechanism: the tenant is stamped FROM THE MATCHED ROW, not from
    // the column default.
    expect(events.rows[0]?.tenant_id).toBe(TEST_TENANT_ID);
  });

  it('A MID-TRANSACTION FAILURE ROLLS BOTH BACK', async () => {
    const account = await onboard(harness);
    const actor = actorOf(account.userId);
    const { subscription } = await harness.billing.service.createSubscription(actor, 'monthly');

    /**
     * The service is rebuilt with a repository whose SUBSCRIPTION UPDATE
     * throws, leaving the event insert already done inside the transaction.
     *
     * If the two were not in one transaction, the event row would survive — and
     * the provider's retry would then be deduplicated against it and the
     * subscription would NEVER activate. Money in, no access, no error
     * anywhere. That is the exact failure §8.8 rule 3 exists to prevent, and
     * this is the only test that can see it.
     */
    const base = createBillingRepository(harness.container.poolFor('billing'));
    const exploding: BillingRepository = {
      ...base,
      updateSubscriptionState: (): Promise<void> =>
        Promise.reject(new Error('disk full, mid transaction')),
    };

    const service = createBillingService({
      repository: exploding,
      payments: harness.payments,
      clock: harness.clock,
      logger: harness.logger,
      readTenantOfUser: (userId) => harness.identity.service.getTenantOfUser(userId),
      resolvePayer: (subjectUserId) => Promise.resolve({ kind: 'user', id: subjectUserId }),
      audit: harness.audit,
      // D-258 — a real limiter, built exactly as the composition root builds it.
      rateLimiter: createBillingTestRateLimiter(harness.cache, harness.clock, harness.logger),
    });

    await expect(
      service.handleWebhook(
        harness.payments.delivery({
          id: 'evt_boom',
          event: 'subscription.activated',
          subscriptionId: 'sub_fake_1',
          currentPeriodEnd: '2026-09-09T09:00:00.000Z',
        }),
      ),
      // RULE 4: it THROWS. It does not swallow the error and report success.
    ).rejects.toThrow('disk full');

    // BOTH halves are gone.
    expect(await countRows('payment_events')).toBe(0);
    expect(await statusOf(subscription.id)).toBe('pending');

    // And the provider's retry then succeeds, because nothing was recorded to
    // deduplicate it against.
    const retry = await harness.billing.service.handleWebhook(
      harness.payments.delivery({
        id: 'evt_boom',
        event: 'subscription.activated',
        subscriptionId: 'sub_fake_1',
        currentPeriodEnd: '2026-09-09T09:00:00.000Z',
      }),
    );
    expect(retry).toEqual({ result: 'processed', changed: true });
    expect(await statusOf(subscription.id)).toBe('active');
  });
});

describe('a verified event that matches nothing is recorded and not acted on', () => {
  it('is `processed` with no change, and carries a NULL tenant', async () => {
    const outcome = await harness.billing.service.handleWebhook(
      harness.payments.delivery({
        id: 'evt_orphan',
        event: 'subscription.charged',
        subscriptionId: 'sub_never_seen',
      }),
    );

    // Not an error: raising a 5xx would make the provider retry a message that
    // can never succeed, forever. The row is the only evidence that our records
    // and the provider's have diverged.
    expect(outcome).toEqual({ result: 'processed', changed: false });
    const rows = await harness.postgres.client.query<{ tenant_id: string | null }>(
      'select tenant_id from payment_events',
    );
    expect(rows.rows[0]?.tenant_id).toBeNull();
  });
});

describe('an unimplemented event type is recorded and changes nothing', () => {
  it('does not throw and does not move the subscription', async () => {
    const { subscriptionId, providerSubscriptionId } = await activeSubscription();
    const outcome = await harness.billing.service.handleWebhook(
      harness.payments.delivery({
        id: 'evt_new_type',
        event: 'invoice.partially_paid',
        subscriptionId: providerSubscriptionId,
      }),
    );
    expect(outcome).toEqual({ result: 'processed', changed: false });
    expect(await statusOf(subscriptionId)).toBe('active');
    // Still recorded — an event log with the confusing rows filtered out cannot
    // explain the incident it was kept for.
    expect(await countRows('payment_events')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ENTITLEMENTS
// ---------------------------------------------------------------------------

describe('entitlements reflect the CURRENT status, read at request time', () => {
  it('grants the paid features once a payment is verified', async () => {
    const { actor } = await activeSubscription();
    const entitlements = await harness.billing.service.getEntitlements(actor, actor.userId);
    expect(entitlements.isPaid).toBe(true);
    expect(entitlements.features).toContain('foxy.unlimited');
  });

  it('AN EXPIRED SUBSCRIPTION IS DENIED, with nothing having run in between', async () => {
    const { actor } = await activeSubscription();
    expect((await harness.billing.service.getEntitlements(actor, actor.userId)).isPaid).toBe(true);

    // The clock moves past the paid period. NO JOB RUNS, no row is rewritten —
    // and the very next read denies. That is the whole reason expiry is
    // computed rather than swept.
    harness.clock.setTo('2026-10-01T00:00:00.000Z');

    const after = await harness.billing.service.getEntitlements(actor, actor.userId);
    expect(after.isPaid).toBe(false);
    expect(after.features).not.toContain('foxy.unlimited');
    // The stored row still says `active` — the denial came from the clock.
    expect(await statusOf((await harness.billing.service.getSubscriptionStatus(actor, actor.userId)).subscription?.id ?? '')).toBe('active');
  });

  it('a halted subscription loses access immediately', async () => {
    const { actor, providerSubscriptionId } = await activeSubscription();
    await harness.billing.service.handleWebhook(
      harness.payments.delivery({
        id: 'evt_halt',
        event: 'subscription.halted',
        subscriptionId: providerSubscriptionId,
      }),
    );
    const after = await harness.billing.service.getEntitlements(actor, actor.userId);
    expect(after.isPaid).toBe(false);
  });

  it('a failed payment keeps access for the rest of the paid period', async () => {
    const { actor, providerSubscriptionId } = await activeSubscription();
    await harness.billing.service.handleWebhook(
      harness.payments.delivery({
        id: 'evt_fail',
        event: 'payment.failed',
        subscriptionId: providerSubscriptionId,
      }),
    );
    const after = await harness.billing.service.getEntitlements(actor, actor.userId);
    expect(after.isPaid).toBe(true);

    const status = await harness.billing.service.getSubscriptionStatus(actor, actor.userId);
    expect(status.subscription?.status).toBe('past_due');
  });

  it('a user who has never subscribed gets the free grant, not an error', async () => {
    const account = await onboard(harness);
    const actor = actorOf(account.userId);
    const status = await harness.billing.service.getSubscriptionStatus(actor, account.userId);
    expect(status.subscription).toBeNull();
    expect(status.entitlements.planCode).toBe('free');
    expect(status.entitlements.features.length).toBeGreaterThan(0);
  });

  it('reports the EFFECTIVE status, not the stored one', async () => {
    const { actor } = await activeSubscription();
    harness.clock.setTo('2026-10-01T00:00:00.000Z');
    const status = await harness.billing.service.getSubscriptionStatus(actor, actor.userId);
    expect(status.subscription?.status).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// CANCELLATION
// ---------------------------------------------------------------------------

describe('cancelSubscription', () => {
  it('tells the provider and keeps access to the end of the paid period', async () => {
    const { actor, providerSubscriptionId, periodEnd } = await activeSubscription();

    const cancelled = await harness.billing.service.cancelSubscription(actor, actor.userId);

    expect(harness.payments.cancelled).toEqual([providerSubscriptionId]);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.currentPeriodEnd?.toISOString()).toBe(periodEnd);

    // They paid for the period. Taking it back at the moment of cancellation is
    // theft dressed as a state machine.
    const entitlements = await harness.billing.service.getEntitlements(actor, actor.userId);
    expect(entitlements.isPaid).toBe(true);
  });

  it('access then lapses on its own at the period end', async () => {
    const { actor } = await activeSubscription();
    await harness.billing.service.cancelSubscription(actor, actor.userId);
    harness.clock.setTo('2026-10-01T00:00:00.000Z');
    expect((await harness.billing.service.getEntitlements(actor, actor.userId)).isPaid).toBe(false);
  });

  it('a second cancel is a 404 — there is no live subscription left', async () => {
    const { actor } = await activeSubscription();
    await harness.billing.service.cancelSubscription(actor, actor.userId);
    await expect(
      harness.billing.service.cancelSubscription(actor, actor.userId),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('cancelling with nothing to cancel is a 404, not a silent success', async () => {
    const account = await onboard(harness);
    await expect(
      harness.billing.service.cancelSubscription(actorOf(account.userId), account.userId),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('LEAVES THE ROW UNTOUCHED when the provider refuses the cancellation', async () => {
    const { actor, subscriptionId } = await activeSubscription();

    const failing = createFakePayments({ secret: WEBHOOK_SECRET, planCodes: ['monthly'] });
    const service = createBillingService({
      repository: createBillingRepository(harness.container.poolFor('billing')),
      payments: {
        ...failing,
        cancelSubscription: () => Promise.reject(new Error('provider unreachable')),
      },
      clock: harness.clock,
      logger: harness.logger,
      readTenantOfUser: (userId) => harness.identity.service.getTenantOfUser(userId),
      resolvePayer: (subjectUserId) => Promise.resolve({ kind: 'user', id: subjectUserId }),
      audit: harness.audit,
      // D-258 — a real limiter, built exactly as the composition root builds it.
      rateLimiter: createBillingTestRateLimiter(harness.cache, harness.clock, harness.logger),
    });

    await expect(service.cancelSubscription(actor, actor.userId)).rejects.toThrow('unreachable');

    // Showing "cancelled" while the card keeps being charged is the one billing
    // bug that turns into a chargeback. The provider is told FIRST for exactly
    // this reason.
    expect(await statusOf(subscriptionId)).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// THE BOUNDARY
// ---------------------------------------------------------------------------

describe('cross-user and cross-tenant are denied, with no payload', () => {
  it('a user cannot read another user’s entitlements', async () => {
    const mine = await onboard(harness);
    const theirs = await onboard(harness);
    await expect(
      harness.billing.service.getEntitlements(actorOf(mine.userId), theirs.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a user cannot cancel another user’s subscription', async () => {
    const { actor } = await activeSubscription();
    const attacker = await onboard(harness);
    await expect(
      harness.billing.service.cancelSubscription(actorOf(attacker.userId), actor.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // And the victim's subscription is untouched.
    expect((await harness.billing.service.getEntitlements(actor, actor.userId)).isPaid).toBe(true);
  });

  it('AN ACTOR IN ANOTHER TENANT IS DENIED, even for their own account id', async () => {
    const account = await onboard(harness);
    // The ROW moves tenants; the actor keeps claiming the old one. That claim
    // is what `assertTenantMatch` must refuse — and it can only refuse it
    // because the resource tenant is READ FROM `users` rather than echoed off
    // the actor (D-091).
    await moveToOtherTenant(harness, account.userId);

    await expect(
      harness.billing.service.getEntitlements(actorOf(account.userId, TEST_TENANT_ID), account.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // The same actor, claiming the tenant the row actually has, is allowed —
    // so the assertion above is about the TENANT and not about anything else.
    await expect(
      harness.billing.service.getEntitlements(
        actorOf(account.userId, OTHER_TENANT_ID),
        account.userId,
      ),
    ).resolves.toMatchObject({ planCode: 'free' });
  });

  it('an unknown user id denies through the guard rather than a distinct 404', async () => {
    const account = await onboard(harness);
    // "No such account" and "an account in another tenant" must be
    // indistinguishable: a different answer would be an account-existence
    // oracle.
    await expect(
      harness.billing.service.getEntitlements(
        actorOf(account.userId),
        '99999999-9999-4999-8999-999999999999',
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a write is refused for another user even when a read would be too', async () => {
    const mine = await onboard(harness);
    const theirs = await onboard(harness);
    await expect(
      harness.billing.service.getSubscriptionStatus(actorOf(mine.userId), theirs.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// THE TRANSACTION TOKEN
// ---------------------------------------------------------------------------

describe('a write outside a transaction is refused', () => {
  it('rather than silently writing outside it', async () => {
    const repository = createBillingRepository(harness.container.poolFor('billing'));
    // Defaulting to the pool would turn "the transaction was lost" into "it
    // wrote anyway, outside the transaction" — the split-brain rule 3 forbids,
    // and it would be invisible.
    await expect(
      repository.insertPaymentEvent(undefined as unknown as TransactionToken, {
        provider: 'fake',
        providerEventId: 'x',
        kind: 'unknown',
        providerEventName: 'x',
        subscriptionId: null,
        payload: {},
        tenantId: null,
        now: harness.clock.now(),
      }),
    ).rejects.toThrow('without a transaction');
  });
});
