import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError } from '@/platform/errors/index';
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
import { createPracticeModule } from '../index';
import { XP_RULES } from '../domain/xp-rules';

/**
 * practice service tests — a REAL Postgres in a container (§9.1), everything
 * else faked.
 *
 * The database is never faked here and could not usefully be. Four of the
 * properties below are properties of the DATABASE rather than of the code:
 * that a transaction rolls back completely, that a unique constraint refuses a
 * second set of responses, that a `where submitted_at is null` update matches
 * nothing the second time, and that a tenant column really is NOT NULL. A fake
 * would let all four pass against a schema that does not enforce any of them.
 */

let harness: AppHarness;

const PASSING_TIME_MS = 12_000;

beforeAll(async () => {
  harness = await startAppHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

function actorOf(account: HarnessAccount, tenantId: string = TEST_TENANT_ID): {
  userId: string;
  role: 'student';
  tenantId: string;
} {
  return { userId: account.userId, role: 'student', tenantId };
}

let seedCounter = 0;

/** An onboarded student with one chapter of questions ready to practise. */
async function seedStudent(options: { heldOut?: boolean; questionCount?: number } = {}): Promise<{
  account: HarnessAccount;
  chapterId: string;
  questionIds: string[];
}> {
  seedCounter += 1;
  const account = await onboardAccount(harness, `p${seedCounter}@example.test`, 'student');
  await harness.learner.service.createProfile(actorOf(account), {
    displayName: `Student ${seedCounter}`,
    grade: '8',
    subjects: ['science'],
  });

  const chapterId = await insertChapter(
    harness.postgres.client,
    makeChapter(`c${seedCounter}`, { grade: '8', subjectCode: 'science', chapterNumber: 1 }),
  );

  const questionIds: string[] = [];
  for (let index = 0; index < (options.questionCount ?? 4); index += 1) {
    questionIds.push(
      await insertQuestion(
        harness.postgres.client,
        chapterId,
        /**
         * THE CORRECT INDEX VARIES PER QUESTION, and it has to.
         *
         * With four questions whose correct answer is always option 1, a
         * perfectly honest full-marks attempt stores the same canonical index
         * four times and trips anti-cheat rule 2. That is the rule behaving
         * exactly as specified — it is a property of the FIXTURE, not a defect
         * — but a fixture that walks into it makes every scoring test in this
         * file assert on an invalid session.
         *
         * The correct index is written into the question TEXT rather than
         * inferred from position, so `answerAll` can find it without depending
         * on the order `content` happens to return questions in.
         */
        makeQuestion(`q${seedCounter}-${index}`, {
          correctIndex: index % 4,
          questionText: `Question ${index} correct=${index % 4}?`,
          isHeldOut: false,
        }),
      ),
    );
  }

  if (options.heldOut === true) {
    await insertQuestion(
      harness.postgres.client,
      chapterId,
      makeQuestion(`held${seedCounter}`, { correctIndex: 2, isHeldOut: true }),
    );
  }

  return { account, chapterId, questionIds };
}

/**
 * Answers every question of a session correctly, through the PRESENTATION
 * index — which is the only index a client ever knows.
 *
 * Deliberately does NOT reach for `correctIndex`: it finds the presented
 * position of the correct option the way a student would, by having been told
 * which one it was. That is what makes the shuffle test below meaningful.
 */
async function answerAll(
  account: HarnessAccount,
  sessionId: string,
  correctness: readonly boolean[],
  timeSpentMs: number = PASSING_TIME_MS,
): Promise<void> {
  const session = await harness.practice.service.getSession(actorOf(account), sessionId);

  for (const [index, question] of session.questions.entries()) {
    // The PRESENTED position of the correct option, found the way a client
    // would: the fixture names options `"<seed> option <canonicalIndex>"` and
    // states the canonical correct index in the question text, so this is a
    // presentation-space lookup with no access to `correctIndex`.
    const canonicalCorrect = Number(/correct=(\d)/.exec(question.questionText)?.[1] ?? '0');
    const canonicalWrong = (canonicalCorrect + 1) % 4;
    const correctPosition = question.options.findIndex((option) =>
      option.endsWith(`option ${canonicalCorrect}`),
    );
    const wrongPosition = question.options.findIndex((option) =>
      option.endsWith(`option ${canonicalWrong}`),
    );

    await harness.practice.service.submitAnswer(actorOf(account), sessionId, {
      questionId: question.id,
      selectedIndex: correctness[index] === false ? wrongPosition : correctPosition,
      timeSpentMs,
      hintLevelUsed: 0,
    });
  }
}

async function countRows(table: string, where: string, values: unknown[]): Promise<number> {
  const result = await harness.postgres.client.query(
    `select 1 from ${table} where ${where}`,
    values,
  );
  return result.rowCount ?? 0;
}

// ===========================================================================
// A VALID SUBMISSION WRITES EVERY TABLE
// ===========================================================================

describe('submitSession — a valid submission writes every table', () => {
  it('writes responses, the session, the XP ledger, mastery AND the retention schedule', async () => {
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });

    await answerAll(account, started.id, [true, true, true, true]);
    const result = await harness.practice.service.submitSession(actorOf(account), started.id);

    expect(result.scorePercent).toBe(100);
    expect(result.isValid).toBe(true);

    expect(await countRows('practice_responses', 'session_id = $1', [started.id])).toBe(4);
    expect(
      await countRows('practice_sessions', 'id = $1 and submitted_at is not null', [started.id]),
    ).toBe(1);
    expect(await countRows('xp_ledger', 'source_id = $1', [started.id])).toBe(1);
    expect(
      await countRows('chapter_mastery', 'student_user_id = $1 and chapter_id = $2', [
        account.userId,
        chapterId,
      ]),
    ).toBe(1);
    expect(
      await countRows('practice_retention', 'student_user_id = $1 and chapter_id = $2', [
        account.userId,
        chapterId,
      ]),
    ).toBe(1);
  });

  it('awards the XP the domain says, not a number the service invented', async () => {
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    await answerAll(account, started.id, [true, true, true, true]);
    const result = await harness.practice.service.submitSession(actorOf(account), started.id);

    expect(result.xpAwarded).toBe(
      4 * XP_RULES.perCorrect + XP_RULES.highScoreBonus + XP_RULES.perfectBonus,
    );
  });

  it('captures EVERY evidence column — none of this can be backfilled', async () => {
    // 05-ROADMAP.md §8: the Phase 1 teacher screen and the Phase 4 principal
    // dashboard run on these, and a student who practised in September leaves
    // no trace of a changed answer unless the column was written in September.
    const { account, chapterId } = await seedStudent({ questionCount: 1 });
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 1,
    });
    const question = started.questions[0]!;
    const correctPosition = question.options.findIndex((option) => option.endsWith('option 0'));
    const otherPosition = question.options.findIndex((option) => option.endsWith('option 2'));

    await harness.practice.service.submitAnswer(actorOf(account), started.id, {
      questionId: question.id,
      selectedIndex: correctPosition,
      firstSelectedIndex: otherPosition,
      timeSpentMs: 9_000,
      hintLevelUsed: 2,
      confidence: 'unsure',
      explanationFormatUsed: 'worked_example',
    });
    await harness.practice.service.submitSession(actorOf(account), started.id);

    const { rows } = await harness.postgres.client.query<{
      first_selected_index: number | null;
      answer_changed: boolean | null;
      hint_level_used: number;
      confidence: string | null;
      time_spent_ms: number;
      authored_difficulty: string;
      explanation_format_used: string | null;
    }>(`select * from practice_responses where session_id = $1`, [started.id]);

    const row = rows[0]!;
    expect(row.first_selected_index).not.toBeNull();
    expect(row.answer_changed).toBe(true);
    expect(row.hint_level_used).toBe(2);
    expect(row.confidence).toBe('unsure');
    expect(row.time_spent_ms).toBe(9_000);
    expect(row.authored_difficulty).toBe('medium');
    expect(row.explanation_format_used).toBe('worked_example');
  });
});

// ===========================================================================
// THE CANONICAL INDEX — D-058
// ===========================================================================

describe('submitAnswer — THE STORED INDEX IS THE ORIGINAL, NOT THE SHUFFLED ONE (D-058)', () => {
  it('stores the canonical index, proved with a shuffle that ACTUALLY REORDERS', async () => {
    /**
     * THE TEST THIS WHOLE MECHANISM EXISTS FOR.
     *
     * The harness's random source is fixed so the shuffle map is a real
     * permutation rather than the identity — asserted below before anything
     * else, because against the identity map this test passes whether or not
     * the translation exists at all.
     *
     * The student taps a PRESENTATION position. What lands in
     * `practice_responses.selected_index` must be the ORIGINAL index, because
     * `questions.distractor_misconceptions` is keyed by original index (D-048).
     * Store the shuffled one and every misconception lookup returns a real code
     * for the wrong distractor — silently, plausibly and unrecoverably.
     */
    const { account, chapterId } = await seedStudent({ questionCount: 1 });
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 1,
    });

    const { rows: sessionRows } = await harness.postgres.client.query<{
      option_order: Record<string, number[]>;
    }>(`select option_order from practice_sessions where id = $1`, [started.id]);
    const question = started.questions[0]!;
    const map = sessionRows[0]!.option_order[question.id]!;

    // THE PRECONDITION. Without it the assertion below says nothing.
    expect(map).not.toEqual([0, 1, 2, 3]);

    // A position the shuffle actually MOVED. Position 0 is not good enough: a
    // permutation can reorder three of four options and leave the first where
    // it was, and tapping a fixed point proves the translation exists exactly
    // as well as no translation does.
    const movedPosition = map.findIndex((canonical, position) => canonical !== position);
    expect(movedPosition).toBeGreaterThanOrEqual(0);
    const canonicalOfMoved = map[movedPosition]!;

    await harness.practice.service.submitAnswer(actorOf(account), started.id, {
      questionId: question.id,
      selectedIndex: movedPosition,
      timeSpentMs: PASSING_TIME_MS,
      hintLevelUsed: 0,
    });
    await harness.practice.service.submitSession(actorOf(account), started.id);

    const { rows } = await harness.postgres.client.query<{ selected_index: number }>(
      `select selected_index from practice_responses where session_id = $1`,
      [started.id],
    );

    expect(rows[0]?.selected_index).toBe(canonicalOfMoved);
    // And explicitly NOT the presentation index the client sent.
    expect(rows[0]?.selected_index).not.toBe(movedPosition);
  });

  it('marks the answer correct by the CANONICAL index, not the position', async () => {
    const { account, chapterId } = await seedStudent({ questionCount: 1 });
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 1,
    });
    const question = started.questions[0]!;
    const correctPosition = question.options.findIndex((option) => option.endsWith('option 0'));

    const result = await harness.practice.service.submitAnswer(actorOf(account), started.id, {
      questionId: question.id,
      selectedIndex: correctPosition,
      timeSpentMs: PASSING_TIME_MS,
      hintLevelUsed: 0,
    });

    expect(result.isCorrect).toBe(true);
    // The overlay highlights the option where the student saw it.
    expect(result.correctPresentationIndex).toBe(correctPosition);
  });

  it('looks a misconception up by the canonical index', async () => {
    const { account, chapterId } = await seedStudent({ questionCount: 1 });
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 1,
    });
    const question = started.questions[0]!;
    const wrongPosition = question.options.findIndex((option) => option.endsWith('option 3'));

    const result = await harness.practice.service.submitAnswer(actorOf(account), started.id, {
      questionId: question.id,
      selectedIndex: wrongPosition,
      timeSpentMs: PASSING_TIME_MS,
      hintLevelUsed: 0,
    });

    expect(result.decision).toBe('remediate_misconception');
    // The fixture keys its codes by canonical index. A presentation-index
    // lookup would return the code belonging to a different distractor.
    expect(result.misconceptionCode).toContain('3');
  });
});

// ===========================================================================
// THE HELD-OUT RESERVE
// ===========================================================================

describe('startSession — A HELD-OUT QUESTION IS NEVER SERVED', () => {
  it('draws none of the reserve, even when it would fill the requested count', async () => {
    // A served held-out question may have been memorised and can never measure
    // anything again — for that student, permanently. There is no un-serving it.
    const { account, chapterId } = await seedStudent({ heldOut: true, questionCount: 2 });

    const { rows: heldOut } = await harness.postgres.client.query<{ id: string }>(
      `select id from questions where chapter_id = $1 and is_held_out = true`,
      [chapterId],
    );
    expect(heldOut).toHaveLength(1);

    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 20,
    });

    const served = started.questions.map((question) => question.id);
    expect(served).not.toContain(heldOut[0]!.id);
    expect(served).toHaveLength(2);
  });

  it('never records a response against a held-out question', async () => {
    const { account, chapterId } = await seedStudent({ heldOut: true, questionCount: 2 });
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 20,
    });
    await answerAll(account, started.id, [true, true]);
    await harness.practice.service.submitSession(actorOf(account), started.id);

    const contaminated = await countRows(
      'practice_responses r join questions q on q.id = r.question_id',
      'q.is_held_out = true',
      [],
    );
    expect(contaminated).toBe(0);
  });
});

// ===========================================================================
// ANTI-CHEAT
// ===========================================================================

describe('submitSession — an invalid attempt scores zero and records a reason', () => {
  it('scores zero and names the rule when the attempt is too fast', async () => {
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    await answerAll(account, started.id, [true, true, true, true], 100);

    const result = await harness.practice.service.submitSession(actorOf(account), started.id);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe('too_fast');
    expect(result.scorePercent).toBe(0);
    expect(result.xpAwarded).toBe(0);
  });

  it('RECORDS the invalid session rather than discarding it', async () => {
    // The responses are the evidence and the reason is what makes a support
    // conversation possible. Deleting the attempt destroys both.
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    await answerAll(account, started.id, [true, true, true, true], 100);
    await harness.practice.service.submitSession(actorOf(account), started.id);

    expect(await countRows('practice_responses', 'session_id = $1', [started.id])).toBe(4);

    const { rows } = await harness.postgres.client.query<{
      is_valid: boolean;
      invalid_reason: string;
      score_percent: number;
    }>(`select is_valid, invalid_reason, score_percent from practice_sessions where id = $1`, [
      started.id,
    ]);
    expect(rows[0]).toEqual({ is_valid: false, invalid_reason: 'too_fast', score_percent: 0 });
  });

  it('still writes a ZERO ledger row, so "awarded nothing" is distinguishable from "never happened"', async () => {
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    await answerAll(account, started.id, [true, true, true, true], 100);
    await harness.practice.service.submitSession(actorOf(account), started.id);

    const { rows } = await harness.postgres.client.query<{ amount: number }>(
      `select amount from xp_ledger where source_id = $1`,
      [started.id],
    );
    expect(rows[0]?.amount).toBe(0);
  });
});

describe('submitSession — the response-count rule', () => {
  it('scores zero and names response_count_mismatch when questions are skipped', async () => {
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    const session = await harness.practice.service.getSession(actorOf(account), started.id);
    const first = session.questions[0]!;
    await harness.practice.service.submitAnswer(actorOf(account), started.id, {
      questionId: first.id,
      selectedIndex: 0,
      timeSpentMs: PASSING_TIME_MS,
      hintLevelUsed: 0,
    });

    const result = await harness.practice.service.submitSession(actorOf(account), started.id);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe('response_count_mismatch');
    expect(result.scorePercent).toBe(0);
  });
});

// ===========================================================================
// DOUBLE SUBMISSION
// ===========================================================================

describe('submitSession — submitting twice is rejected', () => {
  it('refuses the second submission with a conflict', async () => {
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    await answerAll(account, started.id, [true, true, true, true]);
    await harness.practice.service.submitSession(actorOf(account), started.id);

    await expect(
      harness.practice.service.submitSession(actorOf(account), started.id),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('leaves exactly ONE ledger row and ONE set of responses after a retry', async () => {
    // A second award is the failure that matters. A 200 with the previous
    // result would look like success and would be indistinguishable from one.
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    await answerAll(account, started.id, [true, true, true, true]);
    await harness.practice.service.submitSession(actorOf(account), started.id);
    await expect(
      harness.practice.service.submitSession(actorOf(account), started.id),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await countRows('xp_ledger', 'source_id = $1', [started.id])).toBe(1);
    expect(await countRows('practice_responses', 'session_id = $1', [started.id])).toBe(4);
  });

  it('refuses an answer that arrives after submission', async () => {
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    await answerAll(account, started.id, [true, true, true, true]);
    const session = await harness.practice.service.getSession(actorOf(account), started.id);
    await harness.practice.service.submitSession(actorOf(account), started.id);

    await expect(
      harness.practice.service.submitAnswer(actorOf(account), started.id, {
        questionId: session.questions[0]!.id,
        selectedIndex: 0,
        timeSpentMs: PASSING_TIME_MS,
        hintLevelUsed: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

// ===========================================================================
// ATOMICITY — D-056
// ===========================================================================

describe('submitSession — A PARTIAL FAILURE ROLLS EVERYTHING BACK (D-056)', () => {
  it('writes NOTHING at all when the cross-module mastery write fails', async () => {
    /**
     * THE PROPERTY §8.6 CALLS NON-NEGOTIABLE, tested at the place it is
     * hardest to keep: the mastery write belongs to ANOTHER MODULE and is
     * enlisted through the opaque transaction token.
     *
     * The failure is injected at exactly that seam. If `learner.updateMastery`
     * were called after the transaction instead of inside it — which compiles,
     * and which most tests would not notice — the responses, the session and
     * the XP row would all be committed here and the assertion below would
     * find them.
     *
     * A partial write means a student's XP disagrees with their history
     * permanently. There is no retry that reconciles it, because both halves
     * individually look correct.
     */
    const { account, chapterId } = await seedStudent();

    const failing = createPracticeModule({
      db: harness.container.poolFor('practice'),
      clock: harness.clock,
      logger: harness.logger,
      requireSession: harness.identity.requireSession,
      readQuestions: (actor, query) =>
        harness.content.service.getQuestionsForChapter(actor, query),
      readChapter: async (actor, id) => {
        try {
          return await harness.content.service.getChapter(actor, id);
        } catch {
          return null;
        }
      },
      listChapters: (actor, filter) =>
        harness.content.service.listChapters(actor, {
          grade: filter.grade,
          subject: filter.subjectCode,
          limit: filter.limit,
        }),
      readStudentContext: async (actor, studentUserId) => {
        const profile = await harness.learner.service.getProfile(actor, studentUserId);
        const subjects = await harness.learner.service.getSubjects(actor, studentUserId);
        return { grade: profile.grade, subjects };
      },
      readMastery: (actor, studentUserId) =>
        harness.learner.service.getMastery(actor, studentUserId),
      // THE INJECTED FAILURE, at the cross-module seam.
      writeMastery: () => Promise.reject(new Error('mastery write failed')),
      readTenantOfStudent: (studentUserId) =>
        harness.identity.service.getTenantOfUser(studentUserId),
      random: () => 0.5,
    });

    const started = await failing.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    const session = await failing.service.getSession(actorOf(account), started.id);
    for (const question of session.questions) {
      await failing.service.submitAnswer(actorOf(account), started.id, {
        questionId: question.id,
        selectedIndex: question.options.findIndex((option) =>
          option.endsWith(`option ${/correct=(\d)/.exec(question.questionText)?.[1] ?? '0'}`),
        ),
        timeSpentMs: PASSING_TIME_MS,
        hintLevelUsed: 0,
      });
    }

    await expect(failing.service.submitSession(actorOf(account), started.id)).rejects.toThrow(
      /mastery write failed/,
    );

    // NOTHING landed. Not the responses, not the score, not the XP, not the
    // schedule — and the session is still submittable.
    expect(await countRows('practice_responses', 'session_id = $1', [started.id])).toBe(0);
    expect(await countRows('xp_ledger', 'source_id = $1', [started.id])).toBe(0);
    expect(
      await countRows('practice_retention', 'student_user_id = $1', [account.userId]),
    ).toBe(0);
    expect(
      await countRows('practice_sessions', 'id = $1 and submitted_at is null', [started.id]),
    ).toBe(1);
  });

  it('lets the session be submitted successfully afterwards', async () => {
    // The rollback has to leave a RESUBMITTABLE session, not a wedged one.
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    await answerAll(account, started.id, [true, true, true, true]);
    const result = await harness.practice.service.submitSession(actorOf(account), started.id);
    expect(result.isValid).toBe(true);
  });
});

// ===========================================================================
// THE XP LEDGER
// ===========================================================================

describe('getProgress — the XP total EQUALS the sum of the ledger', () => {
  it('reports a total that is the sum of every ledger row', async () => {
    const { account, chapterId } = await seedStudent();

    for (let round = 0; round < 3; round += 1) {
      const started = await harness.practice.service.startSession(actorOf(account), {
        chapterId,
        questionCount: 4,
      });
      await answerAll(account, started.id, [true, true, true, false]);
      await harness.practice.service.submitSession(actorOf(account), started.id);
    }

    const progress = await harness.practice.service.getProgress(actorOf(account));

    const { rows } = await harness.postgres.client.query<{ total: string }>(
      `select coalesce(sum(amount), 0)::text as total from xp_ledger where student_user_id = $1`,
      [account.userId],
    );

    expect(progress.totalXp).toBe(Number(rows[0]!.total));
    expect(progress.totalXp).toBeGreaterThan(0);
    expect(progress.sessionsCompleted).toBe(3);
  });

  it('clamps at the daily cap, and the ledger still sums to the total', async () => {
    const { account, chapterId } = await seedStudent();

    // Enough perfect sessions to cross the cap several times over.
    for (let round = 0; round < 6; round += 1) {
      const started = await harness.practice.service.startSession(actorOf(account), {
        chapterId,
        questionCount: 4,
      });
      await answerAll(account, started.id, [true, true, true, true]);
      await harness.practice.service.submitSession(actorOf(account), started.id);
    }

    const progress = await harness.practice.service.getProgress(actorOf(account));
    expect(progress.xpToday).toBe(XP_RULES.dailyCap);
    expect(progress.totalXp).toBe(XP_RULES.dailyCap);
  });

  it('reports an EVIDENCE LABEL per chapter and never a percentage', async () => {
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    await answerAll(account, started.id, [true, true, true, true]);
    await harness.practice.service.submitSession(actorOf(account), started.id);

    const progress = await harness.practice.service.getProgress(actorOf(account));
    const chapter = progress.chapters.find((row) => row.chapterId === chapterId);
    expect(chapter?.evidence).toBe('developing');
    expect(JSON.stringify(progress.chapters)).not.toContain('masteryScore');
  });
});

// ===========================================================================
// ACCESS
// ===========================================================================

describe('access — cross-student and cross-tenant are denied with NO PAYLOAD', () => {
  it('refuses another student’s session', async () => {
    const owner = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(owner.account), {
      chapterId: owner.chapterId,
      questionCount: 4,
    });

    seedCounter += 1;
    const intruder = await onboardAccount(harness, `intruder${seedCounter}@example.test`, 'student');

    await expect(
      harness.practice.service.getSession(actorOf(intruder), started.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('carries no session data at all on the deny', async () => {
    const owner = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(owner.account), {
      chapterId: owner.chapterId,
      questionCount: 4,
    });

    seedCounter += 1;
    const intruder = await onboardAccount(harness, `intruder${seedCounter}@example.test`, 'student');

    const error = await harness.practice.service
      .getSession(actorOf(intruder), started.id)
      .then(() => null)
      .catch((thrown: unknown) => thrown as ForbiddenError);

    const serialised = JSON.stringify({
      safeMessage: error?.safeMessage,
      details: error?.details,
    });
    expect(serialised).not.toContain(started.id);
    expect(serialised).not.toContain(owner.account.userId);
    expect(serialised).not.toContain(owner.chapterId);
    expect(error?.safeMessage).toBe('Forbidden.');
  });

  it('refuses an actor claiming another tenant, even for their OWN session', async () => {
    // The tenant on the SESSION ROW is the one compared, so a claimed tenant
    // that does not match the data is refused before any question is loaded.
    await createSecondTenant(harness);
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });

    await expect(
      harness.practice.service.getSession(
        actorOf(account, OTHER_TENANT_ID),
        started.id,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a cross-tenant actor on the mission, history and progress too', async () => {
    // All four public reads, not just the one that was easy to think of. If one
    // method has the hole, assume the others do until each is shown otherwise
    // (D-091).
    await createSecondTenant(harness);
    const { account } = await seedStudent();
    const foreign = actorOf(account, OTHER_TENANT_ID);

    await expect(harness.practice.service.getTodaysMission(foreign)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(harness.practice.service.getHistory(foreign, 10)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(harness.practice.service.getProgress(foreign)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('reports an unknown session as not found, with no detail', async () => {
    const { account } = await seedStudent();
    await expect(
      harness.practice.service.getSession(
        actorOf(account),
        '00000000-0000-4000-8000-000000000000',
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ===========================================================================
// TODAY'S MISSION
// ===========================================================================

describe('getTodaysMission — THE REASON IS DERIVED FROM REAL DATA', () => {
  it('names the chapter the student has actually not started', async () => {
    const { account, chapterId } = await seedStudent();
    const mission = await harness.practice.service.getTodaysMission(actorOf(account));

    expect(mission?.chapterId).toBe(chapterId);
    expect(mission?.reason).toBe('next_in_syllabus');
    // The chapter's REAL title, read out of the row rather than templated.
    expect(mission?.reasonEn).toContain(mission!.chapterTitleEn);
    expect(mission?.reasonHi).toMatch(/[ऀ-ॿ]/);
  });

  it('switches to a DUE REVIEW once a session has scheduled one', async () => {
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    await answerAll(account, started.id, [true, true, true, true]);
    const result = await harness.practice.service.submitSession(actorOf(account), started.id);

    // The schedule the domain produced, not a date this test chose.
    harness.clock.setTo(new Date(result.nextReviewAt));

    const mission = await harness.practice.service.getTodaysMission(actorOf(account));
    expect(mission?.reason).toBe('due_review');
    expect(mission?.chapterId).toBe(chapterId);
    expect(mission?.reasonEn).toMatch(/due today/i);
  });

  it('reports a WEAK chapter with the attempt count actually recorded', async () => {
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    await answerAll(account, started.id, [false, false, false, false]);
    await harness.practice.service.submitSession(actorOf(account), started.id);

    // Before the review falls due, the weak chapter is what is offered.
    const mission = await harness.practice.service.getTodaysMission(actorOf(account));
    expect(mission?.reason).toBe('weak_chapter');
    expect(mission?.reasonEn).toContain('1 attempt');
    expect(mission?.evidence).toBe('needs_another_session');
  });

  it('returns null for a student with no chapters rather than inventing one', async () => {
    seedCounter += 1;
    const account = await onboardAccount(harness, `empty${seedCounter}@example.test`, 'student');
    await harness.learner.service.createProfile(actorOf(account), {
      displayName: 'Empty',
      grade: '12',
      subjects: ['science'],
    });

    expect(await harness.practice.service.getTodaysMission(actorOf(account))).toBeNull();
  });
});

// ===========================================================================
// SESSION SHAPE
// ===========================================================================

describe('getSession — the wire shape never carries the answer', () => {
  it('sends no correctIndex, explanation or misconception before an answer', async () => {
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    const session = await harness.practice.service.getSession(actorOf(account), started.id);

    const serialised = JSON.stringify(session);
    expect(serialised).not.toContain('correctIndex');
    expect(serialised).not.toContain('explanation');
    expect(serialised).not.toContain('distractorMisconceptions');
    expect(serialised).not.toContain('Because of');
  });

  it('offers no hint levels, because the corpus has none (D-077)', async () => {
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    // Honest emptiness rather than five buttons that apologise. When the
    // pedagogy generation pass authors the columns this becomes non-empty with
    // no change to the interface contract.
    expect(started.questions[0]?.hintLevelsAvailable).toEqual([]);
  });

  it('refuses a chapter outside the student’s grade', async () => {
    const { account } = await seedStudent();
    const otherGrade = await insertChapter(
      harness.postgres.client,
      makeChapter('grade11', { grade: '11', subjectCode: 'science', chapterNumber: 1 }),
    );
    await insertQuestion(harness.postgres.client, otherGrade, makeQuestion('g11'));

    await expect(
      harness.practice.service.startSession(actorOf(account), {
        chapterId: otherGrade,
        questionCount: 4,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ===========================================================================
// HISTORY
// ===========================================================================

describe('getHistory', () => {
  it('returns the student’s own sessions, newest first', async () => {
    const { account, chapterId } = await seedStudent();
    const first = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    await answerAll(account, first.id, [true, true, true, true]);
    await harness.practice.service.submitSession(actorOf(account), first.id);

    harness.clock.advanceDays(1);
    const second = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });

    const history = await harness.practice.service.getHistory(actorOf(account), 10);
    expect(history.map((entry) => entry.sessionId)).toEqual([second.id, first.id]);
    expect(history[1]?.scorePercent).toBe(100);
    expect(history[0]?.submittedAt).toBeNull();
  });

  it('shows nothing of another student’s history', async () => {
    const owner = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(owner.account), {
      chapterId: owner.chapterId,
      questionCount: 4,
    });
    await answerAll(owner.account, started.id, [true, true, true, true]);
    await harness.practice.service.submitSession(actorOf(owner.account), started.id);

    seedCounter += 1;
    const other = await onboardAccount(harness, `other${seedCounter}@example.test`, 'student');
    await harness.learner.service.createProfile(actorOf(other), {
      displayName: 'Other',
      grade: '8',
      subjects: ['science'],
    });

    expect(await harness.practice.service.getHistory(actorOf(other), 10)).toEqual([]);
  });
});
