import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeLlm } from '@/platform/llm/index';
import { ERROR_CODES, isAppError } from '@/platform/errors/index';
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
import { createFoxyRepository, type FoxyRepository } from '../foxy.repository';
import { createFoxyService, type FoxyService } from '../foxy.service';
import type { ChunkSearch, FoxyActor, SessionRecord } from '../foxy.types';

/**
 * ============================================================================
 * MUTATION TESTING FOR THE AUTHORISATION BOUNDARY.
 *
 * WHY THIS FILE EXISTS, and it is not "extra rigour".
 *
 * FIVE TIMES in this codebase a guard has been found that looked installed and
 * enforced nothing. D-091: `notify` called `assertTenantMatch` with
 * `actor.tenantId` on BOTH sides, so it compared a value with itself — with a
 * comment explaining why the check mattered, and tests that passed identically
 * with the check deleted. D-125: `parent.authoriseSelf` had the same defect,
 * survived the D-091 sweep, and was found only by breaking it on purpose.
 *
 * That is the failure mode a normal suite cannot see. A green suite proves the
 * ALLOW path works; it says nothing about whether the DENY path is reached, or
 * whether it is a no-op wearing the shape of a boundary.
 *
 * So this file inverts the question. It builds `foxy` with each guard
 * DELIBERATELY BROKEN — the exact break somebody would plausibly make — and
 * asserts the break is OBSERVABLE. Every `it` here is a proof that the
 * corresponding assertion in `foxy.service.test.ts` would go red.
 *
 * READ IT AS: "if this line were wrong, would anything notice?" Each test
 * answers yes, by making the line wrong.
 *
 * ----------------------------------------------------------------------------
 * THE THREE MUTATIONS, AND WHY THESE THREE.
 *
 *  1. THE ACTOR-SCOPED TENANT, echoed off the actor. This is D-091 and D-125
 *     verbatim, in the methods where the resource is the caller themselves —
 *     `listSessions`, `getUsage`, `startSession`. Those are exactly the methods
 *     where the ownership rule is trivially true, so the tenant comparison is
 *     the ONLY thing the guard does. D-125's finding was that such a method can
 *     lose its entire boundary and no test notices.
 *
 *  2. THE SESSION-SCOPED TENANT, echoed off the actor. Session methods take the
 *     tenant from the ROW, which is stronger. Breaking it makes a conversation
 *     readable from any tenant.
 *
 *  3. THE OWNER, echoed off the actor. `authorise(..., session.studentUserId,
 *     ...)` becomes `authorise(..., actor.userId, ...)`, which is a check that
 *     every student passes against every conversation.
 *
 * Mutations 2 and 3 are installed through the REPOSITORY rather than by editing
 * the service, because the value the service reads is the value the repository
 * hands it — so a repository that lies about the row is precisely equivalent to
 * a service that ignores it, and it needs no source edit to arrange.
 * ============================================================================
 */

let harness: AppHarness;

const ONBOARDING: OnboardingRequest = {
  displayName: 'Aarav',
  grade: '8',
  subjects: ['science', 'maths'],
};

let emailCounter = 0;
function nextEmail(prefix: string): string {
  emailCounter += 1;
  return `${prefix}${emailCounter}@example.test`;
}

function actorOf(account: HarnessAccount, tenantId: string = TEST_TENANT_ID): FoxyActor {
  return { userId: account.userId, role: 'student', tenantId };
}

async function makeStudent(): Promise<HarnessAccount> {
  const account = await onboardAccount(harness, nextEmail('mut'), 'student');
  await harness.learner.service.createProfile(actorOf(account), ONBOARDING);
  return account;
}

/** Retrieval always abstains here: no turn in this file reaches the model. */
const ABSTAINING_SEARCH: ChunkSearch = () =>
  Promise.resolve({
    chunks: [],
    shouldAbstain: true,
    confidence: 0,
    normalisedQuery: 'q',
    abstainReason: 'no-candidates',
  });

/**
 * What each mutation may replace.
 *
 * The defaults are EXACTLY the wiring in `app/routes.ts` and in the harness, so
 * a test that overrides nothing is testing the production graph. That matters:
 * a mutation harness whose baseline differs from production proves things about
 * a system nobody runs.
 */
interface Mutations {
  /** Mutation 1 — the D-091/D-125 defect on the actor-scoped path. */
  readonly readTenantOfStudent?: (userId: string) => Promise<string | null>;
  /** Mutations 2 and 3 — a repository that lies about the session row. */
  readonly rewriteSession?: (session: SessionRecord, actor: FoxyActor) => SessionRecord;
}

function buildService(mutations: Mutations = {}, actor?: FoxyActor): FoxyService {
  const identity = harness.identity.service;
  const base: FoxyRepository = createFoxyRepository(harness.container.poolFor('foxy'));

  const repository: FoxyRepository =
    mutations.rewriteSession === undefined || actor === undefined
      ? base
      : {
          ...base,
          async findSession(sessionId: string): Promise<SessionRecord | null> {
            const row = await base.findSession(sessionId);
            return row === null ? null : mutations.rewriteSession?.(row, actor) ?? row;
          },
        };

  return createFoxyService({
    repository,
    clock: harness.clock,
    logger: harness.logger,
    llm: createFakeLlm(),
    cache: harness.cache,
    search: ABSTAINING_SEARCH,
    readTenantOfStudent:
      mutations.readTenantOfStudent ?? ((userId) => identity.getTenantOfUser(userId)),
    readStudentContext: async (callerActor, studentUserId) => {
      const [profile, subjects] = await Promise.all([
        harness.learner.service.getProfile(callerActor, studentUserId),
        harness.learner.service.getSubjects(callerActor, studentUserId),
      ]);
      return { grade: profile.grade, subjects };
    },
    readLanguage: async (callerActor, studentUserId) =>
      (await harness.learner.service.getProfile(callerActor, studentUserId)).preferredLanguage,
    readPlan: (): Promise<null> => Promise.resolve(null),
    model: 'mutation-model',
  });
}

function isForbidden(error: unknown): boolean {
  return isAppError(error) && error.code === ERROR_CODES.FORBIDDEN;
}

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

// ---------------------------------------------------------------------------
// MUTATION 1 — the actor-scoped tenant, echoed off the actor (D-091, D-125)
// ---------------------------------------------------------------------------

describe('MUTATION 1 — the actor-scoped tenant read from `users`', () => {
  it('CORRECT WIRING: refuses a cross-tenant `listSessions`', async () => {
    const student = await makeStudent();
    const service = buildService();

    await expect(
      service.listSessions(actorOf(student, OTHER_TENANT_ID), 10),
    ).rejects.toSatisfy(isForbidden);
  });

  it('BROKEN WIRING: the same call SUCCEEDS — so the guard is load-bearing', async () => {
    const student = await makeStudent();
    // The exact D-125 mistake: the resource tenant echoed back off the actor,
    // which makes `assertTenantMatch` compare a value with itself.
    const service = buildService({
      readTenantOfStudent: (_userId) => Promise.resolve(OTHER_TENANT_ID),
    });

    // It no longer refuses. If this ever starts refusing, the mutation has
    // stopped reaching the guard and this file has stopped proving anything.
    await expect(service.listSessions(actorOf(student, OTHER_TENANT_ID), 10)).resolves.toEqual([]);
  });

  it('CORRECT WIRING: refuses a cross-tenant `getUsage`', async () => {
    const student = await makeStudent();
    await expect(
      buildService().getUsage(actorOf(student, OTHER_TENANT_ID)),
    ).rejects.toSatisfy(isForbidden);
  });

  it('BROKEN WIRING: `getUsage` answers across tenants', async () => {
    const student = await makeStudent();
    const service = buildService({
      readTenantOfStudent: (_userId) => Promise.resolve(OTHER_TENANT_ID),
    });
    await expect(service.getUsage(actorOf(student, OTHER_TENANT_ID))).resolves.toMatchObject({
      plan: 'free',
    });
  });

  it('CORRECT WIRING: refuses a cross-tenant `startSession`', async () => {
    const student = await makeStudent();
    await expect(
      buildService().startSession(actorOf(student, OTHER_TENANT_ID), {
        mode: 'doubt',
        subject: 'science',
      }),
    ).rejects.toSatisfy(isForbidden);
  });

  it('AN UNRESOLVABLE ACCOUNT DENIES rather than passing an empty tenant through', async () => {
    const student = await makeStudent();
    // `readTenantOfStudent` returning null is "no such account". It must reach
    // the guard as an EMPTY tenant and be denied there, rather than short-
    // circuiting into a distinct 404 — which would be an account-existence
    // oracle.
    const service = buildService({ readTenantOfStudent: () => Promise.resolve(null) });
    await expect(service.listSessions(actorOf(student), 10)).rejects.toSatisfy(isForbidden);
  });
});

// ---------------------------------------------------------------------------
// MUTATION 2 — the session-scoped tenant, echoed off the actor
// ---------------------------------------------------------------------------

describe('MUTATION 2 — the session tenant taken from the ROW', () => {
  it('CORRECT WIRING: refuses a cross-tenant read of a conversation', async () => {
    const owner = await makeStudent();
    const session = await buildService().startSession(actorOf(owner), {
      mode: 'doubt',
      subject: 'science',
    });

    await expect(
      buildService().getSession(actorOf(owner, OTHER_TENANT_ID), session.id),
    ).rejects.toSatisfy(isForbidden);
  });

  it('BROKEN WIRING: the same read SUCCEEDS when the tenant comes off the actor', async () => {
    const owner = await makeStudent();
    const session = await buildService().startSession(actorOf(owner), {
      mode: 'doubt',
      subject: 'science',
    });

    const attacker = actorOf(owner, OTHER_TENANT_ID);
    const mutated = buildService(
      { rewriteSession: (row, actor) => ({ ...row, tenantId: actor.tenantId }) },
      attacker,
    );

    // A conversation filed under one tenant, read from another. Nothing errors.
    await expect(mutated.getSession(attacker, session.id)).resolves.toMatchObject({
      session: { id: session.id },
    });
  });

  it('BROKEN WIRING: a cross-tenant SEND is also admitted', async () => {
    const owner = await makeStudent();
    const session = await buildService().startSession(actorOf(owner), {
      mode: 'doubt',
      subject: 'science',
    });

    const attacker = actorOf(owner, OTHER_TENANT_ID);
    const mutated = buildService(
      { rewriteSession: (row, actor) => ({ ...row, tenantId: actor.tenantId }) },
      attacker,
    );

    // The write path is separately mutated and separately proved. If one method
    // has the bug, assume the others do until each is shown otherwise (D-091).
    await expect(
      mutated.sendMessage(attacker, session.id, { text: 'why does light bend' }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// MUTATION 3 — the owner, echoed off the actor
// ---------------------------------------------------------------------------

describe('MUTATION 3 — the conversation OWNER taken from the row', () => {
  it('CORRECT WIRING: refuses one student reading another student’s conversation', async () => {
    const owner = await makeStudent();
    const stranger = await makeStudent();
    const session = await buildService().startSession(actorOf(owner), {
      mode: 'doubt',
      subject: 'science',
    });

    await expect(
      buildService().getSession(actorOf(stranger), session.id),
    ).rejects.toSatisfy(isForbidden);
  });

  it('BROKEN WIRING: any student in the tenant can read any conversation', async () => {
    const owner = await makeStudent();
    const stranger = await makeStudent();
    const session = await buildService().startSession(actorOf(owner), {
      mode: 'doubt',
      subject: 'science',
    });

    const attacker = actorOf(stranger);
    const mutated = buildService(
      // `authorise(..., session.studentUserId, ...)` becoming
      // `authorise(..., actor.userId, ...)` — a check every student passes.
      { rewriteSession: (row, actor) => ({ ...row, studentUserId: actor.userId }) },
      attacker,
    );

    await expect(mutated.getSession(attacker, session.id)).resolves.toMatchObject({
      session: { id: session.id },
    });
  });

  it('BROKEN WIRING: and can send into it', async () => {
    const owner = await makeStudent();
    const stranger = await makeStudent();
    const session = await buildService().startSession(actorOf(owner), {
      mode: 'doubt',
      subject: 'science',
    });

    const attacker = actorOf(stranger);
    const mutated = buildService(
      { rewriteSession: (row, actor) => ({ ...row, studentUserId: actor.userId }) },
      attacker,
    );

    await expect(
      mutated.sendMessage(attacker, session.id, { text: 'why does light bend' }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// THE CONTROL
// ---------------------------------------------------------------------------

describe('the control — the unmutated service allows what it should', () => {
  it('lets a student read their OWN conversation in their OWN tenant', async () => {
    const owner = await makeStudent();
    const service = buildService();
    const session = await service.startSession(actorOf(owner), {
      mode: 'doubt',
      subject: 'science',
    });

    // Without this, every "BROKEN WIRING" test above could be passing because
    // the service refuses everything rather than because the mutation worked.
    await expect(service.getSession(actorOf(owner), session.id)).resolves.toMatchObject({
      session: { id: session.id },
    });
  });
});
