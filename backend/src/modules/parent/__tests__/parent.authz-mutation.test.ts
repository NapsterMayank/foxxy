import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNoopAudit } from '@/platform/audit/index';
import type { LinkStatus } from '@/platform/authz/index';
import type { OnboardingRequest } from '@/shared/contracts/learner.contract';
import {
  OTHER_TENANT_ID,
  TEST_TENANT_ID,
  createSecondTenant,
  onboardAccount,
  startAppHarness,
  type AppHarness,
  type HarnessAccount,
} from '../../../../tests/helpers/app-harness';
import { createEvidenceDigestWriter } from '../parent.digest-writer';
import { createParentRepository } from '../parent.repository';
import { createParentService, type ParentService } from '../parent.service';
import type { ParentActor } from '../parent.types';

/**
 * ============================================================================
 * MUTATION TESTING FOR THE AUTHORISATION BOUNDARY.
 *
 * WHY THIS FILE EXISTS, and it is not "extra rigour".
 *
 * FOUR TIMES in this codebase a guard has been found that looked installed and
 * enforced nothing. The most recent was D-091 in `notify`: `assertTenantMatch`
 * was called with `actor.tenantId` on BOTH sides, so it compared a value with
 * itself. It had a comment explaining why the check mattered. It had tests. The
 * tests passed — and they passed identically with the check deleted, because
 * nothing they asserted depended on it.
 *
 * That is the failure mode a normal test suite cannot see. A green suite proves
 * the allow path works; it says nothing about whether the deny path is being
 * REACHED, or whether it is a no-op wearing the shape of a boundary.
 *
 * So this file inverts the question. It builds `parent` with each guard
 * DELIBERATELY BROKEN — the exact break somebody would plausibly make — and
 * asserts the break is OBSERVABLE. Every `it` here is a proof that the
 * corresponding assertion in `parent.service.test.ts` would go red.
 *
 * READ IT AS: "if this line were wrong, would anything notice?" Each test
 * answers yes, by making the line wrong.
 * ============================================================================
 */

let harness: AppHarness;

const ONBOARDING: OnboardingRequest = {
  displayName: 'Aarav',
  grade: '8',
  subjects: ['science', 'maths'],
};

beforeAll(async () => {
  harness = await startAppHarness();
  await createSecondTenant(harness);
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
  await createSecondTenant(harness);
});

let emailCounter = 0;
function nextEmail(prefix: string): string {
  emailCounter += 1;
  return `${prefix}${emailCounter}@example.test`;
}

interface Pair {
  readonly parent: HarnessAccount;
  readonly child: HarnessAccount;
  readonly linkId: string;
}

async function makePair(status: 'approved' | 'pending'): Promise<Pair> {
  const child = await onboardAccount(harness, nextEmail('mchild'), 'student');
  const parent = await onboardAccount(harness, nextEmail('mparent'), 'parent');
  const childActor = { userId: child.userId, role: 'student' as const, tenantId: TEST_TENANT_ID };
  const parentActor = { userId: parent.userId, role: 'parent' as const, tenantId: TEST_TENANT_ID };

  await harness.learner.service.createProfile(childActor, ONBOARDING);
  const issued = await harness.identity.service.generateLinkCode(childActor);
  const link = await harness.identity.service.submitLinkCode(parentActor, issued.code);
  if (status === 'approved') await harness.identity.service.approveLink(childActor, link.id);

  await harness.cache.close();
  return { parent, child, linkId: link.id };
}

/**
 * What each mutation may replace.
 *
 * The defaults are EXACTLY the wiring in `app/routes.ts` and in the harness, so
 * a test that overrides nothing is testing the production graph. That matters:
 * a mutation harness whose baseline differs from production proves things about
 * a system nobody runs.
 */
interface Mutations {
  readonly readLinkStatus?: (parentUserId: string, studentUserId: string) => Promise<LinkStatus | null>;
  readonly readTenantOfStudent?: (userId: string) => Promise<string | null>;
}

function buildService(mutations: Mutations = {}): ParentService {
  const identity = harness.identity.service;
  return createParentService({
    repository: createParentRepository(harness.container.poolFor('parent')),
    clock: harness.clock,
    logger: harness.logger,
    readLinkStatus:
      mutations.readLinkStatus ??
      (async (parentUserId, studentUserId) =>
        (await identity.isLinkApproved(parentUserId, studentUserId)) ? 'approved' : null),
    readTenantOfStudent:
      mutations.readTenantOfStudent ?? ((userId) => identity.getTenantOfUser(userId)),
    listLinkedChildren: (actor) => identity.getLinkedChildren(actor),
    readChildProfile: async (actor, studentUserId) => {
      const profile = await harness.learner.service.getProfile(actor, studentUserId);
      return {
        displayName: profile.displayName,
        grade: profile.grade,
        preferredLanguage: profile.preferredLanguage,
      };
    },
    revokeLink: async (actor, linkId) => {
      await identity.revokeLink(actor, linkId);
    },
    // The module's own default writer, so the graph stays identical to
    // production. None of these tests exercises digest CONTENT — they exercise
    // the guard that runs before it ever gets there.
    writer: createEvidenceDigestWriter(),
    // A no-op audit, deliberately: the audit trail is asserted in
    // `parent.service.test.ts` against the REAL Postgres port. Here it would
    // only add rows nobody reads.
    audit: createNoopAudit(),
  });
}

function parentActorOf(account: HarnessAccount, tenantId = TEST_TENANT_ID): ParentActor {
  return { userId: account.userId, role: 'parent', tenantId };
}

// ---------------------------------------------------------------------------

describe('BASELINE — the production wiring refuses what it should', () => {
  it('denies a cross-tenant read on an APPROVED link', async () => {
    // The control for every mutation below. If this ever fails, the mutations
    // prove nothing, because their "the break is visible" result would be
    // indistinguishable from "it was never enforced".
    const { parent, child } = await makePair('approved');
    await expect(
      buildService().getSnapshot(parentActorOf(parent, OTHER_TENANT_ID), child.userId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('denies a PENDING link', async () => {
    const { parent, child } = await makePair('pending');
    await expect(
      buildService().getSnapshot(parentActorOf(parent), child.userId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('MUTATION 1 — the resource tenant echoed off the actor (D-091)', () => {
  /**
   * THE EXACT MISTAKE `notify` SHIPPED.
   *
   * `readTenantOfStudent` costs one indexed read per authorisation, and
   * somebody will eventually propose removing it as a hot-path optimisation.
   * `(userId) => actor.tenantId` type-checks perfectly, reads like a cache, and
   * turns `assertTenantMatch` into `a === a`.
   *
   * It is invisible in every ordinary test, because in every ordinary test the
   * actor and the resource ARE in the same tenant.
   */
  it('lets a cross-tenant parent read a child — so the guard is real', async () => {
    const { parent, child } = await makePair('approved');
    const foreign = parentActorOf(parent, OTHER_TENANT_ID);

    const mutated = buildService({
      // The mutation: the resource's tenant is whatever the caller claimed.
      readTenantOfStudent: () => Promise.resolve(foreign.tenantId),
    });

    // IT SUCCEEDS. That is the point of this assertion: the only thing standing
    // between a school and another school's children is the line this mutation
    // removes, and `parent.service.test.ts`'s cross-tenant test is what fails
    // when it is removed for real.
    await expect(mutated.getSnapshot(foreign, child.userId)).resolves.toMatchObject({
      childUserId: child.userId,
    });
  });

  it('also collapses the "no such child" deny, which is the enumeration half', async () => {
    /**
     * The second, quieter consequence. An unknown child resolves to `''`, which
     * the guard treats as "no tenant" and denies — that is what makes "no such
     * child" indistinguishable from "another tenant". Echo the actor's tenant
     * and an unknown id now carries a VALID tenant, so the refusal has to come
     * from somewhere else, and the two paths stop being the same path.
     */
    const { parent } = await makePair('approved');
    const actor = parentActorOf(parent);

    const mutated = buildService({
      readTenantOfStudent: () => Promise.resolve(TEST_TENANT_ID),
      // Consent is genuinely absent, so the link half still refuses — but via a
      // different branch of the guard from the one the tenant check uses.
      readLinkStatus: () => Promise.resolve(null),
    });

    const real = buildService({ readLinkStatus: () => Promise.resolve(null) });

    const reasonFrom = async (service: ParentService): Promise<string> => {
      try {
        await service.getSnapshot(actor, '99999999-9999-4999-8999-999999999999');
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('expected a refusal, got a result');
    };

    const mutatedReason = await reasonFrom(mutated);
    const realReason = await reasonFrom(real);

    // The log-side reasons DIFFER once the tenant is faked: the real wiring
    // refuses on "resource carries no tenant", the mutated one has to fall
    // through to the consent rule. Same 403 to a client today — but the two
    // denies are no longer the same code path, which is precisely the property
    // §7 rule 2 depends on.
    expect(mutatedReason).not.toBe(realReason);
  });
});

describe('MUTATION 1b — the SAME echo in `authoriseSelf`', () => {
  /**
   * THE MUTANT THAT SURVIVED, and the reason this file was worth writing.
   *
   * `getChildren` has no child id, so it goes through `authoriseSelf`. When
   * that method's `readTenantOfStudent(actor.userId)` was replaced with
   * `actor.tenantId`, the ENTIRE PARENT SUITE STAYED GREEN — because the
   * ownership rule (`resource.ownerUserId === actor.userId`) is trivially true
   * for a self-check, so the tenant comparison was the only thing the function
   * did, and the mutation removed it. A guard that had been fully written,
   * carefully commented, and enforced nothing that any test depended on.
   *
   * `parent.service.test.ts` now carries the assertion that closes it. This is
   * the proof that the assertion is load-bearing.
   */
  it('lets an actor with a FORGED tenant through `getChildren`', async () => {
    /**
     * A CHILDLESS PARENT, and that is what isolates the guard.
     *
     * With a linked child the mutation is MASKED: `readChildProfile` calls
     * learner's `getProfile`, which runs its own independent tenant check and
     * refuses — defence in depth doing exactly its job, and also hiding which
     * of the two layers is load-bearing. For a parent with no children that
     * second layer is never reached, so `authoriseSelf` is the only thing that
     * can refuse, and the mutation is visible in isolation.
     */
    const lonely = await onboardAccount(harness, nextEmail('mlonely'), 'parent');
    await harness.cache.close();
    const foreign = parentActorOf(lonely, OTHER_TENANT_ID);

    const mutated = buildService({
      readTenantOfStudent: () => Promise.resolve(foreign.tenantId),
    });

    // IT SUCCEEDS — `authoriseSelf` has become a no-op.
    await expect(mutated.getChildren(foreign)).resolves.toEqual([]);

    // The production wiring refuses the identical call.
    await expect(buildService().getChildren(foreign)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('MUTATION 2 — the link status hardcoded to approved', () => {
  /**
   * The other half of the door. `readLinkStatus` is the consent check, and the
   * plausible break is a stub left behind during development or a "cache" that
   * never expires.
   */
  it('lets an UNLINKED parent read any child — so the consent check is real', async () => {
    const { parent } = await makePair('pending');
    const stranger = await onboardAccount(harness, nextEmail('mstranger'), 'student');
    await harness.learner.service.createProfile(
      { userId: stranger.userId, role: 'student', tenantId: TEST_TENANT_ID },
      ONBOARDING,
    );

    const mutated = buildService({ readLinkStatus: () => Promise.resolve('approved') });

    await expect(
      mutated.getSnapshot(parentActorOf(parent), stranger.userId),
    ).resolves.toMatchObject({ childUserId: stranger.userId });

    // And the production wiring refuses the same call.
    await expect(
      buildService().getSnapshot(parentActorOf(parent), stranger.userId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('makes a PENDING link readable — which is what "pending grants nothing" pins', async () => {
    const { parent, child } = await makePair('pending');
    const mutated = buildService({ readLinkStatus: () => Promise.resolve('approved') });

    await expect(mutated.getSnapshot(parentActorOf(parent), child.userId)).resolves.toMatchObject({
      childUserId: child.userId,
    });
  });
});

describe('MUTATION 3 — the status cached instead of read per call', () => {
  /**
   * §7 rule 3. A status read ONCE and reused is the difference between "your
   * revocation takes effect now" and "it takes effect at their next login" —
   * and it is not a hypothetical shortcut, it is the obvious one: the read is
   * on every authorisation, so caching it looks like free performance.
   */
  it('keeps a revoked parent reading — so reading at query time is real', async () => {
    const { parent, child } = await makePair('approved');
    const actor = parentActorOf(parent);

    // A status captured ONCE, at build time, exactly as a cache would.
    const captured = await harness.identity.service.isLinkApproved(parent.userId, child.userId);
    const mutated = buildService({
      readLinkStatus: () => Promise.resolve(captured ? 'approved' : null),
    });

    // Revoke through the REAL service, so the database genuinely changes.
    await buildService().revokeConsent(actor, child.userId);

    // The real wiring refuses the very next call…
    await expect(buildService().getSnapshot(actor, child.userId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // …and the cached one does not. That gap is the whole content of §7 rule 3.
    await expect(mutated.getSnapshot(actor, child.userId)).resolves.toMatchObject({
      childUserId: child.userId,
    });
  });
});

describe('MUTATION 4 — the worker skipping its own tenant comparison', () => {
  /**
   * `buildWeeklyDigestFor` has NO ACTOR, so `assertCanAccess` cannot run. Its
   * tenant rule is a plain `if` over two columns, which makes it the easiest
   * one in the module to delete by accident — and the consequence is a digest
   * about one school's child mailed to a parent in another.
   *
   * There is no injection point for this one: the comparison is inside the
   * service. So the mutation is applied to the DATA instead — the link is left
   * approved and the child moved to another tenant — and the assertion is that
   * the worker produces NOTHING. If the `if` were removed, this returns one
   * digest.
   */
  it('produces nothing for an approved link whose sides are in different tenants', async () => {
    const { parent, child } = await makePair('approved');
    await harness.postgres.client.query(`update users set tenant_id = $1 where id = $2`, [
      OTHER_TENANT_ID,
      child.userId,
    ]);

    await expect(
      buildService().buildWeeklyDigestFor(parent.userId, harness.clock.now()),
    ).resolves.toEqual([]);
  });

  it('produces one when both sides agree — the control', async () => {
    const { parent } = await makePair('approved');
    await expect(
      buildService().buildWeeklyDigestFor(parent.userId, harness.clock.now()),
    ).resolves.toHaveLength(1);
  });
});
