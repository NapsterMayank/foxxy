import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError } from '@/platform/errors/index';
import type { Difficulty } from '@/shared/constants/curriculum';
import type { AnswerResult, PracticeQuestion } from '@/shared/contracts/practice.contract';
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
import { createPracticeRepository } from '../practice.repository';
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

/**
 * A practice module whose shuffle randomness ACTUALLY VARIES BETWEEN QUESTIONS.
 *
 * ===========================================================================
 * WHY THE HARNESS DEFAULT IS NOT ENOUGH, AND WHAT IT HID.
 *
 * `app-harness.ts` supplies `random: () => 0.5` — a CONSTANT. It produces a map
 * that genuinely reorders, which is why the D-058 test works, but it produces
 * the SAME map for every question in a session. Under that source a bug in
 * which `shuffleFor` returned the FIRST question's map for every question is
 * invisible: an audit made exactly that change and 219 of 219 tests passed.
 *
 * That bug is the D-058 catastrophe in its worst form. It writes a canonical
 * index derived from another question's permutation, so `distractor_misconceptions`
 * — keyed by original index (D-048) — resolves to a real code for the wrong
 * distractor. Nothing errors, the data stays plausible, and the map that would
 * have translated it is the one that was not used.
 *
 * The existing D-058 test uses a ONE-QUESTION session and structurally cannot
 * see it. Everything in `describe('the per-question shuffle map')` below runs
 * against this source instead.
 * ===========================================================================
 */
function createVaryingShufflePractice(): ReturnType<typeof createPracticeModule> {
  let state = 20_260_810 >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };

  return createPracticeModule({
    db: harness.container.poolFor('practice'),
    clock: harness.clock,
    logger: harness.logger,
    requireSession: harness.identity.requireSession,
    readQuestions: (actor, query) => harness.content.service.getQuestionsForChapter(actor, query),
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
    readMastery: (actor, studentUserId) => harness.learner.service.getMastery(actor, studentUserId),
    writeMastery: (actor, input) => harness.learner.service.updateMastery(actor, input),
    readTenantOfStudent: (studentUserId) => harness.identity.service.getTenantOfUser(studentUserId),
    random,
  });
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

/** The PRESENTED position of the canonical-correct option (`"correct=N"` in the text). */
function correctPositionOf(question: Pick<PracticeQuestion, 'questionText' | 'options'>): number {
  const canonicalCorrect = Number(/correct=(\d)/.exec(question.questionText)?.[1] ?? '0');
  return question.options.findIndex((option) => option.endsWith(`option ${canonicalCorrect}`));
}

/** The PRESENTED position of a WRONG option, one canonical index over from correct. */
function wrongPositionOf(question: Pick<PracticeQuestion, 'questionText' | 'options'>): number {
  const canonicalCorrect = Number(/correct=(\d)/.exec(question.questionText)?.[1] ?? '0');
  const canonicalWrong = (canonicalCorrect + 1) % 4;
  return question.options.findIndex((option) => option.endsWith(`option ${canonicalWrong}`));
}

/**
 * Answers every question of a session correctly, through the PRESENTATION
 * index — which is the only index a client ever knows.
 *
 * Deliberately does NOT reach for `correctIndex`: it finds the presented
 * position of the correct option the way a student would, by having been told
 * which one it was. That is what makes the shuffle test below meaningful.
 *
 * THE CLOCK IS ADVANCED BY THE TIME BEING CLAIMED, and that is not decoration.
 * `submitSession` clamps the claimed total to `now - started_at`, so a session
 * that claims 48 seconds of work inside a frozen instant is — correctly —
 * `too_fast`. Every honest test here has to spend the time it says it spent;
 * the one that deliberately does not is `answerAllWithoutSpendingTheTime`.
 *
 * ===========================================================================
 * WALKS `nextQuestion` RATHER THAN A FIXED ARRAY — Task 5.
 *
 * A session now arrives with ONE question; every question after it is
 * whatever `submitAnswer` returns as `nextQuestion`. This helper follows that
 * chain rather than reading `session.questions` a second time, which is the
 * one and only place the served question actually lives after the first.
 * ===========================================================================
 */
async function answerAll(
  account: HarnessAccount,
  sessionId: string,
  correctness: readonly boolean[],
  timeSpentMs: number = PASSING_TIME_MS,
): Promise<void> {
  const session = await harness.practice.service.getSession(actorOf(account), sessionId);
  let question: PracticeQuestion | null = session.questions[0] ?? null;

  for (const isCorrect of correctness) {
    if (question === null) {
      throw new Error('answerAll: the session ended before the correctness list did');
    }
    harness.clock.advanceMs(timeSpentMs);
    const selectedIndex = isCorrect ? correctPositionOf(question) : wrongPositionOf(question);

    const result = await harness.practice.service.submitAnswer(actorOf(account), sessionId, {
      questionId: question.id,
      selectedIndex,
      timeSpentMs,
      hintLevelUsed: 0,
    });
    question = result.nextQuestion;
  }
}

/** Submits a CORRECT answer to `question` and returns the result — Task 5's ladder tests. */
async function answerCorrectly(
  account: HarnessAccount,
  sessionId: string,
  question: PracticeQuestion,
  timeSpentMs: number,
): Promise<AnswerResult> {
  harness.clock.advanceMs(timeSpentMs);
  return harness.practice.service.submitAnswer(actorOf(account), sessionId, {
    questionId: question.id,
    selectedIndex: correctPositionOf(question),
    timeSpentMs,
    hintLevelUsed: 0,
  });
}

/** Submits a WRONG answer to `question` and returns the result — Task 5's ladder tests. */
async function answerWrongly(
  account: HarnessAccount,
  sessionId: string,
  question: PracticeQuestion,
  timeSpentMs: number,
): Promise<AnswerResult> {
  harness.clock.advanceMs(timeSpentMs);
  return harness.practice.service.submitAnswer(actorOf(account), sessionId, {
    questionId: question.id,
    selectedIndex: wrongPositionOf(question),
    timeSpentMs,
    hintLevelUsed: 0,
  });
}

/**
 * An onboarded student with one chapter whose questions carry the given
 * DIFFICULTIES, in order — Task 5's ladder tests, which care which rung a
 * question was drawn from and not just how many there are.
 *
 * `evidence` seeds `chapter_mastery` before the session starts, through the
 * real `learner.updateMastery`, so `startingRung` reads the same evidence
 * label the mission and progress screens would.
 */
async function seedStudentWithDifficulties(
  difficulties: readonly Difficulty[],
  options: { evidence?: 'developing' | 'strong' } = {},
): Promise<{ account: HarnessAccount; chapterId: string }> {
  seedCounter += 1;
  const account = await onboardAccount(harness, `ladder${seedCounter}@example.test`, 'student');
  await harness.learner.service.createProfile(actorOf(account), {
    displayName: `Ladder ${seedCounter}`,
    grade: '8',
    subjects: ['science'],
  });

  const chapterId = await insertChapter(
    harness.postgres.client,
    makeChapter(`ladder${seedCounter}`, { grade: '8', subjectCode: 'science', chapterNumber: 1 }),
  );

  for (const [index, difficulty] of difficulties.entries()) {
    await insertQuestion(
      harness.postgres.client,
      chapterId,
      makeQuestion(`ladderq${seedCounter}-${index}`, {
        correctIndex: index % 4,
        questionText: `Question ${index} correct=${index % 4}?`,
        difficulty,
        isHeldOut: false,
      }),
    );
  }

  if (options.evidence === 'developing') {
    // 0.6 with one attempt: >= DEVELOPING_MASTERY, below STRONG_MASTERY —
    // `evidenceLabel` reads it as 'developing' regardless of attempt count.
    await harness.learner.service.updateMastery(actorOf(account), {
      studentUserId: account.userId,
      chapterId,
      masteryScore: 0.6,
      expectedPreviousScore: null,
      attemptIncrement: 1,
      practised: true,
    });
  } else if (options.evidence === 'strong') {
    // 0.9 with two attempts: >= STRONG_MASTERY and >= ATTEMPTS_FOR_STRONG.
    await harness.learner.service.updateMastery(actorOf(account), {
      studentUserId: account.userId,
      chapterId,
      masteryScore: 0.9,
      expectedPreviousScore: null,
      attemptIncrement: 2,
      practised: true,
    });
  }

  return { account, chapterId };
}

async function countRows(table: string, where: string, values: unknown[]): Promise<number> {
  const result = await harness.postgres.client.query(
    `select 1 from ${table} where ${where}`,
    values,
  );
  return result.rowCount ?? 0;
}

// ===========================================================================
// SERVE ONE QUESTION, THEN CHOOSE THE NEXT — Task 5
// ===========================================================================

describe('adaptive serving', () => {
  it('starts a session with exactly one question', async () => {
    const { account, chapterId } = await seedStudentWithDifficulties(['easy', 'medium', 'hard']);

    const session = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 6,
    });

    expect(session.questions).toHaveLength(1);
  });

  it('serves the next question on the answer, and steps up after two quick correct ones', async () => {
    const { account, chapterId } = await seedStudentWithDifficulties([
      'easy',
      'easy',
      'medium',
      'hard',
    ]);

    const session = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    expect(session.questions[0]?.difficulty).toBe('easy');

    const first = await answerCorrectly(account, session.id, session.questions[0]!, 10_000);
    expect(first.nextQuestion?.difficulty).toBe('easy'); // one qualifying answer is not two

    const second = await answerCorrectly(account, session.id, first.nextQuestion!, 10_000);
    expect(second.nextQuestion?.difficulty).toBe('medium'); // stepped up
  });

  it('steps down on a wrong answer', async () => {
    const { account, chapterId } = await seedStudentWithDifficulties(['medium', 'easy'], {
      evidence: 'developing',
    });

    const session = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 3,
    });
    expect(session.questions[0]?.difficulty).toBe('medium'); // developing starts in the middle

    const result = await answerWrongly(account, session.id, session.questions[0]!, 20_000);
    expect(result.nextQuestion?.difficulty).toBe('easy');
  });

  it('does not step the ladder when the wanted difficulty is simply absent', async () => {
    /**
     * A DISCRIMINATING FIXTURE — review round 1, Finding 2.
     *
     * The first version of this test used a MEDIUM-ONLY pool with
     * `evidence: 'strong'` (wants `hard`). That fixture is vacuous:
     * `STEP_UP['hard'] = 'hard'`, so a BROKEN implementation that lets the
     * fallback write back to the ladder converges on the exact same observed
     * sequence (`medium, medium, medium`, three question ids) as the correct
     * one — the ladder "moving" to `medium` and immediately re-stepping to
     * `hard` is invisible from outside, because `hard` was already the
     * ceiling. The test could not fail no matter which implementation ran.
     *
     * This fixture has EASY and HARD, no MEDIUM, with `evidence: 'developing'`
     * (wants `medium`, absent every time it is asked). Two quick correct
     * answers:
     *
     *   CORRECT (fallback never touches the ladder): the ladder replays as
     *   medium -> medium -> hard (it only steps on the SECOND qualifying
     *   answer). `medium` is never available, so draws 1 and 2 both fall back
     *   to `easy` (the tie-break between equidistant `easy`/`hard`, pinned by
     *   Task 2). Draw 3 wants `hard` — no fallback needed, since `hard` IS in
     *   the pool. Observed: easy, easy, HARD.
     *
     *   BROKEN (a fallback draw is mistaken for where the ladder now stands):
     *   after drawing `easy` for the content gap, the ladder is dragged down
     *   to `easy` instead of staying at `medium`. One qualifying answer from
     *   `easy` is not two, so it stays at `easy` and draws `easy` again — same
     *   as correct, so this alone doesn't discriminate. The SECOND qualifying
     *   answer is what does: from a ladder wrongly sitting at `easy`, two
     *   qualifying answers step it to `medium` — available nowhere in this
     *   pool — so the fallback draws `easy` a THIRD time. Observed: easy,
     *   easy, EASY.
     *
     * The two sequences diverge at the third draw and only there — exactly
     * the "moved or didn't" question this test exists to answer.
     */
    const { account, chapterId } = await seedStudentWithDifficulties(
      ['easy', 'easy', 'hard', 'hard'],
      { evidence: 'developing' },
    );

    const session = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 3,
    });
    // `developing` wants `medium`; the chapter has none, so the fallback
    // (tied between `easy` and `hard`) serves `easy`.
    expect(session.questions[0]?.difficulty).toBe('easy');

    const first = await answerCorrectly(account, session.id, session.questions[0]!, 5_000);
    // One qualifying answer is not two — the ladder is still at `medium`,
    // still absent, so the fallback serves `easy` again.
    expect(first.nextQuestion?.difficulty).toBe('easy');

    const second = await answerCorrectly(account, session.id, first.nextQuestion!, 5_000);
    // THE DISCRIMINATING ASSERTION. `hard` here is only reachable if the
    // ladder stepped medium -> hard, which is only possible if it was still
    // AT medium going into this answer — i.e. the two `easy` draws above
    // never moved it.
    expect(second.nextQuestion?.difficulty).toBe('hard');

    const { rows } = await harness.postgres.client.query<{ question_ids: string[] }>(
      `select question_ids from practice_sessions where id = $1`,
      [session.id],
    );
    expect(rows[0]?.question_ids).toHaveLength(3);
  });

  it('returns no next question once the target length is reached', async () => {
    const { account, chapterId } = await seedStudentWithDifficulties(['easy', 'easy']);

    const session = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 1,
    });
    const result = await answerCorrectly(account, session.id, session.questions[0]!, 10_000);

    expect(result.nextQuestion).toBeNull();
    expect(result.questionCount).toBe(1);
  });

  it('ends early rather than repeating a question when the chapter runs dry', async () => {
    const { account, chapterId } = await seedStudentWithDifficulties(['easy']);

    const session = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 5,
    });
    const result = await answerCorrectly(account, session.id, session.questions[0]!, 10_000);

    // One question exists; it has been served and answered. Nothing is repeated.
    expect(result.nextQuestion).toBeNull();
  });

  it('never serves the same question twice', async () => {
    const { account, chapterId } = await seedStudentWithDifficulties(['easy', 'easy', 'easy']);

    const session = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 3,
    });
    const first = await answerCorrectly(account, session.id, session.questions[0]!, 10_000);
    const second = await answerCorrectly(account, session.id, first.nextQuestion!, 10_000);

    const served = [session.questions[0]!.id, first.nextQuestion!.id, second.nextQuestion!.id];
    expect(new Set(served).size).toBe(3);
  });

  it('refuses an answer to a served question that lost its race with submission', async () => {
    // The same guard `saveAnswers` carries, on the append that serves the next
    // question. Not reachable through the service alone — it requires the
    // session to be submitted between the read and the append — so this drives
    // `repository.appendServedQuestion` directly against a session that has one
    // unanswered question still outstanding.
    const { account, chapterId } = await seedStudentWithDifficulties(['easy', 'easy']);
    const session = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 2,
    });

    await harness.postgres.client.query(
      `update practice_sessions
          set submitted_at = now(), score_percent = 0, xp_earned = 0, is_valid = true
        where id = $1`,
      [session.id],
    );

    const repository = createPracticeRepository(harness.container.poolFor('practice'));
    const appended = await repository.appendServedQuestion(
      session.id,
      session.questions[0]!.id,
      [0],
      harness.clock.now(),
    );
    expect(appended).toBe(false);
  });

  it('refuses to append a question that is already in question_ids — review round 1, Finding 1', async () => {
    // The second half of `appendServedQuestion`'s guard: not just "was this
    // session submitted", but "is this question already served". Proved
    // directly and DETERMINISTICALLY here (no timing dependency) before the
    // genuinely concurrent version below: the SAME not-yet-served question is
    // appended twice back to back, and the second call must be refused.
    const { account, chapterId } = await seedStudentWithDifficulties(['easy', 'easy', 'easy']);
    const session = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 3,
    });

    const { rows: poolRows } = await harness.postgres.client.query<{ id: string }>(
      `select id from questions where chapter_id = $1 and id <> $2`,
      [chapterId, session.questions[0]!.id],
    );
    const nextQuestionId = poolRows[0]!.id;

    const repository = createPracticeRepository(harness.container.poolFor('practice'));
    const now = harness.clock.now();

    const firstAppend = await repository.appendServedQuestion(session.id, nextQuestionId, [0], now);
    expect(firstAppend).toBe(true); // A genuinely NEW question — the guard's positive case.

    const secondAppend = await repository.appendServedQuestion(
      session.id,
      nextQuestionId,
      [1, 0],
      now,
    );
    expect(secondAppend).toBe(false); // Same id, now already present — refused.

    const { rows } = await harness.postgres.client.query<{ question_ids: string[] }>(
      `select question_ids from practice_sessions where id = $1`,
      [session.id],
    );
    expect(rows[0]!.question_ids).toHaveLength(2); // [first, nextQuestionId] — not three.
    expect(rows[0]!.question_ids.filter((id) => id === nextQuestionId)).toHaveLength(1);
  });

  it('never lets two concurrent answers to the SAME open question append the next one twice — Finding 1', async () => {
    /**
     * THE FAILURE SCENARIO FROM THE REVIEW, END TO END.
     *
     * Two `submitAnswer` calls in flight for the SAME open question both pass
     * the "not yet answered" check and both write an identical answer to
     * `saveAnswers` — harmless. Before the fix, both would then go on to
     * `chooseQuestion` and `appendServedQuestion` for the SAME next question:
     * `array_append` does not deduplicate, so `question_ids` held it twice,
     * and the SECOND merge silently overwrote the first client's shuffle map
     * out from under it.
     *
     * `random: () => 0.5` (the harness default) makes `chooseQuestion` pick
     * deterministically, so both concurrent calls draw the SAME candidate —
     * the exact collision the fix has to survive, not a coin flip that might
     * dodge it.
     *
     * `Promise.all` fires both `submitAnswer` calls together; each does
     * several real awaits against Postgres (`readMastery`, `readQuestions`,
     * `appendServedQuestion`, …), so the event loop genuinely interleaves
     * them rather than running one to completion before the other starts.
     */
    const { account, chapterId } = await seedStudentWithDifficulties(['easy', 'easy', 'easy']);
    const session = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 3,
    });
    const question = session.questions[0]!;

    harness.clock.advanceMs(10_000);
    const outcomes = await Promise.allSettled([
      harness.practice.service.submitAnswer(actorOf(account), session.id, {
        questionId: question.id,
        selectedIndex: correctPositionOf(question),
        timeSpentMs: 10_000,
        hintLevelUsed: 0,
      }),
      harness.practice.service.submitAnswer(actorOf(account), session.id, {
        questionId: question.id,
        selectedIndex: correctPositionOf(question),
        timeSpentMs: 10_000,
        hintLevelUsed: 0,
      }),
    ]);

    // Exactly one caller actually served the next question; the other lost
    // the race and was refused with a conflict — never both succeeding with
    // the same id, and never both silently landing.
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<AnswerResult> => outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConflictError);

    const { rows } = await harness.postgres.client.query<{
      question_ids: string[];
      option_order: Record<string, number[]>;
    }>(`select question_ids, option_order from practice_sessions where id = $1`, [session.id]);

    // NO DUPLICATE. `question_ids` is [first, next] — two entries, not three.
    expect(rows[0]!.question_ids).toHaveLength(2);
    expect(new Set(rows[0]!.question_ids).size).toBe(2);

    // ONE UNTOUCHED MAP. The winner's `nextQuestion` id has exactly the map
    // it was served with — never silently replaced by a second merge.
    const nextId = fulfilled[0]!.value.nextQuestion!.id;
    expect(rows[0]!.option_order[nextId]).toBeDefined();
  });
});

// ===========================================================================
// A SESSION THAT ENDED EARLY IS SCORED AGAINST WHAT IT SERVED — Task 6
// ===========================================================================

describe('submitSession — scores against what was served, not the target', () => {
  it('scores a session that ended early against what it served, not its target', async () => {
    // The chapter holds two questions and the student asked for five. Scoring
    // two correct answers out of a target of five would report 40% for a
    // faultless attempt, and the anti-cheat count rule would fail it outright.
    const { account, chapterId } = await seedStudentWithDifficulties(['easy', 'easy']);

    const session = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 5,
    });
    const first = await answerCorrectly(account, session.id, session.questions[0]!, 10_000);
    await answerCorrectly(account, session.id, first.nextQuestion!, 10_000);

    const result = await harness.practice.service.submitSession(actorOf(account), session.id);

    expect(result.questionCount).toBe(2);
    expect(result.scorePercent).toBe(100);
  });
});

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
    //
    // THE REQUEST NO LONGER CARRIES `firstSelectedIndex` (D-282). Everything
    // asserted below is written from what the server itself observed.
    const { account, chapterId } = await seedStudent({ questionCount: 1 });
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 1,
    });
    const question = started.questions[0]!;
    const correctPosition = question.options.findIndex((option) => option.endsWith('option 0'));

    harness.clock.advanceMs(9_000);
    await harness.practice.service.submitAnswer(actorOf(account), started.id, {
      questionId: question.id,
      selectedIndex: correctPosition,
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
    expect(row.answer_changed).not.toBeNull();
    expect(row.hint_level_used).toBe(2);
    expect(row.confidence).toBe('unsure');
    expect(row.time_spent_ms).toBe(9_000);
    expect(row.authored_difficulty).toBe('medium');
    expect(row.explanation_format_used).toBe('worked_example');
  });

  it('freezes the pace target of the question that was served', async () => {
    // A medium question is served (seedStudent's default difficulty); the
    // target recorded must be medium's 45s, not a default and not whatever
    // TIME_TARGET_MS says when the report is run.
    const { account, chapterId } = await seedStudent({ questionCount: 1 });
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 1,
    });
    const question = started.questions[0]!;
    expect(question.difficulty).toBe('medium');
    const correctPosition = question.options.findIndex((option) => option.endsWith('option 0'));

    harness.clock.advanceMs(9_000);
    await harness.practice.service.submitAnswer(actorOf(account), started.id, {
      questionId: question.id,
      selectedIndex: correctPosition,
      timeSpentMs: 9_000,
      hintLevelUsed: 0,
    });
    await harness.practice.service.submitSession(actorOf(account), started.id);

    const { rows } = await harness.postgres.client.query<{
      time_target_ms: number;
      authored_difficulty: string;
    }>(`select time_target_ms, authored_difficulty from practice_responses where session_id = $1`, [
      started.id,
    ]);

    const row = rows[0]!;
    expect(row.time_target_ms).toBe(45_000);
    expect(row.authored_difficulty).toBe('medium');
  });
});

// ===========================================================================
// THE ANSWER KEY IS DISCLOSED ONCE, AND THE RECORD CLOSES WITH IT — D-281
//
// The exploit these tests exist for was executed end to end by an auditor:
// six questions answered wrong, each response read for the revealed correct
// position, all six re-answered with it. 100%, six correct, full XP, and six
// rows that looked like a flawless first attempt. Every anti-cheat rule passed,
// correctly — none of them is about this.
// ===========================================================================

describe('submitAnswer — reveal-then-re-answer', () => {
  /** Answers every question WRONG, keeping the revealed correct position. */
  async function answerAllWrongAndCollectTheReveal(
    account: HarnessAccount,
    sessionId: string,
  ): Promise<{ questionId: string; revealedCorrectPosition: number }[]> {
    const session = await harness.practice.service.getSession(actorOf(account), sessionId);
    const revealed: { questionId: string; revealedCorrectPosition: number }[] = [];
    let question: PracticeQuestion | null = session.questions[0] ?? null;

    while (question !== null) {
      harness.clock.advanceMs(PASSING_TIME_MS);
      const wrongPosition = wrongPositionOf(question);

      const result = await harness.practice.service.submitAnswer(actorOf(account), sessionId, {
        questionId: question.id,
        selectedIndex: wrongPosition,
        timeSpentMs: PASSING_TIME_MS,
        hintLevelUsed: 0,
      });

      expect(result.isCorrect).toBe(false);
      revealed.push({
        questionId: question.id,
        revealedCorrectPosition: result.correctPresentationIndex,
      });
      question = result.nextQuestion;
    }

    return revealed;
  }

  it('REFUSES a second answer to a question whose answer key was already disclosed', async () => {
    const { account, chapterId } = await seedStudent({ questionCount: 4 });
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });

    const revealed = await answerAllWrongAndCollectTheReveal(account, started.id);

    for (const { questionId, revealedCorrectPosition } of revealed) {
      harness.clock.advanceMs(PASSING_TIME_MS);
      await expect(
        harness.practice.service.submitAnswer(actorOf(account), started.id, {
          questionId,
          selectedIndex: revealedCorrectPosition,
          timeSpentMs: PASSING_TIME_MS,
          hintLevelUsed: 0,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    }
  });

  it('scores the session ZERO — the six re-answers changed nothing at all', async () => {
    const { account, chapterId } = await seedStudent({ questionCount: 4 });
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });

    const revealed = await answerAllWrongAndCollectTheReveal(account, started.id);

    for (const { questionId, revealedCorrectPosition } of revealed) {
      harness.clock.advanceMs(PASSING_TIME_MS);
      await harness.practice.service
        .submitAnswer(actorOf(account), started.id, {
          questionId,
          selectedIndex: revealedCorrectPosition,
          timeSpentMs: PASSING_TIME_MS,
          hintLevelUsed: 0,
        })
        .catch(() => undefined);
    }

    const result = await harness.practice.service.submitSession(actorOf(account), started.id);

    // The numbers the auditor's run produced were 100 / 4 / 110.
    expect(result.scorePercent).toBe(0);
    expect(result.correctCount).toBe(0);
    expect(result.xpAwarded).toBe(0);

    const { rows } = await harness.postgres.client.query<{ is_correct: boolean }>(
      `select is_correct from practice_responses where session_id = $1`,
      [started.id],
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => !row.is_correct)).toBe(true);
  });

  it('refuses the re-answer WITHOUT disclosing whether it was right', async () => {
    // The refusal is thrown before the answer key is consulted, so a student
    // cannot use the 409 itself as an oracle. Both branches are the same error.
    const { account, chapterId } = await seedStudent({ questionCount: 1 });
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 1,
    });
    const question = started.questions[0]!;

    harness.clock.advanceMs(PASSING_TIME_MS);
    const first = await harness.practice.service.submitAnswer(actorOf(account), started.id, {
      questionId: question.id,
      selectedIndex: 0,
      timeSpentMs: PASSING_TIME_MS,
      hintLevelUsed: 0,
    });

    const wrongAgain = (first.correctPresentationIndex + 1) % question.options.length;

    const refusals: string[] = [];
    for (const selectedIndex of [first.correctPresentationIndex, wrongAgain]) {
      harness.clock.advanceMs(PASSING_TIME_MS);
      const error = await harness.practice.service
        .submitAnswer(actorOf(account), started.id, {
          questionId: question.id,
          selectedIndex,
          timeSpentMs: PASSING_TIME_MS,
          hintLevelUsed: 0,
        })
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );

      expect(error).toBeInstanceOf(ConflictError);
      refusals.push((error as Error).message);
    }

    // A re-answer that would have been RIGHT and one that would have been WRONG
    // are refused identically. Anything else turns the 409 itself into the
    // oracle the 409 exists to remove.
    expect(refusals[0]).toBe(refusals[1]);
  });
});

// ===========================================================================
// THE SERVER RECORDS THE FIRST ANSWER ITSELF — D-282
// ===========================================================================

describe('submitAnswer — the change-of-mind columns are the server’s own', () => {
  it('populates first_selected_index and answer_changed on EVERY response, with the client sending neither', async () => {
    // The audit found both null on five of six responses in an honest journey,
    // because the only source was an optional request field the client omitted.
    // `answerAll` sends `questionId`, `selectedIndex`, `timeSpentMs` and
    // `hintLevelUsed` — nothing else — and the columns still land.
    const { account, chapterId } = await seedStudent({ questionCount: 4 });
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });

    await answerAll(account, started.id, [true, false, true, false]);
    await harness.practice.service.submitSession(actorOf(account), started.id);

    const { rows } = await harness.postgres.client.query<{
      selected_index: number;
      first_selected_index: number | null;
      answer_changed: boolean | null;
    }>(
      `select selected_index, first_selected_index, answer_changed
         from practice_responses where session_id = $1`,
      [started.id],
    );

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.first_selected_index).not.toBeNull();
      expect(row.answer_changed).not.toBeNull();
      // Nothing was re-answered, so the first choice IS the final one — a real
      // observation, where the old code wrote "the client did not tell us".
      expect(row.first_selected_index).toBe(row.selected_index);
      expect(row.answer_changed).toBe(false);
    }
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
    harness.clock.advanceMs(PASSING_TIME_MS);

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

describe('the per-question shuffle map — EACH QUESTION HAS ITS OWN, AND IT IS USED', () => {
  it('stores an index that round-trips through THAT question’s map, not another’s', async () => {
    /**
     * THE MULTI-QUESTION D-058 TEST.
     *
     * `startSession` builds one map PER QUESTION. `shuffleFor` must return the
     * map belonging to the question being answered. Returning the first
     * question's map for all of them compiles, keeps every index in range, and
     * passed 219 of 219 tests — because the harness's constant random source
     * makes all the maps identical.
     *
     * Here they are genuinely different, asserted before anything else. Each
     * answer taps a position that THIS question's map moved, and the stored
     * index is checked against THIS question's map. Under the cross-wired bug
     * at least one of these disagrees.
     */
    const { account, chapterId } = await seedStudent({ questionCount: 6 });
    const varying = createVaryingShufflePractice();

    const started = await varying.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 6,
    });

    // A position that the question's OWN map moved, chosen per question so a
    // fixed point cannot make the assertion vacuous.
    //
    // WALKS `nextQuestion` (Task 5): the session arrives with one question and
    // its map, and every later question's map is appended only once the one
    // before it is answered — so each is read from the database right before
    // it is used, rather than all six being read upfront.
    const tapped = new Map<string, { position: number; canonical: number }>();
    const serialised: string[] = [];

    let question: PracticeQuestion | null = started.questions[0] ?? null;
    while (question !== null) {
      const { rows: sessionRows } = await harness.postgres.client.query<{
        option_order: Record<string, number[]>;
      }>(`select option_order from practice_sessions where id = $1`, [started.id]);
      const map = sessionRows[0]!.option_order[question.id]!;
      serialised.push(map.join(''));

      const position = map.findIndex((canonical, index) => canonical !== index);
      expect(position).toBeGreaterThanOrEqual(0);
      tapped.set(question.id, { position, canonical: map[position]! });

      harness.clock.advanceMs(PASSING_TIME_MS);
      const result = await varying.service.submitAnswer(actorOf(account), started.id, {
        questionId: question.id,
        selectedIndex: position,
        timeSpentMs: PASSING_TIME_MS,
        hintLevelUsed: 0,
      });
      question = result.nextQuestion;
    }

    // THE PRECONDITION, IN TWO PARTS. The maps must reorder, and they must
    // differ from each other — the harness default satisfies the first and
    // fails the second, which is the whole gap.
    expect(serialised).not.toContain('0123');
    expect(new Set(serialised).size).toBeGreaterThan(1);

    await varying.service.submitSession(actorOf(account), started.id);

    const { rows } = await harness.postgres.client.query<{
      question_id: string;
      selected_index: number;
    }>(`select question_id, selected_index from practice_responses where session_id = $1`, [
      started.id,
    ]);
    expect(rows).toHaveLength(6);

    for (const row of rows) {
      const expected = tapped.get(row.question_id)!;
      expect({
        questionId: row.question_id,
        stored: row.selected_index,
      }).toEqual({ questionId: row.question_id, stored: expected.canonical });
      // And it went through a translation rather than being echoed back.
      expect(row.selected_index).not.toBe(expected.position);
    }
  });

  it('resolves the misconception through THIS question’s map', async () => {
    // The consequence, not just the mechanism. `distractor_misconceptions` is
    // keyed by ORIGINAL index (D-048); a canonical index derived from another
    // question's permutation names a different distractor and nothing
    // downstream can tell.
    const { account, chapterId } = await seedStudent({ questionCount: 6 });
    const varying = createVaryingShufflePractice();

    const started = await varying.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 6,
    });

    // WRONG AND RIGHT ALTERNATE, so the wrong-answer streak never reaches
    // `RECOVERY_WRONG_STREAK` — past that point `decideNext` correctly returns
    // `flag_for_recovery` with no code, and the assertion would be about the
    // wrong branch.
    //
    // WALKS `nextQuestion` (Task 5) — each question's map is read right before
    // it is used, once `submitAnswer` has appended it.
    let question: PracticeQuestion | null = started.questions[0] ?? null;
    let index = 0;
    while (question !== null) {
      const { rows: sessionRows } = await harness.postgres.client.query<{
        option_order: Record<string, number[]>;
      }>(`select option_order from practice_sessions where id = $1`, [started.id]);
      const map = sessionRows[0]!.option_order[question.id]!;

      const canonicalCorrect = Number(/correct=(\d)/.exec(question.questionText)?.[1] ?? '0');
      const canonicalWrong = (canonicalCorrect + 1) % 4;
      const answerWrong = index % 2 === 0;
      const position = map.indexOf(answerWrong ? canonicalWrong : canonicalCorrect);

      harness.clock.advanceMs(PASSING_TIME_MS);
      const result = await varying.service.submitAnswer(actorOf(account), started.id, {
        questionId: question.id,
        selectedIndex: position,
        timeSpentMs: PASSING_TIME_MS,
        hintLevelUsed: 0,
      });

      expect(result.isCorrect).toBe(!answerWrong);
      if (answerWrong) {
        // The fixture keys its codes by canonical index, so the code has to
        // name the distractor the student actually chose.
        expect(result.decision).toBe('remediate_misconception');
        expect(result.misconceptionCode).toContain(String(canonicalWrong));
      }
      // The overlay highlights the correct option where THIS question showed it.
      expect(result.correctPresentationIndex).toBe(map.indexOf(canonicalCorrect));

      question = result.nextQuestion;
      index += 1;
    }
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

    // WALKS `nextQuestion` (Task 5) to the end of the chapter — with only two
    // real questions the session ends early rather than repeat one, so this
    // collects every id actually served rather than reading `session.questions`
    // once for a full array that no longer exists.
    const served: string[] = [];
    let question: PracticeQuestion | null = started.questions[0] ?? null;
    while (question !== null) {
      served.push(question.id);
      harness.clock.advanceMs(PASSING_TIME_MS);
      const result = await harness.practice.service.submitAnswer(actorOf(account), started.id, {
        questionId: question.id,
        selectedIndex: correctPositionOf(question),
        timeSpentMs: PASSING_TIME_MS,
        hintLevelUsed: 0,
      });
      question = result.nextQuestion;
    }

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

describe('submitSession — the SERVER bounds the claimed time (the contract’s backstop)', () => {
  /**
   * Answers every question claiming `timeSpentMs` WITHOUT letting that time
   * pass. This is the lie the client is able to tell, written out.
   */
  async function answerAllWithoutSpendingTheTime(
    account: HarnessAccount,
    sessionId: string,
    claimedMs: number,
  ): Promise<void> {
    const session = await harness.practice.service.getSession(actorOf(account), sessionId);
    let question: PracticeQuestion | null = session.questions[0] ?? null;
    while (question !== null) {
      const result = await harness.practice.service.submitAnswer(actorOf(account), sessionId, {
        questionId: question.id,
        selectedIndex: correctPositionOf(question),
        timeSpentMs: claimedMs,
        hintLevelUsed: 0,
      });
      question = result.nextQuestion;
    }
  }

  it('REFUSES six questions claiming 12s each inside a two-second session', async () => {
    /**
     * The contract has always said "the session's own `started_at` bounds the
     * total". It did not: `timeSpentMs` is client-supplied and rule 1 read
     * nothing else, so 72 seconds of claimed work passed inside two real ones.
     *
     * `started_at` and `now` both come from the injected clock, so this is a
     * measurement and not an approximation.
     */
    const { account, chapterId } = await seedStudent({ questionCount: 6 });
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 6,
    });

    await answerAllWithoutSpendingTheTime(account, started.id, 12_000);
    // Two seconds of real time for six questions.
    harness.clock.advanceMs(2_000);

    const result = await harness.practice.service.submitSession(actorOf(account), started.id);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe('too_fast');
    expect(result.scorePercent).toBe(0);
    expect(result.xpAwarded).toBe(0);
  });

  it('ACCEPTS the same claim once the session has really lasted that long', async () => {
    // The other side of the boundary. Without this the test above passes on a
    // rule that rejects everything.
    const { account, chapterId } = await seedStudent({ questionCount: 6 });
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 6,
    });

    await answerAllWithoutSpendingTheTime(account, started.id, 12_000);
    harness.clock.advanceMs(72_000);

    const result = await harness.practice.service.submitSession(actorOf(account), started.id);
    expect(result.isValid).toBe(true);
    expect(result.scorePercent).toBe(100);
  });

  it('lets a client claim LESS than the wall clock — a paused tab is honest', async () => {
    // The clamp is a CEILING. A student who left the tab open over lunch and
    // reports four honest seconds a question must not be judged on the hour.
    const { account, chapterId } = await seedStudent({ questionCount: 4 });
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });

    await answerAllWithoutSpendingTheTime(account, started.id, 4_000);
    harness.clock.advanceMs(60 * 60 * 1_000);

    const result = await harness.practice.service.submitSession(actorOf(account), started.id);
    expect(result.isValid).toBe(true);
  });
});

describe('submitSession — the same-answer rule reads the SCREEN POSITION', () => {
  it('REJECTS a student who taps the same position on every question', async () => {
    /**
     * THE BORED TAP-THROUGH, END TO END.
     *
     * The options are shuffled with a DIFFERENT map per question, so tapping
     * position 2 six times stores six different canonical indices — which is
     * why the rule, read canonically, fired on 0.1% of exactly this behaviour
     * in a 20,000-trial simulation. The stored indices are asserted to differ
     * below, because without that this test would pass against the old rule.
     */
    const { account, chapterId } = await seedStudent({ questionCount: 6 });
    const varying = createVaryingShufflePractice();

    const started = await varying.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 6,
    });

    // WALKS `nextQuestion` (Task 5): each question's own map is read right
    // before it is tapped, since only the served ones exist yet.
    const TAPPED_POSITION = 2;
    const canonicals: number[] = [];
    let question: PracticeQuestion | null = started.questions[0] ?? null;
    while (question !== null) {
      const { rows: sessionRows } = await harness.postgres.client.query<{
        option_order: Record<string, number[]>;
      }>(`select option_order from practice_sessions where id = $1`, [started.id]);
      canonicals.push(sessionRows[0]!.option_order[question.id]![TAPPED_POSITION]!);

      harness.clock.advanceMs(PASSING_TIME_MS);
      const result = await varying.service.submitAnswer(actorOf(account), started.id, {
        questionId: question.id,
        selectedIndex: TAPPED_POSITION,
        timeSpentMs: PASSING_TIME_MS,
        hintLevelUsed: 0,
      });
      question = result.nextQuestion;
    }

    // THE PRECONDITION. If every map were identical this would be one value and
    // the old rule would have caught it too, proving nothing.
    expect(new Set(canonicals).size).toBeGreaterThan(1);

    const result = await varying.service.submitSession(actorOf(account), started.id);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe('all_same_answer');
    expect(result.scorePercent).toBe(0);
  });

  it('ACCEPTS an honest full-marks attempt whose canonical answers are all the same', async () => {
    /**
     * THE INVERSE FALSE POSITIVE, which is the half that reached real students.
     *
     * Every question here is authored with `correct_index = 1`, which is
     * ordinary in a real chapter. A student who gets all six right taps six
     * different SCREEN POSITIONS and stores the index 1 six times. The
     * canonical rule scored that attempt zero and recorded it as a cheat.
     */
    seedCounter += 1;
    const account = await onboardAccount(harness, `uniform${seedCounter}@example.test`, 'student');
    await harness.learner.service.createProfile(actorOf(account), {
      displayName: `Uniform ${seedCounter}`,
      grade: '8',
      subjects: ['science'],
    });
    const chapterId = await insertChapter(
      harness.postgres.client,
      makeChapter(`uniform${seedCounter}`, {
        grade: '8',
        subjectCode: 'science',
        chapterNumber: 1,
      }),
    );
    for (let index = 0; index < 6; index += 1) {
      await insertQuestion(
        harness.postgres.client,
        chapterId,
        makeQuestion(`uq${seedCounter}-${index}`, {
          correctIndex: 1,
          questionText: `Question ${index} correct=1?`,
          isHeldOut: false,
        }),
      );
    }

    const varying = createVaryingShufflePractice();
    const started = await varying.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 6,
    });

    // WALKS `nextQuestion` (Task 5), one question at a time.
    const positions: number[] = [];
    let question: PracticeQuestion | null = started.questions[0] ?? null;
    while (question !== null) {
      const position = question.options.findIndex((option) => option.endsWith('option 1'));
      positions.push(position);
      harness.clock.advanceMs(PASSING_TIME_MS);
      const result = await varying.service.submitAnswer(actorOf(account), started.id, {
        questionId: question.id,
        selectedIndex: position,
        timeSpentMs: PASSING_TIME_MS,
        hintLevelUsed: 0,
      });
      question = result.nextQuestion;
    }
    // The student really did tap different places. Without varied maps this
    // test would say nothing.
    expect(new Set(positions).size).toBeGreaterThan(1);

    const result = await varying.service.submitSession(actorOf(account), started.id);
    expect(result.isValid).toBe(true);
    expect(result.invalidReason).toBeNull();
    expect(result.scorePercent).toBe(100);

    // And the stored indices are still all canonical 1 — D-058 is untouched by
    // the rule change.
    const { rows } = await harness.postgres.client.query<{ selected_index: number }>(
      `select selected_index from practice_responses where session_id = $1`,
      [started.id],
    );
    expect(rows.map((row) => row.selected_index)).toEqual([1, 1, 1, 1, 1, 1]);
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

  // -------------------------------------------------------------------------
  // THE WRITE PATHS. EVERY TEST ABOVE THIS POINT IS A READ.
  // -------------------------------------------------------------------------

  it('refuses startSession to an actor claiming another tenant', async () => {
    /**
     * `startSession`'s `assertCanAccess` was deletable with 219 of 219 tests
     * still passing — there was no access test for it at all. It is the one
     * call that CREATES a row, and it is the only place the session's tenant is
     * decided, so a hole here files a session under an unchecked tenant and
     * every later check on that row then passes by construction.
     */
    await createSecondTenant(harness);
    const { account, chapterId } = await seedStudent();

    await expect(
      harness.practice.service.startSession(actorOf(account, OTHER_TENANT_ID), {
        chapterId,
        questionCount: 4,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // And nothing was created on the way to the refusal.
    expect(await countRows('practice_sessions', 'student_user_id = $1', [account.userId])).toBe(0);
  });

  it('refuses submitAnswer on another student’s session', async () => {
    // Making `loadSession`'s guard conditional on `action === 'read'` also
    // passed 219 of 219, because every access test was a read.
    const owner = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(owner.account), {
      chapterId: owner.chapterId,
      questionCount: 4,
    });
    const session = await harness.practice.service.getSession(
      actorOf(owner.account),
      started.id,
    );

    seedCounter += 1;
    const intruder = await onboardAccount(
      harness,
      `writer${seedCounter}@example.test`,
      'student',
    );

    await expect(
      harness.practice.service.submitAnswer(actorOf(intruder), started.id, {
        questionId: session.questions[0]!.id,
        selectedIndex: 0,
        timeSpentMs: PASSING_TIME_MS,
        hintLevelUsed: 0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // The owner's session is untouched — no answer was recorded.
    const { rows } = await harness.postgres.client.query<{ answers: Record<string, unknown> }>(
      `select answers from practice_sessions where id = $1`,
      [started.id],
    );
    expect(Object.keys(rows[0]!.answers)).toEqual([]);
  });

  it('refuses submitSession on another student’s session', async () => {
    /**
     * DEFENCE IN DEPTH, AND WORTH KNOWING WHICH LAYER IS ANSWERING. `learner`
     * guards `getMastery` for a student who is not the actor, so this deny
     * survives even with practice's own write guard removed. The two tests
     * either side of it — `submitAnswer` cross-student, and both writes
     * cross-tenant — are the ones that isolate practice's guard, and both fail
     * the moment `loadSession` stops authorising writes.
     */
    const owner = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(owner.account), {
      chapterId: owner.chapterId,
      questionCount: 4,
    });
    await answerAll(owner.account, started.id, [true, true, true, true]);

    seedCounter += 1;
    const intruder = await onboardAccount(
      harness,
      `submitter${seedCounter}@example.test`,
      'student',
    );

    await expect(
      harness.practice.service.submitSession(actorOf(intruder), started.id),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // Nothing was scored, awarded or written on somebody else's behalf.
    expect(
      await countRows('practice_sessions', 'id = $1 and submitted_at is null', [started.id]),
    ).toBe(1);
    expect(await countRows('xp_ledger', 'source_id = $1', [started.id])).toBe(0);
    expect(await countRows('practice_responses', 'session_id = $1', [started.id])).toBe(0);
  });

  it('refuses submitAnswer and submitSession to an actor claiming another tenant', async () => {
    // The cross-TENANT half of the same hole, on both writes. The tenant on the
    // session row is what is compared (D-073, D-091), so a claimed tenant that
    // does not match the data is refused before a question is loaded.
    await createSecondTenant(harness);
    const { account, chapterId } = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    const session = await harness.practice.service.getSession(actorOf(account), started.id);
    const foreign = actorOf(account, OTHER_TENANT_ID);

    await expect(
      harness.practice.service.submitAnswer(foreign, started.id, {
        questionId: session.questions[0]!.id,
        selectedIndex: 0,
        timeSpentMs: PASSING_TIME_MS,
        hintLevelUsed: 0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(
      harness.practice.service.submitSession(foreign, started.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('carries no session data on a WRITE deny either', async () => {
    const owner = await seedStudent();
    const started = await harness.practice.service.startSession(actorOf(owner.account), {
      chapterId: owner.chapterId,
      questionCount: 4,
    });

    seedCounter += 1;
    const intruder = await onboardAccount(
      harness,
      `quiet${seedCounter}@example.test`,
      'student',
    );

    const error = await harness.practice.service
      .submitSession(actorOf(intruder), started.id)
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

// ===========================================================================
// THE SAME NAME IS THE SAME NUMBER — D-283
// ===========================================================================

describe('getHistory — xpAwarded is the ledger credit, and submit agrees', () => {
  it('reports the AWARDED figure on a capped session, not the uncapped one', async () => {
    // `SubmissionResult.xpEarned` is pre-cap and `HistoryEntry`'s field was also
    // called `xpEarned` while carrying the post-cap number. A capped session
    // returned 110 from submit and 0 from history under one name in one contract
    // file, so a client rendering its own history showed 0 for a session the
    // student had just been congratulated on.
    const { account, chapterId } = await seedStudent();

    // Fill the day's cap outside practice, so the next session is fully clamped.
    await harness.postgres.client.query(
      `insert into xp_ledger (student_user_id, tenant_id, source, source_id, amount, created_at)
       values ($1, $2, 'practice_session', $3, $4, $5)`,
      [
        account.userId,
        TEST_TENANT_ID,
        chapterId,
        XP_RULES.dailyCap,
        harness.clock.now().toISOString(),
      ],
    );

    const started = await harness.practice.service.startSession(actorOf(account), {
      chapterId,
      questionCount: 4,
    });
    await answerAll(account, started.id, [true, true, true, true]);
    const result = await harness.practice.service.submitSession(actorOf(account), started.id);

    // The cap really did bite — otherwise the two numbers agree by accident and
    // this test would pass against the defect.
    expect(result.dailyCapReached).toBe(true);
    expect(result.xpAwarded).toBe(0);
    expect(result.xpEarned).toBeGreaterThan(0);

    const history = await harness.practice.service.getHistory(actorOf(account), 10);
    const entry = history.find((row) => row.sessionId === started.id)!;

    expect(entry.xpAwarded).toBe(result.xpAwarded);
  });
});

// ===========================================================================
// THE PROGRESS SCREEN DOES NOT ISSUE ONE QUERY PER CHAPTER — D-284
// ===========================================================================

describe('getProgress — chapter titles are fetched in bulk', () => {
  /** A practice module that COUNTS the chapter reads its service performs. */
  function createCountingPractice(): {
    module: ReturnType<typeof createPracticeModule>;
    counts: { readChapter: number; listChapters: number };
  } {
    const counts = { readChapter: 0, listChapters: 0 };

    const module = createPracticeModule({
      db: harness.container.poolFor('practice'),
      clock: harness.clock,
      logger: harness.logger,
      requireSession: harness.identity.requireSession,
      readQuestions: (actor, query) => harness.content.service.getQuestionsForChapter(actor, query),
      readChapter: async (actor, id) => {
        counts.readChapter += 1;
        try {
          return await harness.content.service.getChapter(actor, id);
        } catch {
          return null;
        }
      },
      listChapters: (actor, filter) => {
        counts.listChapters += 1;
        return harness.content.service.listChapters(actor, {
          grade: filter.grade,
          subject: filter.subjectCode,
          limit: filter.limit,
        });
      },
      readStudentContext: async (actor, studentUserId) => {
        const profile = await harness.learner.service.getProfile(actor, studentUserId);
        const subjects = await harness.learner.service.getSubjects(actor, studentUserId);
        return { grade: profile.grade, subjects };
      },
      readMastery: (actor, studentUserId) =>
        harness.learner.service.getMastery(actor, studentUserId),
      writeMastery: (actor, input) => harness.learner.service.updateMastery(actor, input),
      readTenantOfStudent: (studentUserId) =>
        harness.identity.service.getTenantOfUser(studentUserId),
      random: () => 0.5,
    });

    return { module, counts };
  }

  it('issues NO per-chapter read for chapters in the student’s own grade', async () => {
    // This was `await deps.readChapter(...)` inside the mastery loop: one query
    // per chapter the student had ever practised, sequentially, growing every
    // week they used the product.
    const { account } = await seedStudent();
    const { module, counts } = createCountingPractice();

    const chapterIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      seedCounter += 1;
      const chapterId = await insertChapter(
        harness.postgres.client,
        makeChapter(`bulk${seedCounter}`, {
          grade: '8',
          subjectCode: 'science',
          chapterNumber: index + 2,
        }),
      );
      chapterIds.push(chapterId);
      await harness.learner.service.updateMastery(actorOf(account), {
        studentUserId: account.userId,
        chapterId,
        masteryScore: 60,
        expectedPreviousScore: null,
        attemptIncrement: 1,
        practised: true,
      });
    }

    counts.readChapter = 0;
    counts.listChapters = 0;

    const progress = await module.service.getProgress(actorOf(account));

    expect(progress.chapters).toHaveLength(chapterIds.length);
    // Every title is real — a bulk fetch that silently blanked them would
    // otherwise satisfy the count assertion below.
    expect(progress.chapters.every((chapter) => chapter.chapterTitleEn.length > 0)).toBe(true);

    // One `listChapters` for the student's one subject, and nothing per chapter.
    expect(counts.readChapter).toBe(0);
    expect(counts.listChapters).toBe(1);
  });
});

// ===========================================================================
// THE MISSION'S PER-SUBJECT READS ARE ISSUED TOGETHER — D-284
// ===========================================================================

describe('getTodaysMission — the subject chapter lists do not wait for each other', () => {
  it('has BOTH subject reads in flight at once', async () => {
    /**
     * A BARRIER ON THE INJECTED SEAM, not a stopwatch — the D-246 pattern.
     *
     * `listChapters` here does not resolve until it has been ENTERED once per
     * subject. Issued together, both calls arrive, the barrier opens and the
     * mission is built. Issued sequentially — the shape this was before — the
     * first call waits for a second that cannot happen until it returns, and the
     * test fails on its timeout rather than on a timing threshold that would be
     * flaky on a loaded machine.
     */
    const subjects = ['science', 'math'];
    let entered = 0;
    let open: (() => void) | null = null;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });

    seedCounter += 1;
    const account = await onboardAccount(harness, `two${seedCounter}@example.test`, 'student');
    await harness.learner.service.createProfile(actorOf(account), {
      displayName: `Two subjects ${seedCounter}`,
      grade: '8',
      subjects,
    });
    for (const [index, subjectCode] of subjects.entries()) {
      await insertChapter(
        harness.postgres.client,
        makeChapter(`two${seedCounter}-${subjectCode}`, {
          grade: '8',
          subjectCode,
          chapterNumber: index + 1,
        }),
      );
    }

    const module = createPracticeModule({
      db: harness.container.poolFor('practice'),
      clock: harness.clock,
      logger: harness.logger,
      requireSession: harness.identity.requireSession,
      readQuestions: (actor, query) => harness.content.service.getQuestionsForChapter(actor, query),
      readChapter: async (actor, id) => {
        try {
          return await harness.content.service.getChapter(actor, id);
        } catch {
          return null;
        }
      },
      listChapters: async (actor, filter) => {
        entered += 1;
        if (entered >= subjects.length) {
          open?.();
        }
        await opened;
        return harness.content.service.listChapters(actor, {
          grade: filter.grade,
          subject: filter.subjectCode,
          limit: filter.limit,
        });
      },
      readStudentContext: async (actor, studentUserId) => {
        const profile = await harness.learner.service.getProfile(actor, studentUserId);
        const studentSubjects = await harness.learner.service.getSubjects(actor, studentUserId);
        return { grade: profile.grade, subjects: studentSubjects };
      },
      readMastery: (actor, studentUserId) =>
        harness.learner.service.getMastery(actor, studentUserId),
      writeMastery: (actor, input) => harness.learner.service.updateMastery(actor, input),
      readTenantOfStudent: (studentUserId) =>
        harness.identity.service.getTenantOfUser(studentUserId),
      random: () => 0.5,
    });

    await module.service.getTodaysMission(actorOf(account));

    expect(entered).toBe(subjects.length);
  }, 15_000);
});
