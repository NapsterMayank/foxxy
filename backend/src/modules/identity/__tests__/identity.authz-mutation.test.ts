import { randomBytes as cryptoRandomBytes, randomInt as cryptoRandomInt } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@/platform/errors/index';
import type { LinkStatusValue } from '@/shared/contracts/identity.contract';
import { createIdentityRepository, type IdentityRepository } from '../identity.repository';
import { createIdentityService, type IdentityService } from '../identity.service';
import type { RequestContext, SessionActor } from '../identity.types';
import {
  OTHER_TENANT_ID,
  TEST_TENANT_ID,
  createSecondTenant,
  startIdentityHarness,
  type IdentityHarness,
} from './harness';

/**
 * ============================================================================
 * MUTATION TESTING FOR THE AUTHORISATION BOUNDARY — identity.
 *
 * WHY THIS FILE EXISTS, and why it is the LAST of the four to be written.
 *
 * `billing`, `foxy` and `parent` each carry a `*.authz-mutation.test.ts`.
 * `identity` — the module that OWNS the boundary, and the module every other
 * one calls to reach it — carried none. That is the wrong way round: the three
 * downstream files each prove that THEIR wiring of `readTenantOfStudent` is
 * load-bearing, and all three ultimately resolve to
 * `identity.getTenantOfUser` / `identity.assertParentCanReadChild`. Nothing
 * proved the thing at the bottom.
 *
 * THE SURVIVING MUTANT THAT PROMPTED IT. `tenantOfStudent` in
 * `identity.service.ts` is three lines:
 *
 *     if (studentUserId === actor.userId) return actor.tenantId;
 *     return repository.findUserTenant(studentUserId);
 *
 * Replacing the second line with `return actor.tenantId;` — collapsing the
 * function to a self-comparison, which is the D-091 mistake exactly — left ALL
 * 344 tests green. The thirteen-line comment above the function names that
 * failure mode in as many words. Nothing tested it, because every existing
 * caller passes `tenantId: TEST_TENANT_ID` on BOTH sides, and a self-comparison
 * and a real comparison are indistinguishable when the two values agree.
 *
 * The D-073 tests cover the WRITE side (a `tenantId` in a signup body is
 * stripped). This file covers the READ side, which is where the data leaves.
 *
 * READ IT AS: "if this line were wrong, would anything notice?" Each test
 * answers yes, by making the line wrong.
 * ============================================================================
 */

let harness: IdentityHarness;

const GOOD_PASSWORD = 'vermillion-otter-49';

beforeAll(async () => {
  harness = await startIdentityHarness();
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
  return `${prefix}${String(emailCounter)}@example.test`;
}

/**
 * What a mutation may replace.
 *
 * The defaults are the REAL repository over the REAL Postgres, so a test that
 * overrides nothing exercises the production graph. A mutation harness whose
 * baseline differs from production proves things about a system nobody runs.
 */
interface Mutations {
  readonly findUserTenant?: (userId: string) => Promise<string | null>;
  readonly findLinkStatus?: (
    parentUserId: string,
    studentUserId: string,
  ) => Promise<LinkStatusValue | null>;
}

function buildService(mutations: Mutations = {}): IdentityService {
  const real: IdentityRepository = createIdentityRepository(harness.container.poolFor('identity'));
  const repository: IdentityRepository = {
    ...real,
    ...(mutations.findUserTenant === undefined
      ? {}
      : { findUserTenant: mutations.findUserTenant }),
    ...(mutations.findLinkStatus === undefined
      ? {}
      : { findLinkStatus: mutations.findLinkStatus }),
  };

  return createIdentityService({
    repository,
    cache: harness.cache,
    hasher: harness.hasher,
    mail: harness.mail,
    clock: harness.clock,
    logger: harness.logger,
    randomBytes: (size: number): Uint8Array => cryptoRandomBytes(size),
    randomInt: (max: number): number => cryptoRandomInt(max),
    sessionTtlDays: 30,
    defaultTenantId: TEST_TENANT_ID,
    urls: { apiBaseUrl: 'http://api.test', appBaseUrl: 'http://app.test' },
  });
}

/**
 * Signs up, reads the token out of the mail fake, and verifies it.
 *
 * A DISTINCT `ipHash` PER ACCOUNT, deliberately. Signup is rate limited to
 * three per IP per hour (§6.9), and a test that needs a fourth account would
 * otherwise fail on the rate limiter and read as an authorisation failure —
 * the wrong red for the wrong reason.
 */
async function account(prefix: string, role: 'student' | 'parent'): Promise<string> {
  const service = buildService();
  const email = nextEmail(prefix);
  const context: RequestContext = { ipHash: `ip-${email}`, userAgent: 'vitest' };
  await service.signup({ email, password: GOOD_PASSWORD, role }, context);
  const verifyUrl = harness.mail.sent.at(-1)?.data.verifyUrl ?? '';
  const token = new URL(verifyUrl).searchParams.get('token') ?? '';
  const result = await service.verifyEmail(token, context);
  return result.user.id;
}

interface Pair {
  readonly parentUserId: string;
  readonly studentUserId: string;
  readonly linkId: string;
}

/**
 * A parent and a student, linked THROUGH THE REAL FLOW.
 *
 * The student issues a code, the parent submits it, the student approves.
 * Inserting a `parent_child_links` row directly would skip the one rule that
 * matters — only the STUDENT can approve — and would make these tests pass
 * against a state the product cannot reach.
 */
async function makePair(status: 'approved' | 'pending'): Promise<Pair> {
  const service = buildService();
  const studentUserId = await account('mstudent', 'student');
  const parentUserId = await account('mparent', 'parent');
  const student: SessionActor = {
    userId: studentUserId,
    role: 'student',
    tenantId: TEST_TENANT_ID,
  };
  const parent: SessionActor = { userId: parentUserId, role: 'parent', tenantId: TEST_TENANT_ID };

  const issued = await service.generateLinkCode(student);
  const link = await service.submitLinkCode(parent, issued.code);
  if (status === 'approved') await service.approveLink(student, link.id);

  return { parentUserId, studentUserId, linkId: link.id };
}

/** Moves an account into the second tenant, so the two sides genuinely differ. */
async function moveToOtherTenant(userId: string): Promise<void> {
  await harness.postgres.client.query(`update users set tenant_id = $1 where id = $2`, [
    OTHER_TENANT_ID,
    userId,
  ]);
}

function parentActor(userId: string, tenantId: string = TEST_TENANT_ID): SessionActor {
  return { userId, role: 'parent', tenantId };
}

// ---------------------------------------------------------------------------

describe('BASELINE — the production wiring refuses what it should', () => {
  /**
   * The control for every mutation below. Without it, a mutation's "the break
   * is visible" result is indistinguishable from "it was never enforced".
   */
  it('denies a cross-tenant read on an APPROVED link — the child moved away', async () => {
    const { parentUserId, studentUserId } = await makePair('approved');
    await moveToOtherTenant(studentUserId);

    await expect(
      buildService().assertParentCanReadChild(parentActor(parentUserId), studentUserId),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('denies a cross-tenant read on an APPROVED link — the actor claims another tenant', async () => {
    const { parentUserId, studentUserId } = await makePair('approved');

    await expect(
      buildService().assertParentCanReadChild(
        parentActor(parentUserId, OTHER_TENANT_ID),
        studentUserId,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('allows the same read when both sides agree', async () => {
    const { parentUserId, studentUserId } = await makePair('approved');
    await expect(
      buildService().assertParentCanReadChild(parentActor(parentUserId), studentUserId),
    ).resolves.toBeUndefined();
  });
});

describe('MUTATION 1 — `tenantOfStudent` collapsed to `return actor.tenantId`', () => {
  /**
   * THE SURVIVING MUTANT. `findUserTenant` costs one indexed read per
   * authorisation and sits on the hot path of every parent request, so somebody
   * will eventually propose removing it as an optimisation — the caller already
   * "knows" the tenant, after all. `return actor.tenantId` type-checks
   * perfectly, reads like a cache, and turns `assertTenantMatch` into `a === a`.
   *
   * It is invisible in every ordinary test, because in every ordinary test the
   * actor and the resource ARE in the same tenant.
   */
  it('lets a parent read a child who has been moved to ANOTHER TENANT', async () => {
    const { parentUserId, studentUserId } = await makePair('approved');
    await moveToOtherTenant(studentUserId);
    const actor = parentActor(parentUserId);

    const mutated = buildService({
      // The mutation: the resource's tenant is whatever the caller carries.
      findUserTenant: () => Promise.resolve(actor.tenantId),
    });

    // IT SUCCEEDS. That is the whole point of the assertion: the only thing
    // standing between one school and another school's children is the line
    // this mutation removes.
    await expect(mutated.assertParentCanReadChild(actor, studentUserId)).resolves.toBeUndefined();

    // …and the production wiring refuses the identical call.
    await expect(
      buildService().assertParentCanReadChild(actor, studentUserId),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('lets an actor with a FORGED tenant read a child in the real one', async () => {
    /**
     * The same collapse from the other direction, and the one that matters for
     * a session whose `tenantId` arrived from somewhere it should not have. The
     * child never moves; the CALLER claims a tenant it does not belong to, and
     * the echo makes the claim self-ratifying.
     */
    const { parentUserId, studentUserId } = await makePair('approved');
    const foreign = parentActor(parentUserId, OTHER_TENANT_ID);

    const mutated = buildService({ findUserTenant: () => Promise.resolve(foreign.tenantId) });

    await expect(mutated.assertParentCanReadChild(foreign, studentUserId)).resolves.toBeUndefined();
    await expect(
      buildService().assertParentCanReadChild(foreign, studentUserId),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('also collapses the "no such child" deny, which is the enumeration half', async () => {
    /**
     * The second, quieter consequence. An unknown student resolves to `null`,
     * which `assertParentCanReadChild` turns into `''` and the guard treats as
     * "no tenant" and denies — that is what makes "no such child" and "another
     * tenant" the SAME code path. Echo the actor's tenant and an unknown id now
     * carries a VALID tenant, so the refusal has to come from the consent rule
     * instead, and the two denies stop being one deny.
     */
    const { parentUserId } = await makePair('approved');
    const actor = parentActor(parentUserId);
    const nobody = '99999999-9999-4999-8999-999999999999';

    const reasonFrom = async (service: IdentityService): Promise<string> => {
      try {
        await service.assertParentCanReadChild(actor, nobody);
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('expected a refusal, got a result');
    };

    const mutatedReason = await reasonFrom(
      buildService({ findUserTenant: () => Promise.resolve(actor.tenantId) }),
    );
    const realReason = await reasonFrom(buildService());

    // Same contentless 403 to a client either way — but the log-side reasons
    // DIFFER, which means the two refusals are no longer the same branch. That
    // sameness is precisely the property §7 rule 2 depends on.
    expect(realReason).toContain('resource carries no tenant');
    expect(mutatedReason).not.toBe(realReason);
  });
});

describe('MUTATION 2 — the link status hardcoded to approved', () => {
  /**
   * The other half of the door. `findLinkStatus` is the consent check, and the
   * plausible break is a stub left behind during development, or a "cache" that
   * never expires.
   */
  it('lets an UNLINKED parent read any child — so the consent check is real', async () => {
    const { parentUserId } = await makePair('pending');
    const strangerUserId = await account('mstranger', 'student');
    const actor = parentActor(parentUserId);

    const mutated = buildService({ findLinkStatus: () => Promise.resolve('approved') });

    await expect(
      mutated.assertParentCanReadChild(actor, strangerUserId),
    ).resolves.toBeUndefined();

    await expect(
      buildService().assertParentCanReadChild(actor, strangerUserId),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('makes a PENDING link readable — which is what "pending grants nothing" pins', async () => {
    const { parentUserId, studentUserId } = await makePair('pending');
    const mutated = buildService({ findLinkStatus: () => Promise.resolve('approved') });

    await expect(
      mutated.assertParentCanReadChild(parentActor(parentUserId), studentUserId),
    ).resolves.toBeUndefined();
  });
});

describe('MUTATION 3 — the status cached instead of read per call', () => {
  /**
   * §7 rule 3. A status read ONCE and reused is the difference between "your
   * revocation takes effect now" and "it takes effect at their next login" —
   * and it is not a hypothetical shortcut, it is the obvious one: the read
   * happens on every authorisation, so caching it looks like free performance.
   */
  it('keeps a revoked parent reading — so reading at query time is real', async () => {
    const { parentUserId, studentUserId, linkId } = await makePair('approved');
    const actor = parentActor(parentUserId);

    // A status captured ONCE, at build time, exactly as a cache would.
    const captured = await buildService().isLinkApproved(parentUserId, studentUserId);
    const mutated = buildService({
      findLinkStatus: () => Promise.resolve(captured ? 'approved' : null),
    });

    // Revoked through the REAL service, so the database genuinely changes.
    await buildService().revokeLink(actor, linkId);

    // The real wiring refuses the very next call…
    await expect(
      buildService().assertParentCanReadChild(actor, studentUserId),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    // …and the cached one does not. That gap is the whole content of §7 rule 3.
    await expect(mutated.assertParentCanReadChild(actor, studentUserId)).resolves.toBeUndefined();
  });
});
