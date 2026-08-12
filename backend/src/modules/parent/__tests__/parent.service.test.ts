import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import {
  insertChapter,
  insertQuestion,
  makeChapter,
  makeQuestion,
} from '../../../../tests/fixtures/index';
import { weekKeyOf } from '../domain/week-window';
import { createParentRepository, type NewDigest } from '../parent.repository';
import type { ParentActor } from '../parent.types';

/**
 * ============================================================================
 * parent SERVICE TESTS — a real Postgres, faked everything else (§9.1).
 *
 * THE PARENT-CHILD LINK IS THE ONLY CROSS-USER DATA PATH IN THE PRODUCT. Every
 * other read in this system is somebody reading their own row; this is the one
 * place where person A is handed person B's data, and the only thing standing
 * between "a parent sees their child's week" and "anybody sees any child's
 * week" is `authoriseChild`.
 *
 * So the deny half of this file is larger than the allow half, and it asserts
 * something stronger than a status code:
 *
 *  1. FOUR REFUSAL REASONS, ONE RESPONSE. "Not linked", "no such child", "a
 *     pending link" and "a link in another tenant" are byte-identical to the
 *     caller. Anything else is a child-existence oracle — a parent could
 *     discover which student accounts exist by trying ids, which is a
 *     enumeration attack against children.
 *
 *  2. THE TENANT COMES FROM THE DATA. `readTenantOfStudent` reads
 *     `users.tenant_id` for the CHILD. The harness wires it exactly as
 *     `app/routes.ts` does, so these tests exercise the real comparison rather
 *     than a convenient one. `parent.authz-mutation.test.ts` is the other half:
 *     it installs the D-091 mistake deliberately and proves this suite would go
 *     red.
 *
 *  3. REVOCATION IS IMMEDIATE. Not "on the next login", not "when the cache
 *     expires". There is a test below that reads successfully, revokes, and
 *     reads again inside one test body.
 *
 * The clock is fixed. There is no `sleep` anywhere in this file — a test that
 * waits for wall-clock time is a test that fails on a loaded CI box.
 * ============================================================================
 */

let harness: AppHarness;

const ONBOARDING: OnboardingRequest = {
  displayName: 'Aarav',
  grade: '8',
  subjects: ['science', 'maths'],
};

/** A uuid that is syntactically valid and belongs to nobody. */
const NOBODY = '99999999-9999-4999-8999-999999999999';

beforeAll(async () => {
  harness = await startAppHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

function parentActor(account: HarnessAccount, tenantId: string = TEST_TENANT_ID): ParentActor {
  return { userId: account.userId, role: 'parent', tenantId };
}

function studentActor(
  account: HarnessAccount,
  tenantId: string = TEST_TENANT_ID,
): { userId: string; role: 'student'; tenantId: string } {
  return { userId: account.userId, role: 'student', tenantId };
}

interface Pair {
  readonly parent: HarnessAccount;
  readonly child: HarnessAccount;
  readonly linkId: string;
}

let emailCounter = 0;
function nextEmail(prefix: string): string {
  emailCounter += 1;
  return `${prefix}${emailCounter}@example.test`;
}

/**
 * A parent and an onboarded child, with a link in the requested state.
 *
 * THROUGH THE REAL LINK FLOW — the student issues a code, the parent submits
 * it, the student approves. Inserting a `parent_child_links` row directly would
 * make every test below pass against a state the product cannot actually reach,
 * and would skip the one rule that matters: only the STUDENT can approve.
 */
async function makePair(status: 'approved' | 'pending' | 'revoked'): Promise<Pair> {
  const child = await onboardAccount(harness, nextEmail('child'), 'student');
  const parent = await onboardAccount(harness, nextEmail('parent'), 'parent');
  await harness.learner.service.createProfile(studentActor(child), ONBOARDING);

  const issued = await harness.identity.service.generateLinkCode(studentActor(child));
  const link = await harness.identity.service.submitLinkCode(parentActor(parent), issued.code);

  if (status !== 'pending') {
    await harness.identity.service.approveLink(studentActor(child), link.id);
  }
  if (status === 'revoked') {
    await harness.identity.service.revokeLink(studentActor(child), link.id);
  }

  /**
   * THE RATE-LIMIT COUNTERS, CLEARED — not the clock, advanced.
   *
   * Signup is 3 per hour per IP and login 5 per 15 minutes, and every account
   * here comes through the real HTTP surface, so any test building two pairs
   * would otherwise be refused by a limiter that is working exactly as
   * intended. Winding the injected clock forward instead would also work and
   * would be worse: the digest is keyed by WEEK, so a test that quietly moved
   * time to make signup succeed could land its evidence in a different week
   * from the one it then asserts on.
   *
   * `close()` is MemoryCache's clear. Nothing sleeps.
   */
  await harness.cache.close();

  return { parent, child, linkId: link.id };
}

/** Every call a parent can make about a named child. Used by the deny tests. */
function everyChildRead(
  actor: ParentActor,
  childUserId: string,
): readonly { readonly name: string; readonly call: () => Promise<unknown> }[] {
  const service = harness.parent.service;
  return [
    { name: 'getSnapshot', call: () => service.getSnapshot(actor, childUserId) },
    { name: 'getDigest', call: () => service.getDigest(actor, childUserId) },
    { name: 'generateDigest', call: () => service.generateDigest(actor, childUserId) },
    { name: 'getChildTranscript', call: () => service.getChildTranscript(actor, childUserId, 20) },
    { name: 'getConsentState', call: () => service.getConsentState(actor, childUserId) },
    { name: 'revokeConsent', call: () => service.revokeConsent(actor, childUserId) },
  ];
}

/** Records a submitted practice session, so a week has real activity in it. */
async function practise(child: HarnessAccount, correct: number, total: number): Promise<void> {
  const chapterId = await insertChapter(
    harness.postgres.client,
    makeChapter(`ch${(emailCounter += 1)}`, { chapterNumber: emailCounter }),
  );
  const questionIds: string[] = [];
  for (let index = 0; index < total; index += 1) {
    questionIds.push(
      await insertQuestion(harness.postgres.client, chapterId, makeQuestion(`q${emailCounter}-${index}`)),
    );
  }

  const session = await harness.postgres.client.query<{ id: string }>(
    `insert into practice_sessions
       (student_user_id, chapter_id, question_ids, started_at, submitted_at,
        score_percent, xp_earned, is_valid, tenant_id)
     values ($1, $2, $3::uuid[], $4, $4, $5, 10, true, $6)
     returning id`,
    [
      child.userId,
      chapterId,
      questionIds,
      harness.clock.now(),
      Math.round((correct / total) * 100),
      TEST_TENANT_ID,
    ],
  );
  const sessionId = session.rows[0]?.id ?? '';

  for (const [index, questionId] of questionIds.entries()) {
    await harness.postgres.client.query(
      `insert into practice_responses
         (session_id, student_user_id, question_id, selected_index, is_correct,
          time_spent_ms, authored_difficulty, tenant_id, created_at)
       values ($1, $2, $3, 0, $4, 9000, 'medium', $5, $6)`,
      [sessionId, child.userId, questionId, index < correct, TEST_TENANT_ID, harness.clock.now()],
    );
  }
}

// ---------------------------------------------------------------------------
// THE ALLOW PATH
// ---------------------------------------------------------------------------

describe('an APPROVED link can read', () => {
  it('lists the child, with the profile learner holds', async () => {
    const { parent, child, linkId } = await makePair('approved');
    const children = await harness.parent.service.getChildren(parentActor(parent));

    expect(children).toHaveLength(1);
    expect(children[0]?.childUserId).toBe(child.userId);
    expect(children[0]?.linkId).toBe(linkId);
    expect(children[0]?.grade).toBe('8');
  });

  it('reads the weekly snapshot', async () => {
    const { parent, child } = await makePair('approved');
    await practise(child, 3, 4);

    const result = await harness.parent.service.getSnapshot(parentActor(parent), child.userId);
    expect(result.childUserId).toBe(child.userId);

    const headline = result.snapshot.headlines.find((entry) => entry.key === 'questions_answered');
    expect(headline?.value).toBe(4);
    // One day this week against none last week is a difference of one, which is
    // BELOW the two-day trend threshold — a Sunday that fell on the other side
    // of a Monday is noise, and reporting it would make almost every week
    // "more" and drain the trend of meaning.
    expect(result.snapshot.trend).toBe('about_the_same');
  });

  it('reads the consent state, including that the child was asked', async () => {
    const { parent, child, linkId } = await makePair('approved');
    const consent = await harness.parent.service.getConsentState(parentActor(parent), child.userId);

    expect(consent).toMatchObject({ childUserId: child.userId, linkId, status: 'approved' });
    expect(consent.childIsInformed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE FOUR DENY PATHS
// ---------------------------------------------------------------------------

describe('a PENDING link grants nothing', () => {
  it('refuses every read with a FORBIDDEN', async () => {
    // A pending link is a request, not a grant. The parent has typed a code the
    // student has not yet approved — if that read anything at all, the code
    // itself would be the whole security boundary.
    const { parent, child } = await makePair('pending');
    for (const { name, call } of everyChildRead(parentActor(parent), child.userId)) {
      await expect(call(), name).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    }
  });

  it('omits the child from the parent’s own list', async () => {
    // Listing it beside the approved ones invites a client to render both the
    // same way, and a rendered child is one a parent believes they can see.
    const { parent } = await makePair('pending');
    await expect(harness.parent.service.getChildren(parentActor(parent))).resolves.toEqual([]);
  });
});

describe('a REVOKED link grants nothing', () => {
  it('refuses every read with a FORBIDDEN', async () => {
    const { parent, child } = await makePair('revoked');
    for (const { name, call } of everyChildRead(parentActor(parent), child.userId)) {
      await expect(call(), name).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    }
  });
});

describe('NO link at all grants nothing', () => {
  it('refuses every read for an unlinked but real child', async () => {
    const { parent } = await makePair('approved');
    const stranger = await onboardAccount(harness, nextEmail('stranger'), 'student');
    await harness.learner.service.createProfile(studentActor(stranger), ONBOARDING);

    for (const { name, call } of everyChildRead(parentActor(parent), stranger.userId)) {
      await expect(call(), name).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    }
  });

  it('refuses every read for a child id that does not exist', async () => {
    const { parent } = await makePair('approved');
    for (const { name, call } of everyChildRead(parentActor(parent), NOBODY)) {
      await expect(call(), name).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    }
  });
});

describe('CROSS-TENANT is denied even when the link is approved', () => {
  /**
   * THE TEST D-091 EXISTS FOR.
   *
   * The link is genuinely approved — the student issued a code and approved it,
   * so `isLinkApproved` returns true and the consent half of the guard passes
   * cleanly. The ONLY thing refusing this read is the tenant comparison, and it
   * only refuses because the resource tenant is read from `users` rather than
   * echoed off the actor.
   *
   * If somebody "optimises" `readTenantOfStudent` to `() => actor.tenantId`,
   * every other test in this file still passes and this one is the single
   * assertion that goes red.
   */
  it('refuses a parent whose actor claims a different tenant from the child', async () => {
    await createSecondTenant(harness);
    const { parent, child } = await makePair('approved');

    // Same account, same approved link — only the claimed tenant differs.
    const foreign = parentActor(parent, OTHER_TENANT_ID);
    for (const { name, call } of everyChildRead(foreign, child.userId)) {
      await expect(call(), name).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    }
  });

  it('refuses `getChildren` to an actor whose claimed tenant is not their own', async () => {
    /**
     * A GAP THIS SUITE FOUND BY MUTATION, then closed.
     *
     * `getChildren` takes no child id, so it goes through `authoriseSelf`
     * rather than `authoriseChild` — and `authoriseSelf` reads the tenant from
     * `users` for the SAME reason `authoriseChild` does. Replacing it with
     * `actor.tenantId` was tried deliberately (see
     * `parent.authz-mutation.test.ts`) and NOTHING FAILED: the mutation made
     * `assertTenantMatch` compare a value with itself AND made the ownership
     * rule trivially true, so the whole function became a no-op that still read
     * like a boundary. That is D-091 exactly, in the one method that had no
     * test standing behind it.
     *
     * What it protects: a session whose actor carries a tenant the account no
     * longer belongs to — a user moved between tenants, a session minted before
     * a migration, or a forged actor. The account's tenant is a fact in the
     * database, and the claim on the session is not.
     */
    await createSecondTenant(harness);
    // A parent with NO children, deliberately. With a linked child the refusal
    // is ambiguous: `readChildProfile` runs learner's own independent guard,
    // which would refuse the same call for its own reasons — so a childless
    // parent is the only actor for whom `authoriseSelf` is the ONLY thing that
    // can say no.
    const lonely = await onboardAccount(harness, nextEmail('lonely'), 'parent');
    await harness.cache.close();

    await expect(
      harness.parent.service.getChildren(parentActor(lonely, OTHER_TENANT_ID)),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });

    // The control: the same account on its own tenant gets an empty list rather
    // than a refusal, so the assertion above is about the TENANT and not about
    // having no children.
    await expect(harness.parent.service.getChildren(parentActor(lonely))).resolves.toEqual([]);
  });

  it('still allows the same parent on their own tenant', async () => {
    // The control. Without it, a `readTenantOfStudent` that returned `null` for
    // everybody would make the test above pass for the wrong reason.
    await createSecondTenant(harness);
    const { parent, child } = await makePair('approved');
    await expect(
      harness.parent.service.getConsentState(parentActor(parent), child.userId),
    ).resolves.toMatchObject({ childUserId: child.userId });
  });
});

describe('the four denies are INDISTINGUISHABLE at the service layer', () => {
  /**
   * THE ORACLE TEST at the service boundary. The routes suite compares the raw
   * HTTP bodies; this one compares what the error itself will RENDER, which is
   * `toClientPayload()` — the exact object `error-handler.ts` sends.
   *
   * WHY THE CLIENT PAYLOAD AND NOT THE WHOLE ERROR. `ForbiddenError` carries two
   * messages on purpose: `message` and `details` are log-side and DO differ by
   * reason ("actor carries no tenant" vs "cross-tenant access"), which is what
   * makes an incident reviewable. `safeMessage` and `code` are what crosses the
   * wire, and those must not differ. Asserting on the whole error would demand
   * that the log lose information it is supposed to have; asserting on the
   * payload is the real contract.
   *
   * The second assertion is the one that keeps the split honest: the log-side
   * fields, however much they differ, must never name a student.
   */
  it('renders the same client payload for all four reasons', async () => {
    await createSecondTenant(harness);

    const pending = await makePair('pending');
    const revoked = await makePair('revoked');
    const approved = await makePair('approved');
    const stranger = await onboardAccount(harness, nextEmail('oracle'), 'student');
    await harness.learner.service.createProfile(studentActor(stranger), ONBOARDING);

    const attempts: readonly { readonly reason: string; readonly call: () => Promise<unknown> }[] = [
      {
        reason: 'pending link',
        call: () =>
          harness.parent.service.getSnapshot(parentActor(pending.parent), pending.child.userId),
      },
      {
        reason: 'revoked link',
        call: () =>
          harness.parent.service.getSnapshot(parentActor(revoked.parent), revoked.child.userId),
      },
      {
        reason: 'no link at all',
        call: () =>
          harness.parent.service.getSnapshot(parentActor(approved.parent), stranger.userId),
      },
      {
        reason: 'no such child',
        call: () => harness.parent.service.getSnapshot(parentActor(approved.parent), NOBODY),
      },
      {
        reason: 'another tenant',
        call: () =>
          harness.parent.service.getSnapshot(
            parentActor(approved.parent, OTHER_TENANT_ID),
            approved.child.userId,
          ),
      },
    ];

    const payloads: string[] = [];
    const statuses: number[] = [];
    const logSide: string[] = [];

    for (const { reason, call } of attempts) {
      const error = await call().then(
        () => {
          throw new Error(`${reason}: expected a refusal, got a result`);
        },
        (caught: unknown) => caught,
      );
      if (!isAppError(error)) throw new Error(`${reason}: refusal was not an AppError`);

      payloads.push(JSON.stringify(error.toClientPayload()));
      statuses.push(error.httpStatus);
      logSide.push(JSON.stringify({ message: error.message, details: error.details }));
    }

    // ONE distinct payload and ONE status across five different reasons. A
    // second entry here means a caller can tell them apart, which means they can
    // enumerate children.
    expect(new Set(payloads).size).toBe(1);
    expect(new Set(statuses)).toEqual(new Set([403]));

    // The log side may differ — that is what makes an incident reviewable — but
    // it must never name the student whose existence is being probed.
    for (const line of logSide) {
      expect(line).not.toContain(approved.child.userId);
      expect(line).not.toContain(pending.child.userId);
      expect(line).not.toContain(stranger.userId);
      expect(line).not.toContain(NOBODY);
      expect(line).not.toMatch(/@example\.test/);
    }
  });
});

// ---------------------------------------------------------------------------
// REVOCATION IS IMMEDIATE
// ---------------------------------------------------------------------------

describe('consent revocation takes effect on the very next call', () => {
  it('reads successfully, revokes, and is refused — in one test', async () => {
    /**
     * THE WHOLE POINT OF READING LINK STATUS AT QUERY TIME (§7 rule 3).
     *
     * Written as one test body deliberately. Split across two tests, a cached
     * status would still pass both: the second test starts a new request. It is
     * the SECOND CALL INSIDE ONE TEST that a cache would break, and no `sleep`
     * is involved — the effect is supposed to be synchronous, not eventual.
     */
    const { parent, child } = await makePair('approved');
    const actor = parentActor(parent);

    await expect(
      harness.parent.service.getSnapshot(actor, child.userId),
    ).resolves.toMatchObject({ childUserId: child.userId });

    const revocation = await harness.parent.service.revokeConsent(actor, child.userId);
    expect(revocation.status).toBe('revoked');

    await expect(harness.parent.service.getSnapshot(actor, child.userId)).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN,
    });
  });

  it('makes a SECOND revoke a contentless refusal, not a cheerful 200', async () => {
    // Once revoked, this parent is exactly a parent who never had a link — and
    // must be told exactly what that parent is told.
    const { parent, child } = await makePair('approved');
    const actor = parentActor(parent);
    await harness.parent.service.revokeConsent(actor, child.userId);

    await expect(harness.parent.service.revokeConsent(actor, child.userId)).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN,
    });
  });

  it('drops the child from the parent’s list immediately', async () => {
    const { parent, child } = await makePair('approved');
    const actor = parentActor(parent);
    await harness.parent.service.revokeConsent(actor, child.userId);
    await expect(harness.parent.service.getChildren(actor)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE DIGEST
// ---------------------------------------------------------------------------

describe('digest generation is idempotent per (parent, child, week)', () => {
  it('creates once and reports `created: false` on the second run', async () => {
    const { parent, child } = await makePair('approved');
    await practise(child, 3, 4);
    const actor = parentActor(parent);

    const first = await harness.parent.service.generateDigest(actor, child.userId);
    const second = await harness.parent.service.generateDigest(actor, child.userId);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.digest.id).toBe(first.digest.id);
    expect(second.digest.generatedAt.toISOString()).toBe(first.digest.generatedAt.toISOString());
  });

  it('writes exactly one row', async () => {
    // The property the `created` flag is a proxy for. "Running twice must not
    // send twice" is only true if the second run wrote nothing.
    const { parent, child } = await makePair('approved');
    await practise(child, 3, 4);
    const actor = parentActor(parent);

    await harness.parent.service.generateDigest(actor, child.userId);
    await harness.parent.service.generateDigest(actor, child.userId);

    const rows = await harness.postgres.client.query(
      `select 1 from weekly_digests where parent_user_id = $1 and student_user_id = $2`,
      [parent.userId, child.userId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('returns a real Date for generatedAt, not the driver’s wire string', async () => {
    /**
     * A DEFECT THIS SUITE FOUND, pinned so it cannot come back.
     *
     * `parent.repository` declared `generated_at: Date` on its row type and
     * passed the value straight through to `DigestRecord.generatedAt`, which is
     * also typed `Date`. It was a STRING. Drizzle's `db.execute()` runs raw SQL
     * and does not install node-postgres's `timestamptz` parser, so the row
     * carries the wire text `'2026-08-10 14:01:20.396047+00'`.
     *
     * Nothing was ever going to catch this on its own: `db.execute<Row>` is an
     * unchecked claim, so the compiler believed `Date` all the way to the
     * service's public type, and the value serialises to JSON without
     * complaint — as a subtly different string from the ISO timestamp every
     * other endpoint emits. It fails only when somebody calls a `Date` method,
     * which is what the idempotence test above does.
     *
     * `instanceof` rather than a duck-typed check, deliberately: a string with a
     * `toISOString` shim would satisfy anything softer.
     */
    const { parent, child } = await makePair('approved');
    const actor = parentActor(parent);
    const { digest } = await harness.parent.service.generateDigest(actor, child.userId);

    expect(digest.generatedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(digest.generatedAt.getTime())).toBe(false);

    // And the same object read back through the GET path, which is a different
    // query in the same repository.
    const read = await harness.parent.service.getDigest(actor, child.userId);
    expect(read?.generatedAt).toBeInstanceOf(Date);
    // `weekStart` stays the `YYYY-MM-DD` the wire contract promises. The naive
    // repair for the above — `String(value).slice(0, 10)` — turns a `Date` into
    // `'Mon Jun 0'`, which is still a string and still ten characters.
    expect(read?.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is keyed by WEEK — a different week generates its own', async () => {
    const { parent, child } = await makePair('approved');
    await practise(child, 3, 4);
    const actor = parentActor(parent);

    const thisWeek = await harness.parent.service.generateDigest(actor, child.userId);
    // Injected clock, not a sleep: an explicit `at` for a week seven days back.
    const lastWeek = await harness.parent.service.generateDigest(
      actor,
      child.userId,
      new Date(harness.clock.now().getTime() - 7 * 24 * 60 * 60 * 1000),
    );

    expect(lastWeek.created).toBe(true);
    expect(lastWeek.digest.id).not.toBe(thisWeek.digest.id);
    expect(lastWeek.digest.weekStart).not.toBe(thisWeek.digest.weekStart);
  });

  it('is settled by the DATABASE when the application pre-check cannot help', async () => {
    /**
     * ========================================================================
     * THE OTHER HALF OF IDEMPOTENCY, AND THE HALF THAT WAS UNOBSERVED.
     *
     * `parent.repository.insertDigest` ends in `ON CONFLICT ... DO NOTHING`,
     * and the comment above it makes a specific claim: two concurrent
     * generations — a parent tapping refresh while the weekly worker runs —
     * would BOTH find nothing on the `findDigest` pre-check and BOTH insert, so
     * "the unique index is the only thing that can settle that".
     *
     * Changing that clause to `DO UPDATE` left 150/150 green. Every existing
     * idempotency test calls `generateDigest` twice IN SEQUENCE, so the
     * application-level pre-check answers first and the INSERT never runs a
     * second time — the database half is never reached, and therefore never
     * observed.
     *
     * This test goes STRAIGHT TO THE REPOSITORY, which is what a concurrent
     * second caller effectively does: it has already passed the pre-check, and
     * the statement is all that is left. Two properties, not one:
     *
     *   `created: false`   — the loser reports truthfully, so the caller does
     *                        not send a second digest email.
     *   THE ROW IS UNCHANGED — `DO UPDATE` returns a row (so `created` would be
     *                        `true`) AND overwrites a digest a parent may
     *                        already have read, with a different summary and a
     *                        different `generatedAt`.
     * ========================================================================
     */
    const { parent, child } = await makePair('approved');
    const repository = createParentRepository(harness.container.poolFor('parent'));

    const weekStart = weekKeyOf(harness.clock.now());
    const base: NewDigest = {
      parentUserId: parent.userId,
      studentUserId: child.userId,
      weekStart,
      summary: { en: 'The FIRST summary.', hi: 'पहला सारांश।' },
      suggestedAction: { en: 'Ask about fractions.', hi: 'भिन्न के बारे में पूछें।' },
      misconceptionCode: null,
      sessionsCount: 3,
      questionsAnswered: 12,
      daysPractised: 2,
      chapterId: null,
      tenantId: TEST_TENANT_ID,
      generatedAt: harness.clock.now(),
    };

    const first = await repository.insertDigest(base);
    // A DIFFERENT payload, so an overwrite is visible rather than merely
    // possible. Same key, which is the only thing the constraint looks at.
    const second = await repository.insertDigest({
      ...base,
      summary: { en: 'The SECOND summary.', hi: 'दूसरा सारांश।' },
      sessionsCount: 99,
      generatedAt: new Date(harness.clock.now().getTime() + 60_000),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const stored = await repository.findDigest(parent.userId, child.userId, weekStart);
    expect(stored?.summary.en).toBe('The FIRST summary.');
    expect(stored?.sessionsCount).toBe(3);
    expect(stored?.generatedAt.getTime()).toBe(base.generatedAt.getTime());

    // And still exactly one row — an upsert would also satisfy a count of one,
    // which is why the assertions above are about the CONTENT.
    const rows = await harness.postgres.client.query(
      `select 1 from weekly_digests where parent_user_id = $1 and student_user_id = $2`,
      [parent.userId, child.userId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('does not generate on a GET — reading a page must not write a row', async () => {
    const { parent, child } = await makePair('approved');
    await practise(child, 3, 4);
    const actor = parentActor(parent);

    await expect(harness.parent.service.getDigest(actor, child.userId)).resolves.toBeNull();

    const rows = await harness.postgres.client.query(`select 1 from weekly_digests`);
    expect(rows.rowCount).toBe(0);
  });
});

describe('a QUIET week produces a graceful digest, never an empty one', () => {
  it('says plainly that nothing was finished, in both languages', async () => {
    /**
     * §8.7: "a graceful message rather than an empty digest".
     *
     * A parent who hears nothing cannot tell "they did not practise" from "the
     * email failed", and the second reading is the one that erodes trust in the
     * product. So a week with no activity still produces five real lines.
     */
    const { parent, child } = await makePair('approved');
    const actor = parentActor(parent);

    const { digest } = await harness.parent.service.generateDigest(actor, child.userId);

    expect(digest.sessionsCount).toBe(0);
    expect(digest.questionsAnswered).toBe(0);
    expect(digest.summary.en.trim().length).toBeGreaterThan(0);
    expect(digest.summary.hi.trim().length).toBeGreaterThan(0);
    expect(digest.suggestedAction.en.trim().length).toBeGreaterThan(0);
    expect(digest.suggestedAction.hi.trim().length).toBeGreaterThan(0);
    // P7 — the Hindi half is real Devanagari, not the English copied across.
    expect(digest.summary.hi).toMatch(/[ऀ-ॿ]/u);
  });

  it('names no misconception it did not observe', async () => {
    const { parent, child } = await makePair('approved');
    const { digest } = await harness.parent.service.generateDigest(
      parentActor(parent),
      child.userId,
    );
    expect(digest.misconceptionCode).toBeNull();
  });
});

describe('a week with NO MISCONCEPTION DATA says what improved instead', () => {
  /**
   * THIS IS THE NORMAL CASE, NOT THE EDGE CASE.
   *
   * `questions.distractor_misconceptions` is NULL corpus-wide (D-077), so
   * essentially every real week today has no misconception to name. The
   * composer degrades — it reports effort and what got better — and it NEVER
   * invents one, because a parent cannot tell a fabricated misconception from a
   * real one and will act on it by correcting a child who was not making that
   * mistake.
   */
  it('produces a digest with real content and a null misconception code', async () => {
    const { parent, child } = await makePair('approved');
    await practise(child, 4, 4);

    const { digest } = await harness.parent.service.generateDigest(
      parentActor(parent),
      child.userId,
    );

    expect(digest.misconceptionCode).toBeNull();
    expect(digest.questionsAnswered).toBe(4);
    // Five lines of substance, not a placeholder.
    expect(digest.summary.en.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(5);
  });

  it('never prints a percentage or a score in either language', async () => {
    // §8.7 in one assertion. "60 percent in Science" is the thing this feature
    // exists NOT to say, and the honesty gate refuses it — from the
    // deterministic composer as readily as from a language model.
    const { parent, child } = await makePair('approved');
    await practise(child, 3, 4);

    const { digest } = await harness.parent.service.generateDigest(
      parentActor(parent),
      child.userId,
    );

    for (const text of [
      digest.summary.en,
      digest.summary.hi,
      digest.suggestedAction.en,
      digest.suggestedAction.hi,
    ]) {
      expect(text).not.toMatch(/%|per\s?cent|प्रतिशत/iu);
    }
  });

  it('never puts the child’s name in the digest', async () => {
    // The digest text is persisted through notify's payload and is what a real
    // LLM adapter would be asked to write — and `platform/llm`'s port forbids a
    // name reaching a model at all. "Your child", never "Aarav".
    const { parent, child } = await makePair('approved');
    await practise(child, 3, 4);

    const { digest } = await harness.parent.service.generateDigest(
      parentActor(parent),
      child.userId,
    );
    expect(`${digest.summary.en} ${digest.summary.hi}`).not.toContain(ONBOARDING.displayName);
  });
});

// ---------------------------------------------------------------------------
// THE TRANSCRIPT
// ---------------------------------------------------------------------------

describe('the transcript is read-only and the child-visibility flag is ALWAYS present', () => {
  it('carries readOnly, the visibility block and the disclosure the child is shown', async () => {
    /**
     * A parent reading a child's conversations is a surveillance capability. The
     * only thing separating it from surveillance is that the child knows — so
     * the flag is part of the RESPONSE rather than a line in a privacy policy,
     * and it is asserted here so it cannot quietly become optional.
     */
    const { parent, child } = await makePair('approved');
    const transcript = await harness.parent.service.getChildTranscript(
      parentActor(parent),
      child.userId,
      20,
    );

    expect(transcript.readOnly).toBe(true);
    expect(transcript.visibility.parentCanView).toBe(true);
    expect(transcript.visibility.childIsTold).toBe(true);
    expect(transcript.visibility.disclosure.en.trim().length).toBeGreaterThan(0);
    expect(transcript.visibility.disclosure.hi).toMatch(/[ऀ-ॿ]/u);
  });

  it('distinguishes "no conversations" from "foxy has not shipped"', async () => {
    /**
     * THIS ASSERTION HAS FLIPPED, AND THE FLIP IS THE POINT.
     *
     * It read `not_yet_available` while `chat_sessions` did not exist. Migration
     * `0005_foxy` created it, so the catalogue probe in
     * `parent.repository.readTranscript` now returns true and the source is
     * `'foxy'` with an empty session list — which is the honest statement that
     * this child has had no conversations, rather than the honest statement that
     * the feature had not shipped.
     *
     * Both halves still matter. An empty list with no explanation would tell a
     * parent their child has never used the tutor, and before 0005 that would
     * have been false. The probe is what keeps the two distinguishable, and this
     * test is what proves the probe actually switched over rather than staying
     * stuck on its pre-foxy answer.
     */
    const { parent, child } = await makePair('approved');
    const transcript = await harness.parent.service.getChildTranscript(
      parentActor(parent),
      child.userId,
      20,
    );

    expect(transcript.source).toBe('foxy');
    expect(transcript.sessions).toEqual([]);
  });

  it('exposes no write path — the module writes exactly one table', () => {
    // Structural, and it is the assertion that keeps `readOnly: true` honest.
    // `weekly_digests` is the only table `parent` writes; a transcript UPDATE
    // appearing in the repository would break this.
    const methods = Object.keys(harness.parent.service);
    expect(methods.filter((name) => /transcript/i.test(name))).toEqual(['getChildTranscript']);
  });
});

// ---------------------------------------------------------------------------
// THE AUDIT TRAIL
// ---------------------------------------------------------------------------

describe('audit entries carry NO PII', () => {
  async function auditRows(): Promise<
    readonly { action: string; resource_id: string | null; metadata: unknown }[]
  > {
    const result = await harness.postgres.client.query<{
      action: string;
      resource_id: string | null;
      metadata: unknown;
    }>(`select action, resource_id, metadata from audit_log order by created_at`);
    return result.rows;
  }

  it('records a transcript read, with counts only', async () => {
    const { parent, child } = await makePair('approved');
    await harness.parent.service.getChildTranscript(parentActor(parent), child.userId, 20);

    const rows = (await auditRows()).filter((row) => row.action === 'parent.transcript_viewed');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe(child.userId);
    // Counts and booleans. Never a message, never a name, never an address.
    // `available` flipped to true with migration `0005_foxy` — the tables now
    // exist, so the transcript path is live and reporting an empty history
    // rather than a missing feature.
    expect(rows[0]?.metadata).toMatchObject({ sessions: 0, available: true });
  });

  it('records a consent revocation, distinct from identity’s own row', async () => {
    // Deliberate duplication: identity writes `identity.link_revoked` for the
    // same event. That row says a link changed state, by either party; this one
    // says a PARENT withdrew their own access, which is the question a school or
    // a regulator asks and which the identity row cannot answer without joining
    // to the role of an actor who may have changed role since.
    const { parent, child, linkId } = await makePair('approved');
    await harness.parent.service.revokeConsent(parentActor(parent), child.userId);

    const actions = (await auditRows()).map((row) => row.action);
    expect(actions).toContain('parent.consent_revoked');
    expect(actions).toContain('identity.link_revoked');

    const consentRow = (await auditRows()).find((row) => row.action === 'parent.consent_revoked');
    expect(consentRow?.resource_id).toBe(linkId);
  });

  it('contains no email address, name or password anywhere in the trail', async () => {
    /**
     * THE BROAD SWEEP. Asserted over the SERIALISED ROW rather than over named
     * fields, because the failure mode is somebody adding a helpful field —
     * `childName`, `parentEmail` — to make a support screen easier, and a
     * per-field assertion would not see it.
     */
    const { parent, child } = await makePair('approved');
    const actor = parentActor(parent);
    await harness.parent.service.getChildTranscript(actor, child.userId, 20);
    await harness.parent.service.revokeConsent(actor, child.userId);

    const serialised = JSON.stringify(await auditRows());
    expect(serialised).not.toMatch(/@example\.test/);
    expect(serialised).not.toContain(ONBOARDING.displayName);
    expect(serialised).not.toMatch(/password/i);
  });

  it('writes NO audit row for a refused read', async () => {
    // A deny must not leave a trace a caller could provoke: an audit row per
    // rejected id is an enumeration oracle written to durable storage.
    const { parent } = await makePair('approved');
    await expect(
      harness.parent.service.getChildTranscript(parentActor(parent), NOBODY, 20),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });

    const rows = (await auditRows()).filter((row) => row.action.startsWith('parent.'));
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE SYSTEM PATH — the weekly worker, which has no actor
// ---------------------------------------------------------------------------

describe('the worker path is authorised from the DATA, with no actor at all', () => {
  it('builds a digest for every approved child of a parent', async () => {
    const { parent, child } = await makePair('approved');
    await practise(child, 3, 4);

    const built = await harness.parent.service.buildWeeklyDigestFor(
      parent.userId,
      harness.clock.now(),
    );
    expect(built).toHaveLength(1);
    expect(built[0]?.created).toBe(true);
  });

  it('builds NOTHING for a pending link — there is no argument that could widen it', async () => {
    const { parent } = await makePair('pending');
    await expect(
      harness.parent.service.buildWeeklyDigestFor(parent.userId, harness.clock.now()),
    ).resolves.toEqual([]);
  });

  it('builds NOTHING for a revoked link', async () => {
    const { parent } = await makePair('revoked');
    await expect(
      harness.parent.service.buildWeeklyDigestFor(parent.userId, harness.clock.now()),
    ).resolves.toEqual([]);
  });

  it('lists only parents holding at least one approved link', async () => {
    const approved = await makePair('approved');
    const pending = await makePair('pending');

    const due = await harness.parent.service.listParentsDue();
    expect(due).toContain(approved.parent.userId);
    expect(due).not.toContain(pending.parent.userId);
  });

  it('SKIPS an approved link whose two sides are in different tenants', async () => {
    /**
     * The worker's version of the tenant check. There is no `assertCanAccess`
     * here because there is no actor, so the rule has to be expressed against
     * the rows — and this is the assertion that it is expressed at all.
     */
    await createSecondTenant(harness);
    const { parent, child } = await makePair('approved');
    await practise(child, 3, 4);

    // Move the CHILD to the other tenant, leaving the approved link in place.
    await harness.postgres.client.query(`update users set tenant_id = $1 where id = $2`, [
      OTHER_TENANT_ID,
      child.userId,
    ]);

    await expect(
      harness.parent.service.buildWeeklyDigestFor(parent.userId, harness.clock.now()),
    ).resolves.toEqual([]);
  });
});
