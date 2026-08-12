import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@/platform/clock/index';
import { createDb, type DbHandle } from '@/platform/db/index';
import { FakeLogger } from '@/platform/logger/fake-logger';
import type { Grade } from '@/shared/constants/curriculum';
import { createLearnerRepository } from '../../learner/learner.repository';
import { createLearnerService, type LearnerService } from '../../learner/learner.service';
import { MASTERY_LEARNING_RATE } from '../domain/mastery-update';
import { XP_RULES } from '../domain/xp-rules';
import { createPracticeRepository } from '../practice.repository';
import { createPracticeService, type PracticeService } from '../practice.service';
import type {
  ChapterSummary,
  MasterySnapshot,
  PracticeActor,
  PracticeQuestionRecord,
} from '../practice.types';
import {
  insertChapter,
  insertQuestion,
  insertUser,
  makeChapter,
  makeQuestion,
} from '../../../../tests/fixtures/index';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../../../../tests/helpers/postgres';

/**
 * =============================================================================
 * THE TWO CONCURRENCY DEFECTS — D-241 (mastery lost update) and D-242 (the
 * daily XP cap exceeded), PROVED AGAINST A REAL POSTGRES WITH REAL CONCURRENT
 * TRANSACTIONS.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS SEPARATELY FROM `practice.service.test.ts`.
 *
 * Everything in that file submits ONE session at a time. Both defects here are
 * invisible to a serial submission BY CONSTRUCTION: a lost update needs two
 * readers of the same value, and a cap that two submissions jointly exceed
 * needs two submissions. A test that `await`s one submission and then the next
 * proves nothing about either — it proves only that the arithmetic is right,
 * which was never in doubt. Both defects shipped under a green suite for
 * exactly that reason.
 *
 * -----------------------------------------------------------------------------
 * WHAT MAKES THESE GENUINELY CONCURRENT, AND NOT TWO AWAITS IN A ROW.
 *
 * Three things, all of which have to hold:
 *
 *  1. A REAL POOL WITH REAL CONNECTIONS. `createDb` with `poolMax` above the
 *     number of submissions in flight, so every submission holds its OWN
 *     backend and its own transaction. One connection would serialise them at
 *     the driver and every assertion below would pass vacuously.
 *
 *  2. THE SUBMISSIONS ARE LAUNCHED WITH `Promise.all`, never awaited in turn.
 *
 *  3. A BARRIER ON A SEAM THAT IS ALREADY INJECTED — `readMastery`, the last
 *     thing every submission does BEFORE it opens its transaction. The barrier
 *     releases only once all parties have arrived, so it is impossible for one
 *     submission to have committed before another has taken the read it will
 *     compute from. That is the precise interleaving both defects require, made
 *     to happen on purpose rather than waited for.
 *
 *     NO `sleep`, and no timeout. The barrier is a promise resolved by the Nth
 *     arrival, so the test is as fast as the database and cannot flake on a
 *     slow machine — the two failure modes a `setTimeout` would have.
 *
 *     IT TRIPS ONCE AND THEN PASSES THROUGH. D-241's fix RETRIES, and a retry
 *     re-reads mastery through this same seam. A barrier that re-armed would
 *     deadlock the retry against a party that is never coming.
 * -----------------------------------------------------------------------------
 *
 * The clock is injected and fixed. Nothing here reads the wall clock.
 * =============================================================================
 */

let postgres: TestPostgres;
let handle: DbHandle;

const clock = new FixedClock('2026-03-02T09:00:00.000Z');
const logger = new FakeLogger();

/** Two questions per session — below `SAME_ANSWER_MIN_QUESTIONS`, so the
 *  same-position rule cannot fire and confuse a mastery assertion. */
const QUESTIONS_PER_SESSION = 2;

/** Comfortably above `MIN_AVERAGE_MS_PER_QUESTION`, and below the real window. */
const TIME_PER_QUESTION_MS = 6_000;

/** How far the clock moves between starting a session and submitting it. */
const SESSION_WALL_CLOCK_MS = 120_000;

beforeAll(async () => {
  postgres = await startTestPostgres();
  await applyAllMigrations(postgres.client);
  // Room for every submission in flight to hold its own connection, plus the
  // setup/assertion queries. A pool smaller than the party count would
  // serialise the submissions and quietly turn every test below green.
  handle = createDb({ url: postgres.url, poolMax: 12, ssl: false });
}, 240_000);

afterAll(async () => {
  await handle.close();
  await postgres.stop();
}, 60_000);

/**
 * A barrier that releases when `parties` callers have arrived, and is a no-op
 * for every caller after that.
 *
 * The pass-through half is load-bearing — see note 3 in the header.
 */
interface Barrier {
  arrive(): Promise<void>;
}

function createBarrier(parties: number): Barrier {
  let arrived = 0;
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  let tripped = false;

  return {
    async arrive(): Promise<void> {
      if (tripped) return;
      arrived += 1;
      if (arrived >= parties) {
        tripped = true;
        release();
        return;
      }
      await opened;
    },
  };
}

interface Fixture {
  readonly studentUserId: string;
  readonly tenantId: string;
  readonly actor: PracticeActor;
  readonly chapterIds: readonly string[];
}

/**
 * The next chapter number to hand out.
 *
 * `chapters` carries UNIQUE (grade, subject_code, chapter_number) — its natural
 * key — and this file deliberately does NOT truncate between tests: the defects
 * under test are about rows accumulating, and a `beforeEach` that emptied the
 * tables would be one edit away from also emptying the evidence. So each test
 * gets fresh chapter numbers and a fresh student instead, and every assertion
 * is scoped to that student.
 */
let nextChapterNumber = 1;

/**
 * A raw query against the test database.
 *
 * Typed `Record<string, unknown>` rather than left as the driver's `any`:
 * every caller below narrows the row it wants, and an `any` here would make
 * those narrowings silently vacuous.
 */
async function sql(
  text: string,
  values: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const result = await postgres.client.query<Record<string, unknown>>(text, [...values]);
  return result.rows;
}

/** `users.tenant_id`, or null when there is no such user. */
async function tenantOfUser(userId: string): Promise<string | null> {
  const rows = await sql('select tenant_id from users where id = $1', [userId]);
  const row = rows[0];
  if (row === undefined) return null;
  return String(row.tenant_id);
}

/** A student, their profile, and `chapterCount` chapters of two questions each. */
async function seed(chapterCount: number): Promise<Fixture> {
  const email = `concurrency-${String(Date.now())}-${String(Math.random()).slice(2)}@test.local`;
  const studentUserId = await insertUser(postgres.client, email, 'student');

  const tenantId = await tenantOfUser(studentUserId);
  if (tenantId === null) throw new Error('seed: users row carried no tenant_id');

  await sql(
    `insert into students (user_id, display_name, grade, board, preferred_language, tenant_id)
       values ($1, 'Concurrency Student', '8', 'CBSE', 'en', $2)`,
    [studentUserId, tenantId],
  );

  const chapterIds: string[] = [];
  for (let index = 0; index < chapterCount; index += 1) {
    const chapterNumber = nextChapterNumber;
    nextChapterNumber += 1;

    const chapterId = await insertChapter(
      postgres.client,
      makeChapter(`conc-${String(chapterNumber)}`, { chapterNumber }),
    );
    for (let q = 0; q < QUESTIONS_PER_SESSION; q += 1) {
      await insertQuestion(
        postgres.client,
        chapterId,
        makeQuestion(`conc-${String(chapterNumber)}-${String(q)}`, { correctIndex: 0 }),
      );
    }
    chapterIds.push(chapterId);
  }

  return {
    studentUserId,
    tenantId,
    actor: { userId: studentUserId, role: 'student', tenantId },
    chapterIds,
  };
}

/** Reads the questions of a chapter straight out of `questions`. */
async function questionsOfChapter(chapterId: string): Promise<PracticeQuestionRecord[]> {
  const rows = await sql(
    `select id, chapter_id, question_text, options, correct_index, explanation,
            difficulty, bloom_level, distractor_misconceptions
       from questions
      where chapter_id = $1 and is_active and not is_held_out
      order by created_at, id`,
    [chapterId],
  );

  return rows.map((row): PracticeQuestionRecord => {
    const record = row as {
      id: string;
      chapter_id: string;
      question_text: string;
      options: string[];
      correct_index: number;
      explanation: string;
      difficulty: PracticeQuestionRecord['difficulty'];
      bloom_level: PracticeQuestionRecord['bloomLevel'];
      distractor_misconceptions: Record<string, string> | null;
    };
    return {
      id: record.id,
      chapterId: record.chapter_id,
      questionText: record.question_text,
      options: record.options,
      correctIndex: record.correct_index,
      explanation: record.explanation,
      difficulty: record.difficulty,
      bloomLevel: record.bloom_level,
      distractorMisconceptions: record.distractor_misconceptions,
    };
  });
}

async function chapterSummary(chapterId: string): Promise<ChapterSummary | null> {
  const rows = await sql(
    `select id, grade, subject_code, chapter_number, title_en, title_hi
       from chapters where id = $1 and is_active`,
    [chapterId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const record = row as {
    id: string;
    grade: Grade;
    subject_code: string;
    chapter_number: number;
    title_en: string;
    title_hi: string | null;
  };
  return {
    id: record.id,
    grade: record.grade,
    subjectCode: record.subject_code,
    chapterNumber: record.chapter_number,
    titleEn: record.title_en,
    titleHi: record.title_hi,
  };
}

interface Wiring {
  readonly practice: PracticeService;
  readonly learner: LearnerService;
}

/**
 * The SAME graph `app/routes.ts` builds — `writeMastery` bound to
 * `learner.updateMastery`, so the mastery write really does travel across a
 * module boundary inside practice's transaction (D-056).
 *
 * `content` is replaced by direct reads of its tables rather than by its
 * service: nothing here is about content's authorization, and pulling its
 * module in would add a second pool to a test whose whole subject is how many
 * connections are in flight.
 */
function wire(barrier: Barrier | null): Wiring {
  const learner = createLearnerService({
    repository: createLearnerRepository(handle),
    clock,
    logger,
    readLinkStatus: () => Promise.resolve(null),
    readTenantOfStudent: (studentUserId: string) => tenantOfUser(studentUserId),
  });

  const practice = createPracticeService({
    repository: createPracticeRepository(handle),
    clock,
    logger,
    readQuestions: (_actor, query) => questionsOfChapter(query.chapterId),
    readChapter: (_actor, chapterId) => chapterSummary(chapterId),
    listChapters: () => Promise.resolve([]),
    readStudentContext: () => Promise.resolve({ grade: '8', subjects: ['science'] }),

    /**
     * THE BARRIER SITS HERE. This is the last thing a submission does before
     * `withTransaction`, so holding every party at this line guarantees they
     * all computed their mastery step from the same stored value — the exact
     * precondition of the lost update — and then race into their transactions
     * together.
     */
    readMastery: async (actor, studentUserId): Promise<readonly MasterySnapshot[]> => {
      const rows = await learner.getMastery(actor, studentUserId);
      if (barrier !== null) await barrier.arrive();
      return rows;
    },

    writeMastery: (actor, input) => learner.updateMastery(actor, input),
    readTenantOfStudent: (studentUserId: string) => tenantOfUser(studentUserId),
    // Constant, so the option order is fixed and every assertion below is about
    // concurrency rather than about which option moved where.
    random: () => 0.5,
  });

  return { practice, learner };
}

/**
 * The suffix `makeQuestion` gives the option at CANONICAL index 0, which is the
 * answer on every fixture question here (`correctIndex: 0`).
 *
 * Matching on the TEXT rather than assuming a position is the point: the
 * options arrive shuffled, and a helper that answered "index 0" would be
 * answering whatever the shuffle put there — which would make "all correct" and
 * "all wrong" depend on the permutation instead of on the argument.
 */
const CORRECT_OPTION_SUFFIX = ' option 0';

/**
 * Starts a session on `chapterId` and answers every question, correctly or
 * wrongly as asked.
 */
async function playSession(
  practice: PracticeService,
  fixture: Fixture,
  chapterId: string,
  correct: boolean,
): Promise<string> {
  const session = await practice.startSession(fixture.actor, {
    chapterId,
    questionCount: QUESTIONS_PER_SESSION,
  });

  for (const question of session.questions) {
    const correctPosition = question.options.findIndex((option) =>
      option.endsWith(CORRECT_OPTION_SUFFIX),
    );
    if (correctPosition < 0) {
      throw new Error('playSession: no option carried the canonical answer text');
    }

    const selectedIndex = correct
      ? correctPosition
      : (correctPosition + 1) % question.options.length;

    await practice.submitAnswer(fixture.actor, session.id, {
      questionId: question.id,
      selectedIndex,
      timeSpentMs: TIME_PER_QUESTION_MS,
      hintLevelUsed: 0,
    });
  }

  return session.id;
}

async function masteryRow(
  studentUserId: string,
  chapterId: string,
): Promise<{ masteryScore: number; attempts: number }> {
  const rows = await sql(
    'select mastery_score, attempts from chapter_mastery where student_user_id = $1 and chapter_id = $2',
    [studentUserId, chapterId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('masteryRow: no chapter_mastery row');
  const record = row as { mastery_score: string; attempts: number };
  return { masteryScore: Number(record.mastery_score), attempts: record.attempts };
}

async function ledgerTotal(studentUserId: string): Promise<number> {
  const rows = await sql(
    'select coalesce(sum(amount), 0)::int as total from xp_ledger where student_user_id = $1',
    [studentUserId],
  );
  const row = rows[0] as { total: number } | undefined;
  return row?.total ?? 0;
}

beforeEach(() => {
  clock.setTo('2026-03-02T09:00:00.000Z');
  logger.lines.length = 0;
});

/* ========================================================================== */

describe('D-241 — two concurrent submissions on ONE chapter produce TWO EMA steps', () => {
  /**
   * ===========================================================================
   * THE ASSERTION THAT DISTINGUISHES A FIXED SYSTEM FROM A BROKEN ONE.
   *
   * Both sessions score zero, from a seeded mastery of 1.000. The EMA is
   *
   *     next = previous * (1 - rate) + observed * rate,  observed = 0
   *          = previous * 0.6
   *
   * so ONE step lands 0.600 and TWO land 0.360. Both are plausible numbers in a
   * plausible row, which is precisely why the defect survived: nothing about
   * 0.600 looks wrong until you notice `attempts` says 2.
   *
   * `attempts` is asserted in the SAME expectation, because the defect's real
   * signature is the DISAGREEMENT between the two columns — `attempts`
   * increments in SQL and was always right, so a test that checked only the
   * attempt count passed throughout.
   * ===========================================================================
   */
  it('lands two EMA steps and attempts = 2, not one step and attempts = 2', async () => {
    const fixture = await seed(1);
    const chapterId = fixture.chapterIds[0] ?? '';

    // A prior mastery to blend against. Seeded directly so the test starts from
    // a known level rather than from whatever a warm-up session produced.
    await sql(
      `insert into chapter_mastery (student_user_id, chapter_id, mastery_score, attempts, tenant_id)
         values ($1, $2, '1.000', 0, $3)`,
      [fixture.studentUserId, chapterId, fixture.tenantId],
    );

    const barrier = createBarrier(2);
    const { practice } = wire(barrier);

    const firstSession = await playSession(practice, fixture, chapterId, false);
    const secondSession = await playSession(practice, fixture, chapterId, false);

    clock.advanceMs(SESSION_WALL_CLOCK_MS);

    // GENUINELY CONCURRENT: launched together, never awaited in turn, and held
    // at the barrier until both have read the same prior mastery.
    const results = await Promise.all([
      practice.submitSession(fixture.actor, firstSession),
      practice.submitSession(fixture.actor, secondSession),
    ]);

    expect(results.map((result) => result.scorePercent)).toEqual([0, 0]);

    const oneStep = 1 * (1 - MASTERY_LEARNING_RATE);
    const twoSteps = oneStep * (1 - MASTERY_LEARNING_RATE);

    const row = await masteryRow(fixture.studentUserId, chapterId);
    expect(row).toEqual({ masteryScore: Number(twoSteps.toFixed(3)), attempts: 2 });
    // Stated separately so a failure names the defect rather than a number.
    expect(row.masteryScore).not.toBeCloseTo(oneStep, 3);
  }, 120_000);

  it('reports the mastery it actually wrote, so the evidence label cannot disagree with the row', async () => {
    const fixture = await seed(1);
    const chapterId = fixture.chapterIds[0] ?? '';

    await sql(
      `insert into chapter_mastery (student_user_id, chapter_id, mastery_score, attempts, tenant_id)
         values ($1, $2, '1.000', 0, $3)`,
      [fixture.studentUserId, chapterId, fixture.tenantId],
    );

    const barrier = createBarrier(2);
    const { practice } = wire(barrier);

    const a = await playSession(practice, fixture, chapterId, false);
    const b = await playSession(practice, fixture, chapterId, false);
    clock.advanceMs(SESSION_WALL_CLOCK_MS);

    await Promise.all([
      practice.submitSession(fixture.actor, a),
      practice.submitSession(fixture.actor, b),
    ]);

    // The loser retried rather than silently overwriting, and said so.
    const contended = logger.lines.filter(
      (line) => line.msg === 'practice.session.mastery_contended',
    );
    expect(contended.length).toBeGreaterThanOrEqual(1);

    const row = await masteryRow(fixture.studentUserId, chapterId);
    expect(row.attempts).toBe(2);
  }, 120_000);

  it('writes ONE response set and ONE ledger row per session — the retry does not double-write', async () => {
    const fixture = await seed(1);
    const chapterId = fixture.chapterIds[0] ?? '';

    await sql(
      `insert into chapter_mastery (student_user_id, chapter_id, mastery_score, attempts, tenant_id)
         values ($1, $2, '1.000', 0, $3)`,
      [fixture.studentUserId, chapterId, fixture.tenantId],
    );

    const barrier = createBarrier(2);
    const { practice } = wire(barrier);

    const a = await playSession(practice, fixture, chapterId, false);
    const b = await playSession(practice, fixture, chapterId, false);
    clock.advanceMs(SESSION_WALL_CLOCK_MS);

    await Promise.all([
      practice.submitSession(fixture.actor, a),
      practice.submitSession(fixture.actor, b),
    ]);

    const responses = await sql(
      'select count(*)::int as n from practice_responses where student_user_id = $1',
      [fixture.studentUserId],
    );
    const ledger = await sql('select count(*)::int as n from xp_ledger where student_user_id = $1', [
      fixture.studentUserId,
    ]);

    // Two sessions, two questions each. A rolled-back attempt that had left its
    // responses behind would read 6 or 8 here.
    expect((responses[0] as { n: number }).n).toBe(2 * QUESTIONS_PER_SESSION);
    expect((ledger[0] as { n: number }).n).toBe(2);
  }, 120_000);
});

/* ========================================================================== */

describe('D-242 — concurrent submissions cannot jointly exceed the daily XP cap', () => {
  /**
   * ===========================================================================
   * THREE SESSIONS, THREE DIFFERENT CHAPTERS, ONE STUDENT.
   *
   * DIFFERENT CHAPTERS ON PURPOSE. On one chapter the D-241 compare-and-set
   * would also force a retry, and a retry re-reads the day's XP — so the cap
   * would come out right for a reason that has nothing to do with the cap.
   * Separate chapters remove that help entirely: the ONLY thing standing
   * between these three submissions and 280 XP is the per-student lock and the
   * in-transaction read.
   *
   * The arithmetic: the ledger is seeded at `dailyCap - 40`, so there is room
   * for 40. Each session earns a full house — two correct out of two, which is
   * 100% and therefore both bonuses — and each would be permitted ALONE, taking
   * exactly the remaining 40. Jointly they must still take 40.
   *
   * Under the defect all three read the same seeded total, all three found the
   * same 40 of room, and all three wrote it: `dailyCap + 80`.
   * ===========================================================================
   */
  it('awards the remaining room ONCE across three concurrent submissions', async () => {
    const fixture = await seed(3);
    const seededXp = XP_RULES.dailyCap - 40;

    await sql(
      `insert into xp_ledger (student_user_id, source, source_id, amount, tenant_id, created_at)
         values ($1, 'practice_session', gen_random_uuid(), $2, $3, $4)`,
      [fixture.studentUserId, seededXp, fixture.tenantId, clock.now().toISOString()],
    );

    const barrier = createBarrier(3);
    const { practice } = wire(barrier);

    const sessionIds: string[] = [];
    for (const chapterId of fixture.chapterIds) {
      sessionIds.push(await playSession(practice, fixture, chapterId, true));
    }

    clock.advanceMs(SESSION_WALL_CLOCK_MS);

    const results = await Promise.all(
      sessionIds.map((id) => practice.submitSession(fixture.actor, id)),
    );

    // Every session really did score full marks — otherwise the cap was never
    // under pressure and the assertion below would pass for the wrong reason.
    expect(results.map((result) => result.scorePercent)).toEqual([100, 100, 100]);
    const perSession =
      QUESTIONS_PER_SESSION * XP_RULES.perCorrect + XP_RULES.highScoreBonus + XP_RULES.perfectBonus;
    expect(results.map((result) => result.xpEarned)).toEqual([
      perSession,
      perSession,
      perSession,
    ]);

    const total = await ledgerTotal(fixture.studentUserId);
    expect(total).toBe(XP_RULES.dailyCap);
    // Stated as an inequality too: the cap is a CEILING, and a future change
    // that awards less is a different bug from one that awards more.
    expect(total).toBeLessThanOrEqual(XP_RULES.dailyCap);

    // The awards sum to the room that existed, not to three copies of it.
    const awarded = results.reduce((sum, result) => sum + result.xpAwarded, 0);
    expect(awarded).toBe(40);
  }, 120_000);

  it('still writes a ledger row for the sessions the cap zeroed', async () => {
    const fixture = await seed(3);

    await sql(
      `insert into xp_ledger (student_user_id, source, source_id, amount, tenant_id, created_at)
         values ($1, 'practice_session', gen_random_uuid(), $2, $3, $4)`,
      [
        fixture.studentUserId,
        XP_RULES.dailyCap - 40,
        fixture.tenantId,
        clock.now().toISOString(),
      ],
    );

    const barrier = createBarrier(3);
    const { practice } = wire(barrier);

    const sessionIds: string[] = [];
    for (const chapterId of fixture.chapterIds) {
      sessionIds.push(await playSession(practice, fixture, chapterId, true));
    }
    clock.advanceMs(SESSION_WALL_CLOCK_MS);

    await Promise.all(sessionIds.map((id) => practice.submitSession(fixture.actor, id)));

    // Four rows: the seeded one plus one per session, INCLUDING the zero-value
    // ones. "Awarded nothing" and "never submitted" must not look the same.
    const rows = await sql('select count(*)::int as n from xp_ledger where student_user_id = $1', [
      fixture.studentUserId,
    ]);
    expect((rows[0] as { n: number }).n).toBe(4);
  }, 120_000);

  it('leaves a student who is already AT the cap with three zero awards', async () => {
    const fixture = await seed(3);

    await sql(
      `insert into xp_ledger (student_user_id, source, source_id, amount, tenant_id, created_at)
         values ($1, 'practice_session', gen_random_uuid(), $2, $3, $4)`,
      [fixture.studentUserId, XP_RULES.dailyCap, fixture.tenantId, clock.now().toISOString()],
    );

    const barrier = createBarrier(3);
    const { practice } = wire(barrier);

    const sessionIds: string[] = [];
    for (const chapterId of fixture.chapterIds) {
      sessionIds.push(await playSession(practice, fixture, chapterId, true));
    }
    clock.advanceMs(SESSION_WALL_CLOCK_MS);

    const results = await Promise.all(
      sessionIds.map((id) => practice.submitSession(fixture.actor, id)),
    );

    expect(results.map((result) => result.xpAwarded)).toEqual([0, 0, 0]);
    expect(results.every((result) => result.dailyCapReached)).toBe(true);
    expect(await ledgerTotal(fixture.studentUserId)).toBe(XP_RULES.dailyCap);
  }, 120_000);
});
