import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '@/platform/errors/index';
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
import { insertChapter, makeChapter } from '../../../../tests/fixtures/index';

/**
 * learner service tests — a real Postgres, faked everything else (§9.1).
 *
 * The four §8.2 requirements that live at this level:
 *
 *   onboarding is idempotent
 *   a student cannot read another student's profile
 *   mastery clamps to 0..1                       (also unit-tested, purely)
 *   a parent reads an APPROVED child and nobody else
 *
 * The deny tests assert something stronger than a status code: that the
 * refusal carries NO STUDENT DATA AT ALL. A 403 whose body helpfully explains
 * that the student exists but is not linked is the same enumeration leak the
 * identical-signup-response defence closes, delivered on a different endpoint.
 */

let harness: AppHarness;

const ONBOARDING: OnboardingRequest = {
  displayName: 'Aarav',
  grade: '8',
  subjects: ['science', 'maths'],
};

beforeAll(async () => {
  harness = await startAppHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

function actorOf(
  account: HarnessAccount,
  role: 'student' | 'parent' = 'student',
): {
  userId: string;
  role: 'student' | 'parent';
  tenantId: string;
} {
  // Every harness account is created through the real signup route, so its row
  // carries the seeded tenant. Stating it here rather than reading it back keeps
  // the actor a plain literal - and makes the CROSS-TENANT tests, which pass a
  // different value deliberately, visibly different from the ordinary ones.
  return { userId: account.userId, role, tenantId: TEST_TENANT_ID };
}

describe('createProfile — onboarding is idempotent (§8.2)', () => {
  it('creates the profile and its subjects on the first call', async () => {
    const student = await onboardAccount(harness, 'idem1@example.test', 'student');
    const result = await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    expect(result.created).toBe(true);
    expect(result.profile.grade).toBe('8');
    expect(result.subjects).toEqual(['maths', 'science']);
  });

  it('CHANGES NOTHING on a second identical call', async () => {
    const student = await onboardAccount(harness, 'idem2@example.test', 'student');
    const first = await harness.learner.service.createProfile(actorOf(student), ONBOARDING);
    const second = await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    expect(second.created).toBe(false);
    expect(second.profile.createdAt.toISOString()).toBe(first.profile.createdAt.toISOString());
  });

  it('creates no duplicate rows on a repeated call', async () => {
    const student = await onboardAccount(harness, 'idem3@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    const students = await harness.postgres.client.query(
      `select 1 from students where user_id = $1`,
      [student.userId],
    );
    const subjects = await harness.postgres.client.query(
      `select 1 from student_subjects where student_user_id = $1`,
      [student.userId],
    );
    expect(students.rowCount).toBe(1);
    expect(subjects.rowCount).toBe(2);
  });

  it('does NOT reset the grade when a stale retry carries an older one', async () => {
    // THE FAILURE THIS TEST EXISTS FOR. Onboarding is the screen straight
    // after email verification and a retry is normal — the user taps twice,
    // the connection drops after the write. If the repository used
    // `ON CONFLICT DO UPDATE`, a replayed request from last term would
    // silently move the student back to grade 8 and change every chapter they
    // see. `DO NOTHING` is what makes that impossible.
    const student = await onboardAccount(harness, 'idem4@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), { ...ONBOARDING, grade: '9' });

    const replay = await harness.learner.service.createProfile(actorOf(student), {
      ...ONBOARDING,
      grade: '8',
      displayName: 'Stale Name',
    });

    expect(replay.created).toBe(false);
    expect(replay.profile.grade).toBe('9');
    expect(replay.profile.displayName).toBe('Aarav');
  });

  it('does NOT reset mastery a student has since earned', async () => {
    // The other half of "must not reset progress". A retry arriving after the
    // student has practised must leave their record alone.
    const student = await onboardAccount(harness, 'idem5@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    const chapterId = await insertChapter(harness.postgres.client, makeChapter('idem'));
    await harness.learner.service.updateMastery(actorOf(student), {
      studentUserId: student.userId,
      chapterId,
      masteryScore: 0.6,
      expectedPreviousScore: null,
    });

    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    const mastery = await harness.learner.service.getMastery(actorOf(student), student.userId);
    expect(mastery).toHaveLength(1);
    expect(mastery[0]?.masteryScore).toBe(0.6);
  });

  it('ADDS a newly chosen subject on a repeat call', async () => {
    // Idempotent is not inert. A second call with one extra subject adds
    // exactly that one, and removes nothing.
    const student = await onboardAccount(harness, 'idem6@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);
    const second = await harness.learner.service.createProfile(actorOf(student), {
      ...ONBOARDING,
      subjects: ['science', 'english'],
    });

    expect(second.subjects).toEqual(['english', 'maths', 'science']);
  });

  it('accepts a payload listing the same subject twice', async () => {
    // The composite primary key would reject a duplicate, and a 409 on a UI
    // that let the user tap a chip twice is a defect report we would rather
    // not receive. Deduplicated before the insert.
    const student = await onboardAccount(harness, 'idem7@example.test', 'student');
    const result = await harness.learner.service.createProfile(actorOf(student), {
      ...ONBOARDING,
      subjects: ['science', 'science'],
    });
    expect(result.subjects).toEqual(['science']);
  });

  it('refuses a PARENT trying to onboard — a parent never acts for a child', async () => {
    const parent = await onboardAccount(harness, 'idem8@example.test', 'parent');
    await expect(
      harness.learner.service.createProfile(actorOf(parent, 'parent'), ONBOARDING),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('logs onboarding WITHOUT the display name or any subject code', async () => {
    // §11: no personal data in a log line. "A student onboarded" is the
    // operationally useful half; the name is not.
    const student = await onboardAccount(harness, 'idem9@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    const line = harness.logger.lines.find((entry) => entry.msg === 'learner.onboarding');
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).not.toContain('Aarav');
    expect(JSON.stringify(line)).not.toContain('science');
  });
});

describe('getProfile — a student cannot read another student’s profile (§8.2)', () => {
  it('returns the caller’s own profile', async () => {
    const student = await onboardAccount(harness, 'own@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    const profile = await harness.learner.service.getProfile(actorOf(student), student.userId);
    expect(profile.userId).toBe(student.userId);
  });

  it('DENIES a student reading another student’s profile', async () => {
    const alice = await onboardAccount(harness, 'alice@example.test', 'student');
    const bob = await onboardAccount(harness, 'bob@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(bob), ONBOARDING);

    await expect(
      harness.learner.service.getProfile(actorOf(alice), bob.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('leaks NOTHING on the deny path — no name, no grade, no id', async () => {
    // The rule that matters more than the status code. The client-facing
    // payload is the fixed string "Forbidden." and the log-side details carry
    // a role and an action, never an identifier.
    const alice = await onboardAccount(harness, 'alice2@example.test', 'student');
    const bob = await onboardAccount(harness, 'bob2@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(bob), {
      ...ONBOARDING,
      displayName: 'Bobby',
      grade: '11',
    });

    try {
      await harness.learner.service.getProfile(actorOf(alice), bob.userId);
      expect.unreachable('a student read another student’s profile');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      const payload = JSON.stringify((error as ForbiddenError).toClientPayload());
      expect(payload).not.toContain('Bobby');
      expect(payload).not.toContain(bob.userId);
      expect(payload).not.toContain('11');
      expect(JSON.stringify((error as ForbiddenError).details)).not.toContain(bob.userId);
    }
  });

  it('denies IDENTICALLY whether or not the other student has a profile', async () => {
    // Otherwise the difference between two refusals is itself a way to
    // discover which accounts exist.
    const alice = await onboardAccount(harness, 'alice3@example.test', 'student');
    const withProfile = await onboardAccount(harness, 'has@example.test', 'student');
    const without = await onboardAccount(harness, 'hasnt@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(withProfile), ONBOARDING);

    const first = await harness.learner.service
      .getProfile(actorOf(alice), withProfile.userId)
      .catch((error: unknown) => error);
    const second = await harness.learner.service
      .getProfile(actorOf(alice), without.userId)
      .catch((error: unknown) => error);

    expect(JSON.stringify((first as ForbiddenError).toClientPayload())).toBe(
      JSON.stringify((second as ForbiddenError).toClientPayload()),
    );
  });

  it('404s for a caller with no profile — and says nothing more', async () => {
    const student = await onboardAccount(harness, 'noprofile@example.test', 'student');
    await expect(
      harness.learner.service.getProfile(actorOf(student), student.userId),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('a parent reads an APPROVED child and nobody else', () => {
  /** Runs the full link dance and returns both accounts. */
  async function link(
    parentEmail: string,
    studentEmail: string,
    approve: boolean,
  ): Promise<{ parent: HarnessAccount; student: HarnessAccount }> {
    const parent = await onboardAccount(harness, parentEmail, 'parent');
    const student = await onboardAccount(harness, studentEmail, 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    const issued = await harness.identity.service.generateLinkCode(actorOf(student));
    const linkRecord = await harness.identity.service.submitLinkCode(
      actorOf(parent, 'parent'),
      issued.code,
    );
    if (approve) {
      await harness.identity.service.approveLink(actorOf(student), linkRecord.id);
    }
    return { parent, student };
  }

  it('allows a parent with an APPROVED link to read the profile', async () => {
    const { parent, student } = await link('p1@example.test', 's1@example.test', true);
    const profile = await harness.learner.service.getProfile(
      actorOf(parent, 'parent'),
      student.userId,
    );
    expect(profile.userId).toBe(student.userId);
  });

  it('DENIES a parent whose link is only pending', async () => {
    // A code grants nothing. Approval is the step that grants access (§6.8).
    const { parent, student } = await link('p2@example.test', 's2@example.test', false);
    await expect(
      harness.learner.service.getProfile(actorOf(parent, 'parent'), student.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('DENIES an unlinked parent', async () => {
    const parent = await onboardAccount(harness, 'p3@example.test', 'parent');
    const student = await onboardAccount(harness, 's3@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    await expect(
      harness.learner.service.getProfile(actorOf(parent, 'parent'), student.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('stops reading IMMEDIATELY after revocation, with no re-login', async () => {
    // §7 rule 3: link status is read at query time, never taken from the
    // session. The parent below holds the same live session throughout.
    const { parent, student } = await link('p4@example.test', 's4@example.test', true);
    await expect(
      harness.learner.service.getProfile(actorOf(parent, 'parent'), student.userId),
    ).resolves.toBeDefined();

    const links = await harness.postgres.client.query<{ id: string }>(
      `select id from parent_child_links where student_user_id = $1`,
      [student.userId],
    );
    await harness.identity.service.revokeLink(actorOf(student), links.rows[0]?.id ?? '');

    await expect(
      harness.learner.service.getProfile(actorOf(parent, 'parent'), student.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses an approved parent trying to WRITE — a parent observes only', async () => {
    const { parent, student } = await link('p5@example.test', 's5@example.test', true);
    await expect(
      harness.learner.service.updateProfile(actorOf(parent, 'parent'), student.userId, {
        displayName: 'Renamed By Parent',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets an approved parent read mastery, which is a different scope', async () => {
    const { parent, student } = await link('p6@example.test', 's6@example.test', true);
    await expect(
      harness.learner.service.getMastery(actorOf(parent, 'parent'), student.userId),
    ).resolves.toEqual([]);
  });
});

describe('updateProfile', () => {
  it('applies a single field and leaves the rest alone', async () => {
    const student = await onboardAccount(harness, 'patch1@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    const updated = await harness.learner.service.updateProfile(
      actorOf(student),
      student.userId,
      { displayName: 'Aarav K' },
    );

    expect(updated.displayName).toBe('Aarav K');
    expect(updated.grade).toBe('8');
    expect(updated.preferredLanguage).toBe('en');
  });

  it('moves a student up a grade', async () => {
    const student = await onboardAccount(harness, 'patch2@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    const updated = await harness.learner.service.updateProfile(actorOf(student), student.userId, {
      grade: '9',
    });
    expect(updated.grade).toBe('9');
  });

  it('advances updated_at through the INJECTED clock', async () => {
    // No `new Date()` anywhere in the module. Every timestamp it writes is one
    // a test can move, which is what makes anything time-dependent testable.
    const student = await onboardAccount(harness, 'patch3@example.test', 'student');
    const created = await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    harness.clock.advanceDays(3);
    const updated = await harness.learner.service.updateProfile(actorOf(student), student.userId, {
      displayName: 'Later',
    });

    expect(updated.updatedAt.getTime() - created.profile.updatedAt.getTime()).toBe(
      3 * 24 * 60 * 60 * 1000,
    );
  });

  it('404s when there is no profile to patch', async () => {
    const student = await onboardAccount(harness, 'patch4@example.test', 'student');
    await expect(
      harness.learner.service.updateProfile(actorOf(student), student.userId, {
        displayName: 'Ghost',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('getSubjects', () => {
  it('returns the student’s subjects, sorted', async () => {
    const student = await onboardAccount(harness, 'subj1@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);
    await expect(harness.learner.service.getSubjects(actorOf(student), student.userId)).resolves.toEqual(
      ['maths', 'science'],
    );
  });

  it('denies another student’s subjects', async () => {
    const alice = await onboardAccount(harness, 'subj2@example.test', 'student');
    const bob = await onboardAccount(harness, 'subj3@example.test', 'student');
    await expect(
      harness.learner.service.getSubjects(actorOf(alice), bob.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('updateMastery — the clamp, against a real CHECK constraint', () => {
  let chapterId: string;
  let student: HarnessAccount;

  beforeEach(async () => {
    student = await onboardAccount(harness, 'mastery@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);
    chapterId = await insertChapter(harness.postgres.client, makeChapter('mastery'));
  });

  it('writes a mid-range score', async () => {
    const record = await harness.learner.service.updateMastery(actorOf(student), {
      studentUserId: student.userId,
      chapterId,
      masteryScore: 0.42,
      expectedPreviousScore: null,
    });
    expect(record?.masteryScore).toBe(0.42);
    expect(record?.attempts).toBe(1);
  });

  it('CLAMPS an above-range score to 1 instead of hitting the constraint', async () => {
    // If the clamp were missing, this would raise
    // `chapter_mastery_score_check` — which is exactly the backstop's job, and
    // exactly why the clamp has to run first. Both, not either.
    const record = await harness.learner.service.updateMastery(actorOf(student), {
      studentUserId: student.userId,
      chapterId,
      masteryScore: 1.4,
      expectedPreviousScore: null,
    });
    expect(record?.masteryScore).toBe(1);
  });

  it('clamps a below-range score to 0', async () => {
    const record = await harness.learner.service.updateMastery(actorOf(student), {
      studentUserId: student.userId,
      chapterId,
      masteryScore: -0.5,
      expectedPreviousScore: null,
    });
    expect(record?.masteryScore).toBe(0);
  });

  it('ACCUMULATES attempts across calls rather than overwriting them', async () => {
    // Incremented in SQL, not read-modify-written: two overlapping submissions
    // from one student — a double tap on a flaky connection — must not lose an
    // attempt.
    await harness.learner.service.updateMastery(actorOf(student), {
      studentUserId: student.userId,
      chapterId,
      masteryScore: 0.3,
      expectedPreviousScore: null,
    });
    const second = await harness.learner.service.updateMastery(actorOf(student), {
      studentUserId: student.userId,
      chapterId,
      masteryScore: 0.5,
      expectedPreviousScore: 0.3,
    });

    expect(second?.attempts).toBe(2);
    expect(second?.masteryScore).toBe(0.5);
  });

  it('stamps last_practised_at from the injected clock', async () => {
    const record = await harness.learner.service.updateMastery(actorOf(student), {
      studentUserId: student.userId,
      chapterId,
      masteryScore: 0.3,
      expectedPreviousScore: null,
    });
    expect(record?.lastPractisedAt?.toISOString()).toBe(harness.clock.now().toISOString());
  });

  it('leaves last_practised_at alone for a correction that is not an attempt', async () => {
    // The streak and the "last practised" line on the parent digest both read
    // this column. A mastery correction must not claim the student practised.
    await harness.learner.service.updateMastery(actorOf(student), {
      studentUserId: student.userId,
      chapterId,
      masteryScore: 0.3,
      expectedPreviousScore: null,
    });
    const practisedAt = harness.clock.now().toISOString();

    harness.clock.advanceDays(5);
    const corrected = await harness.learner.service.updateMastery(actorOf(student), {
      studentUserId: student.userId,
      chapterId,
      masteryScore: 0.35,
      expectedPreviousScore: 0.3,
      attemptIncrement: 0,
      practised: false,
    });

    expect(corrected?.lastPractisedAt?.toISOString()).toBe(practisedAt);
    expect(corrected?.attempts).toBe(1);
  });

  it('DENIES writing mastery onto another student', async () => {
    const other = await onboardAccount(harness, 'mastery2@example.test', 'student');
    await expect(
      harness.learner.service.updateMastery(actorOf(other), {
        studentUserId: student.userId,
        chapterId,
        masteryScore: 1,
        expectedPreviousScore: null,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('getMastery', () => {
  it('returns an empty list for a student who has not practised', async () => {
    const student = await onboardAccount(harness, 'empty@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);
    await expect(harness.learner.service.getMastery(actorOf(student), student.userId)).resolves.toEqual(
      [],
    );
  });

  it('returns one row per chapter', async () => {
    const student = await onboardAccount(harness, 'multi@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    for (const number of [1, 2]) {
      const chapterId = await insertChapter(
        harness.postgres.client,
        makeChapter(`m${String(number)}`, { chapterNumber: number }),
      );
      await harness.learner.service.updateMastery(actorOf(student), {
        studentUserId: student.userId,
        chapterId,
        masteryScore: number / 10,
        expectedPreviousScore: null,
      });
    }

    const mastery = await harness.learner.service.getMastery(actorOf(student), student.userId);
    expect(mastery).toHaveLength(2);
    // Numbers, not the strings node-postgres returns for `numeric`.
    expect(mastery.every((row) => typeof row.masteryScore === 'number')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TENANCY — D-073
// ---------------------------------------------------------------------------

describe('cross-tenant access is refused, end to end', () => {
  /**
   * THE TESTS D-073 WAS RAISED FOR, DRIVEN THROUGH THE REAL SERVICE AND A REAL
   * DATABASE.
   *
   * `platform/authz` has its own exhaustive unit tests for the rule. These are
   * different and both are needed: the unit tests prove the GUARD refuses a
   * mismatch, and these prove the SERVICE actually resolves the resource's
   * tenant from the data and hands it over — which is the half that was missing
   * and the half no unit test can see.
   *
   * The specific way this feature dies is quiet: a service that satisfies the
   * required `tenantId` field by passing `actor.tenantId` compiles, passes every
   * authz unit test, and compares a value with itself forever.
   */
  async function moveStudentToOtherTenant(userId: string): Promise<void> {
    await createSecondTenant(harness);
    // Both the account and the profile: the account is what the tenant is read
    // from, the profile is where it is denormalised, and a test that moved only
    // one would be measuring which of the two the service consults rather than
    // whether the boundary holds.
    await harness.postgres.client.query('update users set tenant_id = $1 where id = $2', [
      OTHER_TENANT_ID,
      userId,
    ]);
    await harness.postgres.client.query('update students set tenant_id = $1 where user_id = $2', [
      OTHER_TENANT_ID,
      userId,
    ]);
  }

  it('DENIES a parent reading an APPROVED child in another tenant', async () => {
    /**
     * The case worth stating out loud: every ownership and consent rule in the
     * product says yes here. The link exists, the STUDENT approved it, the
     * action is a read, the role is right. The answer is still no, because the
     * tenant check runs before all of them.
     */
    const student = await onboardAccount(harness, 'x-kid@example.test', 'student');
    const parent = await onboardAccount(harness, 'x-mum@example.test', 'parent');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    const issued = await harness.identity.service.generateLinkCode(actorOf(student));
    const link = await harness.identity.service.submitLinkCode(
      actorOf(parent, 'parent'),
      issued.code,
    );
    await harness.identity.service.approveLink(actorOf(student), link.id);

    // The control FIRST: the read works while both are in one tenant. Without
    // it, the assertion below would pass against a service that denied
    // everything.
    await expect(
      harness.learner.service.getProfile(actorOf(parent, 'parent'), student.userId),
    ).resolves.toMatchObject({ userId: student.userId });

    await moveStudentToOtherTenant(student.userId);

    await expect(
      harness.learner.service.getProfile(actorOf(parent, 'parent'), student.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('DOCUMENTS the own-data short-circuit, which is the one place the tenants are not compared', async () => {
    /**
     * ============================================================
     * READ THIS BEFORE CHANGING `authorise` IN `learner.service.ts`.
     *
     * When the target IS the actor, the service uses `actor.tenantId` as the
     * resource tenant instead of querying for it, and the guard then compares
     * that value with itself. That is a check which cannot fail, which is
     * exactly the shape D-073 exists to reject — so it needs a stated reason and
     * a stated limit, and this test is where both live.
     *
     * THE REASON: this is the hottest path in the product. Every profile read,
     * every mastery read, every dashboard load is a student reaching their own
     * data, and the alternative is a `users` lookup on all of them to learn a
     * value the session already carries.
     *
     * WHY IT IS SAFE: the only thing the comparison could catch here is a
     * student whose ACCOUNT has moved tenant while their session was live. In
     * that case the data moved with them — a student reading their own profile
     * is not a cross-tenant read whichever tenant they are in — so there is no
     * boundary to breach. This test asserts exactly that, so the behaviour is
     * pinned rather than accidental.
     *
     * THE LIMIT, AND IT IS A REAL ONE: the session's tenant is TRUSTED for
     * own-data reads. Moving an account between tenants must therefore revoke
     * its sessions, the same way a password reset does. Nothing moves accounts
     * between tenants today; recorded as an open item so that whoever writes
     * that code finds this requirement rather than discovering it.
     *
     * A PARENT gets no such short-circuit. Their target is somebody else, so the
     * tenant is always read from the data — see the tests above and below.
     * ============================================================
     */
    const student = await onboardAccount(harness, 'x-self@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);
    await moveStudentToOtherTenant(student.userId);

    // The session still carries the OLD tenant and the read still succeeds.
    await expect(
      harness.learner.service.getProfile(actorOf(student), student.userId),
    ).resolves.toMatchObject({ userId: student.userId });

    // And so does a session carrying the NEW one — because what is being checked
    // is "is this your own data", and it is, either way.
    await expect(
      harness.learner.service.getProfile(
        { ...actorOf(student), tenantId: OTHER_TENANT_ID },
        student.userId,
      ),
    ).resolves.toMatchObject({ userId: student.userId });
  });

  it('DENIES a student reaching ANOTHER student in a different tenant', async () => {
    // No short-circuit here: the target is somebody else, so the tenant is read
    // from the data. This is the case the short-circuit above must never widen
    // to cover.
    const student = await onboardAccount(harness, 'x-nosy@example.test', 'student');
    const other = await onboardAccount(harness, 'x-victim@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(other), ONBOARDING);
    await moveStudentToOtherTenant(other.userId);

    await expect(
      harness.learner.service.getProfile(actorOf(student), other.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('DENIES mastery reads across tenants too, not only profiles', async () => {
    // Every scope, not the one that happened to be tested. A rule enforced on
    // `profile` and forgotten on `mastery` is the shape of a real leak.
    const student = await onboardAccount(harness, 'x-mastery@example.test', 'student');
    const parent = await onboardAccount(harness, 'x-mastery-mum@example.test', 'parent');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    const issued = await harness.identity.service.generateLinkCode(actorOf(student));
    const link = await harness.identity.service.submitLinkCode(
      actorOf(parent, 'parent'),
      issued.code,
    );
    await harness.identity.service.approveLink(actorOf(student), link.id);
    await moveStudentToOtherTenant(student.userId);

    await expect(
      harness.learner.service.getMastery(actorOf(parent, 'parent'), student.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('leaks NOTHING on the deny — no profile, no name, no tenant', async () => {
    const student = await onboardAccount(harness, 'x-leak@example.test', 'student');
    const parent = await onboardAccount(harness, 'x-leak-mum@example.test', 'parent');
    await harness.learner.service.createProfile(actorOf(student), {
      ...ONBOARDING,
      displayName: 'Ananya Sharma',
    });

    const issued = await harness.identity.service.generateLinkCode(actorOf(student));
    const link = await harness.identity.service.submitLinkCode(
      actorOf(parent, 'parent'),
      issued.code,
    );
    await harness.identity.service.approveLink(actorOf(student), link.id);
    await moveStudentToOtherTenant(student.userId);

    try {
      await harness.learner.service.getProfile(actorOf(parent, 'parent'), student.userId);
      expect.unreachable('expected a ForbiddenError');
    } catch (error) {
      const forbidden = error as ForbiddenError;
      expect(forbidden.toClientPayload()).toEqual({
        error: { code: 'FORBIDDEN', message: 'Forbidden.' },
      });
      // The log side too. A 403 that carries the student's name in its details
      // has moved the leak rather than closed it.
      const serialised = JSON.stringify({ payload: forbidden.toClientPayload(), details: forbidden.details });
      for (const secret of ['Ananya', student.userId, OTHER_TENANT_ID, TEST_TENANT_ID]) {
        expect(serialised).not.toContain(secret);
      }
    }
  });

  it('DENIES when the target student does not exist at all', async () => {
    /**
     * "No such account" resolves to no tenant, which is a deny — and it must be
     * INDISTINGUISHABLE from the cross-tenant deny, or the pair becomes an
     * enumeration oracle: probe an id, and a different error tells you it exists
     * somewhere else on the platform.
     */
    const parent = await onboardAccount(harness, 'x-ghost-mum@example.test', 'parent');
    const missing = '00000000-0000-4000-8000-000000000000';

    await expect(
      harness.learner.service.getProfile(actorOf(parent, 'parent'), missing),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('DENIES an actor whose session carries no tenant at all', async () => {
    // A malformed actor is a wiring defect, not a half-authenticated caller, and
    // it must reach nothing. `tenantId` is a required string, so producing this
    // state needs a cast — which is the point: the value arrives from a session
    // row, where the compiler's belief and reality can differ.
    const student = await onboardAccount(harness, 'x-notenant@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    const tenantless = { userId: student.userId, role: 'student' as const } as unknown as ReturnType<
      typeof actorOf
    >;

    await expect(
      harness.learner.service.getProfile(tenantless, student.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('every write carries the actor tenant, not the column default', () => {
  /**
   * THE COLUMN DEFAULT IS NOT THE ENFORCEMENT, AND THIS IS HOW THAT IS PROVEN.
   *
   * `tenant_id` is NOT NULL with a DEFAULT of the seeded tenant, so an insert
   * that simply omitted the column would still succeed and would still look
   * right in a single-tenant deployment — for exactly as long as there is one
   * tenant. On the day there are two, every row silently lands in the first,
   * with no error and no way to tell which rows were wrong.
   *
   * So these tests do not assert "the tenant is the default". They move the
   * actor to a SECOND tenant and assert the row follows, which is a claim the
   * default cannot satisfy.
   */
  async function tenantOfRow(table: string, column: string, userId: string): Promise<string | null> {
    const result = await harness.postgres.client.query<{ tenant_id: string | null }>(
      `select tenant_id from ${table} where ${column} = $1 limit 1`,
      [userId],
    );
    return result.rows[0]?.tenant_id ?? null;
  }

  it('stamps the profile and its subjects with the ACTOR tenant', async () => {
    const student = await onboardAccount(harness, 'w-profile@example.test', 'student');
    await createSecondTenant(harness);
    await harness.postgres.client.query('update users set tenant_id = $1 where id = $2', [
      OTHER_TENANT_ID,
      student.userId,
    ]);

    // The actor carries the new tenant, as a freshly-issued session would.
    const actor = { ...actorOf(student), tenantId: OTHER_TENANT_ID };
    await harness.learner.service.createProfile(actor, ONBOARDING);

    expect(await tenantOfRow('students', 'user_id', student.userId)).toBe(OTHER_TENANT_ID);
    expect(await tenantOfRow('student_subjects', 'student_user_id', student.userId)).toBe(
      OTHER_TENANT_ID,
    );
  });

  it('stamps chapter mastery with the ACTOR tenant', async () => {
    const student = await onboardAccount(harness, 'w-mastery@example.test', 'student');
    await createSecondTenant(harness);
    await harness.postgres.client.query('update users set tenant_id = $1 where id = $2', [
      OTHER_TENANT_ID,
      student.userId,
    ]);

    const actor = { ...actorOf(student), tenantId: OTHER_TENANT_ID };
    await harness.learner.service.createProfile(actor, ONBOARDING);
    const chapterId = await insertChapter(harness.postgres.client, makeChapter('tenant-ch'));
    await harness.learner.service.updateMastery(actor, {
      studentUserId: student.userId,
      chapterId,
      masteryScore: 0.5,
      expectedPreviousScore: null,
    });

    expect(await tenantOfRow('chapter_mastery', 'student_user_id', student.userId)).toBe(
      OTHER_TENANT_ID,
    );
  });

  it('files an ordinary single-tenant student under the seeded tenant', async () => {
    // The control, and the regression guard for every existing deployment.
    const student = await onboardAccount(harness, 'w-default@example.test', 'student');
    await harness.learner.service.createProfile(actorOf(student), ONBOARDING);

    expect(await tenantOfRow('students', 'user_id', student.userId)).toBe(TEST_TENANT_ID);
  });
});
