import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@/platform/errors/index';
import type { PaymentsPort } from '@/platform/payments/index';
import { createBillingRepository, type BillingRepository } from '../billing.repository';
import { createBillingService, type BillingService } from '../billing.service';
import type { BillingActor, TenantReader } from '../billing.types';
import {
  createBillingTestRateLimiter,
  OTHER_TENANT_ID,
  TEST_TENANT_ID,
  moveToOtherTenant,
  onboard,
  startBillingHarness,
  type BillingHarness,
} from './harness';

/**
 * ============================================================================
 * THE GUARD-MUTATION SUITE — D-125, applied to `billing` before it ships rather
 * than after.
 *
 * A GREEN SUITE PROVES THE ALLOW PATH WORKS. IT SAYS NOTHING ABOUT WHETHER THE
 * DENY PATH IS EVER REACHED. This file is what answers the second question: it
 * BUILDS THE MODULE WITH EACH GUARD DELIBERATELY BROKEN and asserts the break
 * is observable — that with the guard gone, the bad thing actually becomes
 * possible.
 *
 * That distinction is not academic here. Five "enforcement that looked
 * installed and enforced nothing" defects have been found in this codebase, and
 * the most recent — `parent.authoriseSelf` (D-125) — survived an entire suite
 * for the reason that applies EXACTLY to `billing.authoriseSubscription`:
 *
 *   `kind: 'subscription'` is granted on OWNERSHIP alone. For a self-check the
 *   ownership rule is trivially true, so THE TENANT COMPARISON IS THE ONLY
 *   THING THE FUNCTION DOES — and echoing the actor's own tenant back as the
 *   resource tenant turns the whole method into a no-op wearing the shape of a
 *   boundary.
 *
 * `parent`'s version was masked by a second, independent check downstream.
 * Billing has no such second layer: `subscriptions` is billing's own table, and
 * nothing else re-checks. So this file is the only thing standing between that
 * mutation and production.
 *
 * ALSO MUTATED HERE, and for the same reason: the WEBHOOK SIGNATURE. It is the
 * compensating control for the CSRF exemption, so a signature check that
 * verified nothing would leave the endpoint genuinely open — and would leave
 * every "a forged signature is rejected" test green if the fake were the thing
 * saying no.
 * ============================================================================
 *
 * These mutations were ALSO run against the real source, one at a time, with
 * the suite re-run each time. All five went red. The table is in the decision
 * log; this file is what keeps them red.
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

interface Mutations {
  /** D-091: echo the actor's own tenant back as the resource tenant. */
  readonly echoActorTenant?: boolean;
  /** Replace the payments port — used to defeat the signature check. */
  readonly payments?: PaymentsPort;
  /** Replace the repository — used to defeat the replay dedupe. */
  readonly repository?: BillingRepository;
}

/**
 * Builds a billing service with a chosen guard broken.
 *
 * The mutations are installed through the module's INJECTED seams rather than
 * by editing source, so the broken build and the real build differ in exactly
 * one dependency and nothing else.
 */
function serviceWith(mutations: Mutations, actor?: BillingActor): BillingService {
  const readTenantOfUser: TenantReader =
    mutations.echoActorTenant === true
      ? // THE MUTATION. It type-checks perfectly, reads as an optimisation
        // ("the tenant is right there on the actor, why pay for a lookup"),
        // and makes `assertTenantMatch` compare a value with itself.
        (): Promise<string | null> => Promise.resolve(actor?.tenantId ?? TEST_TENANT_ID)
      : (userId): Promise<string | null> => harness.identity.service.getTenantOfUser(userId);

  return createBillingService({
    repository: mutations.repository ?? createBillingRepository(harness.container.poolFor('billing')),
    payments: mutations.payments ?? harness.payments,
    clock: harness.clock,
    logger: harness.logger,
    readTenantOfUser,
    resolvePayer: (subjectUserId) => Promise.resolve({ kind: 'user', id: subjectUserId }),
    audit: harness.audit,
    // D-258 — a real limiter, built exactly as the composition root builds it.
    rateLimiter: createBillingTestRateLimiter(harness.cache, harness.clock, harness.logger),
  });
}

// ---------------------------------------------------------------------------
// MUTATION 1 — the tenant echoed off the actor (D-091 / D-125)
// ---------------------------------------------------------------------------

describe('MUTATION: the resource tenant is echoed off the actor', () => {
  it('the REAL guard denies an actor claiming a tenant their row does not have', async () => {
    const account = await onboard(harness);
    // The row moves; the actor keeps claiming the old tenant.
    await moveToOtherTenant(harness, account.userId);

    await expect(
      harness.billing.service.getEntitlements(actorOf(account.userId), account.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('THE MUTATED GUARD ALLOWS IT — so the real one is load-bearing', async () => {
    const account = await onboard(harness);
    await moveToOtherTenant(harness, account.userId);
    const actor = actorOf(account.userId, TEST_TENANT_ID);

    const mutated = serviceWith({ echoActorTenant: true }, actor);

    /**
     * WITH THE MUTATION, THE READ SUCCEEDS.
     *
     * This is the assertion that makes the test above mean something. Without
     * it, "the guard denies" could be true because of any layer — and billing
     * has no second layer, which is precisely why this had to be checked rather
     * than assumed.
     */
    await expect(mutated.getEntitlements(actor, account.userId)).resolves.toMatchObject({
      planCode: 'free',
    });
  });

  it('the SAME-TENANT control still passes, so the assertion is about the tenant', async () => {
    // Without this control, the deny above could be explained by anything —
    // a missing account, a broken reader, a typo in the id. It passes here and
    // denies above, and the only difference is the tenant.
    const account = await onboard(harness);
    await expect(
      harness.billing.service.getEntitlements(actorOf(account.userId), account.userId),
    ).resolves.toMatchObject({ planCode: 'free' });
  });

  it('the deny is byte-identical for a foreign tenant and for an unknown account', async () => {
    const account = await onboard(harness);
    await moveToOtherTenant(harness, account.userId);

    const foreign = await harness.billing.service
      .getEntitlements(actorOf(account.userId), account.userId)
      .catch((error: unknown) => error);
    const unknown = await harness.billing.service
      .getEntitlements(
        actorOf(account.userId, OTHER_TENANT_ID),
        '99999999-9999-4999-8999-999999999999',
      )
      .catch((error: unknown) => error);

    // Both `ForbiddenError`, both with the fixed safe message. A distinguishable
    // answer would tell an attacker which account ids exist.
    expect(foreign).toBeInstanceOf(ForbiddenError);
    expect(unknown).toBeInstanceOf(ForbiddenError);
    expect((foreign as ForbiddenError).safeMessage).toBe((unknown as ForbiddenError).safeMessage);
  });
});

// ---------------------------------------------------------------------------
// MUTATION 2 — the signature check verifies nothing
// ---------------------------------------------------------------------------

describe('MUTATION: the webhook signature check accepts everything', () => {
  /** A payments port whose `verifyWebhook` never looks at the signature. */
  function credulousPayments(providerSubscriptionId: string): PaymentsPort {
    return {
      ...harness.payments,
      verifyWebhook: (delivery) => ({
        providerEventId: delivery.eventId ?? 'forged',
        kind: 'subscription.cancelled',
        providerEventName: 'subscription.cancelled',
        providerSubscriptionId,
        currentPeriodEnd: null,
        payload: { forged: true },
      }),
    };
  }

  async function activated(): Promise<{ actor: BillingActor; providerSubscriptionId: string }> {
    const account = await onboard(harness);
    const actor = actorOf(account.userId);
    await harness.billing.service.createSubscription(actor, 'monthly');
    await harness.billing.service.handleWebhook(
      harness.payments.delivery({
        id: 'evt_setup',
        event: 'subscription.activated',
        subscriptionId: 'sub_fake_1',
        currentPeriodEnd: '2026-09-09T09:00:00.000Z',
      }),
    );
    return { actor, providerSubscriptionId: 'sub_fake_1' };
  }

  it('the REAL check refuses a forged delivery and changes nothing', async () => {
    const { actor } = await activated();

    const outcome = await harness.billing.service.handleWebhook({
      rawBody: JSON.stringify({ id: 'x', event: 'subscription.cancelled', subscriptionId: 'sub_fake_1' }),
      signature: 'f'.repeat(64),
      eventId: 'evt_forged',
    });

    expect(outcome).toEqual({ result: 'rejected' });
    expect((await harness.billing.service.getEntitlements(actor, actor.userId)).isPaid).toBe(true);
  });

  it('THE MUTATED CHECK LETS AN ANONYMOUS ATTACKER CANCEL A STRANGER’S SUBSCRIPTION', async () => {
    const { actor, providerSubscriptionId } = await activated();

    const mutated = serviceWith({ payments: credulousPayments(providerSubscriptionId) });
    const outcome = await mutated.handleWebhook({
      rawBody: '{"anything":true}',
      signature: 'not even a signature',
      eventId: 'evt_forged',
    });

    /**
     * THE POINT OF THE WHOLE FILE, IN ONE ASSERTION.
     *
     * The webhook endpoint is exempt from the CSRF origin check and carries no
     * session. With the signature verifying nothing, anybody on the internet
     * can post four bytes and terminate a paying customer's subscription. The
     * HMAC is not a formality; it is the only thing on that door.
     */
    expect(outcome).toEqual({ result: 'processed', changed: true });
    const status = await harness.billing.service.getSubscriptionStatus(actor, actor.userId);
    expect(status.subscription?.status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// MUTATION 3 — the replay defence
// ---------------------------------------------------------------------------

describe('MUTATION: the deduplication insert always reports success', () => {
  it('the REAL constraint makes a replayed charge a no-op', async () => {
    const account = await onboard(harness);
    const actor = actorOf(account.userId);
    await harness.billing.service.createSubscription(actor, 'monthly');

    const activate = harness.payments.delivery({
      id: 'evt_a',
      event: 'subscription.activated',
      subscriptionId: 'sub_fake_1',
      currentPeriodEnd: '2026-09-09T09:00:00.000Z',
    });
    await harness.billing.service.handleWebhook(activate);

    const replayed = harness.payments.delivery({
      id: 'evt_b',
      event: 'subscription.charged',
      subscriptionId: 'sub_fake_1',
      currentPeriodEnd: '2026-10-09T09:00:00.000Z',
    });
    await harness.billing.service.handleWebhook(replayed);
    await harness.billing.service.handleWebhook(replayed);
    await harness.billing.service.handleWebhook(replayed);

    const status = await harness.billing.service.getSubscriptionStatus(actor, actor.userId);
    // Three deliveries of one charge bought ONE period, not three.
    expect(status.subscription?.currentPeriodEnd).toBe('2026-10-09T09:00:00.000Z');
  });

  it('THE MUTATED GATE APPLIES A REPLAY AGAIN — free access, one period per replay', async () => {
    const account = await onboard(harness);
    const actor = actorOf(account.userId);
    await harness.billing.service.createSubscription(actor, 'monthly');
    await harness.billing.service.handleWebhook(
      harness.payments.delivery({
        id: 'evt_a',
        event: 'subscription.activated',
        subscriptionId: 'sub_fake_1',
        currentPeriodEnd: '2026-09-09T09:00:00.000Z',
      }),
    );

    const base = createBillingRepository(harness.container.poolFor('billing'));
    const mutated = serviceWith({
      repository: {
        ...base,
        // The mutation: the gate always says "this is new".
        insertPaymentEvent: () => Promise.resolve(true),
      },
    });

    // A charge with a LATER period end, replayed. With the gate defeated, the
    // second application is accepted rather than recognised as a duplicate.
    const replayed = harness.payments.delivery({
      id: 'evt_replay',
      event: 'subscription.charged',
      subscriptionId: 'sub_fake_1',
      currentPeriodEnd: '2027-01-09T09:00:00.000Z',
    });

    const first = await mutated.handleWebhook(replayed);
    const second = await mutated.handleWebhook(replayed);

    expect(first).toEqual({ result: 'processed', changed: true });
    // The REAL service answers `duplicate` here. The mutated one processes it
    // again — which is what a provider's retry storm would turn into free
    // access, one period at a time.
    expect(second).toEqual({ result: 'processed', changed: true });
  });
});
