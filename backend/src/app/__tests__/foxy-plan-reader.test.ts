import { describe, expect, it } from 'vitest';
import type { Actor } from '@/platform/authz/index';
import { resolveEntitlements } from '@/modules/billing/index';
import { FOXY_DAILY_MESSAGE_LIMIT } from '@/shared/constants/foxy';
import type { Entitlements } from '@/shared/contracts/billing.contract';
import { createFoxyPlanReader } from '../routes';

/**
 * ============================================================================
 * D-257 — THE COMPOSITION-ROOT EDGE THAT GAVE PAYING CUSTOMERS THE FREE TIER.
 *
 * `app/routes.ts` wired `foxy`'s `readPlan` to `() => Promise.resolve(null)`
 * under a comment saying "billing is build step 13". Build step 13 shipped and
 * the line did not change, so every plan-gated decision inside `foxy` resolved
 * to `free` forever: somebody who paid received the 20-message daily cap.
 *
 * NOTHING FAILED. The stand-in was a valid `PlanReader`, `foxy`'s own tests all
 * passed against it, and the only observable symptom was a support ticket from
 * a customer who had been charged.
 *
 * ----------------------------------------------------------------------------
 * THE ENTITLEMENTS HERE ARE REAL, NOT HAND-WRITTEN.
 *
 * Every case below builds its `Entitlements` by calling billing's own
 * `resolveEntitlements` against a subscription row and an explicit instant.
 * A literal `{ features: ['foxy.unlimited'] }` would prove only that the reader
 * can read an array somebody typed in this file — it would keep passing if
 * billing decided tomorrow that an expired subscription still grants its
 * features, which is the half of this behaviour most worth pinning.
 *
 * THE CLOCK IS A VALUE, PASSED IN. There is no `new Date()` and no `sleep`:
 * "expired" is expressed as a period end BEFORE `NOW`, which is arithmetic
 * rather than waiting.
 * ============================================================================
 */

const NOW = new Date('2026-08-11T09:00:00.000Z');
const LAST_MONTH = new Date('2026-07-11T09:00:00.000Z');
const NEXT_MONTH = new Date('2026-09-11T09:00:00.000Z');

const ACTOR: Actor = {
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'student',
  tenantId: '22222222-2222-4222-8222-222222222222',
};

/** A stub `getEntitlements` that records what it was asked, and by whom. */
function billingReturning(entitlements: Entitlements): {
  readonly service: { getEntitlements(actor: Actor, subjectUserId: string): Promise<Entitlements> };
  readonly calls: { actor: Actor; subjectUserId: string }[];
} {
  const calls: { actor: Actor; subjectUserId: string }[] = [];
  return {
    service: {
      getEntitlements(actor: Actor, subjectUserId: string): Promise<Entitlements> {
        calls.push({ actor, subjectUserId });
        return Promise.resolve(entitlements);
      },
    },
    calls,
  };
}

describe('the foxy plan reader resolves a plan from billing', () => {
  it('gives a live subscriber the PAID daily allowance', async () => {
    const entitlements = resolveEntitlements({
      subscription: {
        status: 'active',
        currentPeriodEnd: NEXT_MONTH,
        cancelledAt: null,
        planCode: 'monthly',
      },
      now: NOW,
    });
    const billing = billingReturning(entitlements);

    const plan = await createFoxyPlanReader(() => billing.service)(ACTOR, ACTOR.userId);

    expect(plan).toBe('plus');
    // The number a paying customer is actually buying. Asserted through the
    // same table `foxy` reads, so a plan that resolves correctly and then maps
    // to the wrong allowance still fails here.
    expect(FOXY_DAILY_MESSAGE_LIMIT[plan]).toBe(FOXY_DAILY_MESSAGE_LIMIT.plus);
    expect(FOXY_DAILY_MESSAGE_LIMIT[plan]).toBeGreaterThan(FOXY_DAILY_MESSAGE_LIMIT.free);
  });

  it('gives an account with NO subscription the free allowance', async () => {
    const entitlements = resolveEntitlements({ subscription: null, now: NOW });
    const billing = billingReturning(entitlements);

    const plan = await createFoxyPlanReader(() => billing.service)(ACTOR, ACTOR.userId);

    expect(plan).toBe('free');
    expect(FOXY_DAILY_MESSAGE_LIMIT[plan]).toBe(FOXY_DAILY_MESSAGE_LIMIT.free);
  });

  it('gives an EXPIRED subscription the free allowance', async () => {
    // Stored `active`, period ended a month ago. `resolveEntitlements` decides
    // expiry by the CLOCK rather than by the stored status, which is the case a
    // status-only check would get wrong — and get wrong in the direction that
    // keeps handing out a paid product for free.
    const entitlements = resolveEntitlements({
      subscription: {
        status: 'active',
        currentPeriodEnd: LAST_MONTH,
        cancelledAt: null,
        planCode: 'monthly',
      },
      now: NOW,
    });
    const billing = billingReturning(entitlements);

    const plan = await createFoxyPlanReader(() => billing.service)(ACTOR, ACTOR.userId);

    expect(plan).toBe('free');
    expect(FOXY_DAILY_MESSAGE_LIMIT[plan]).toBe(FOXY_DAILY_MESSAGE_LIMIT.free);
  });

  it('asks billing about the ACTOR themselves, carrying the actor through', async () => {
    // The resolution of the signature mismatch that produced the defect: no
    // system actor is minted, so nothing here can read a third party's billing.
    // `billing.getEntitlements` authorises on ownership, and the subject it is
    // handed is the actor's own id.
    const billing = billingReturning(resolveEntitlements({ subscription: null, now: NOW }));

    await createFoxyPlanReader(() => billing.service)(ACTOR, ACTOR.userId);

    expect(billing.calls).toHaveLength(1);
    expect(billing.calls[0]?.actor).toBe(ACTOR);
    expect(billing.calls[0]?.subjectUserId).toBe(ACTOR.userId);
  });

  it('reads the billing service LATE, through the thunk', async () => {
    // `billing` is constructed after `foxy` in `buildModules`. The thunk is what
    // makes that ordering explicit rather than accidental; a reader that
    // captured the service eagerly would have to be moved every time the module
    // order changed.
    let service: { getEntitlements(actor: Actor, subjectUserId: string): Promise<Entitlements> } | null =
      null;
    const reader = createFoxyPlanReader(() => {
      if (service === null) throw new Error('the plan reader resolved billing too early');
      return service;
    });

    const entitlements = resolveEntitlements({
      subscription: {
        status: 'active',
        currentPeriodEnd: NEXT_MONTH,
        cancelledAt: null,
        planCode: 'yearly',
      },
      now: NOW,
    });
    service = billingReturning(entitlements).service;

    await expect(reader(ACTOR, ACTOR.userId)).resolves.toBe('plus');
  });

  it('follows the CAPABILITY, so a plan code it has never heard of still counts', async () => {
    // The reason the mapping is `hasFeature(…, 'foxy.unlimited')` and not
    // `planCode === 'monthly'`: a catalogue change must not need an edit here.
    const entitlements: Entitlements = {
      planCode: 'school_seat_2027',
      isPaid: true,
      features: ['practice.basic', 'foxy.basic', 'foxy.unlimited'],
      activeUntil: NEXT_MONTH.toISOString(),
    };
    const billing = billingReturning(entitlements);

    await expect(
      createFoxyPlanReader(() => billing.service)(ACTOR, ACTOR.userId),
    ).resolves.toBe('plus');
  });

  it('refuses the paid allowance to a paid-looking grant that lacks the capability', async () => {
    // The mirror of the case above, and the one that matters for revenue in the
    // other direction: `isPaid` is not the question. The question is whether the
    // grant contains the feature this module gates on.
    const entitlements: Entitlements = {
      planCode: 'practice_only',
      isPaid: true,
      features: ['practice.basic', 'practice.unlimited', 'foxy.basic'],
      activeUntil: NEXT_MONTH.toISOString(),
    };
    const billing = billingReturning(entitlements);

    await expect(
      createFoxyPlanReader(() => billing.service)(ACTOR, ACTOR.userId),
    ).resolves.toBe('free');
  });
});
