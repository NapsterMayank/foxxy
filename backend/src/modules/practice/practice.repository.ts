import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { DbExecutor, DbHandle } from '@/platform/db/index';
import { schema, unwrapExecutor, wrapExecutor } from '@/platform/db/index';
import type { TransactionToken } from '@/platform/tx/index';
import type { Difficulty } from '@/shared/constants/curriculum';
import type { XpSource } from '@/shared/constants/practice';
import type {
  HistoryRecord,
  RecordedAnswer,
  RetentionRecord,
  SessionRecord,
} from './practice.types';

/**
 * ALL database access for the practice module — §7, rule 4.
 *
 * Enforced by ESLint: `@/platform/db` and `drizzle-orm` are importable only
 * from a `*.repository.ts` file.
 *
 * ===========================================================================
 * THIS REPOSITORY DOES NOT OPEN THE SUBMISSION TRANSACTION — D-056.
 *
 * Every other module in this codebase exposes an atomic operation as ONE
 * repository method that opens its own transaction, and that is right for them:
 * it keeps every transaction boundary in a single file.
 *
 * It cannot work here. §8.6 requires the responses, the session, the XP ledger
 * row AND `chapter_mastery` to land together, and `chapter_mastery` belongs to
 * `learner`. A transaction opened inside this file could never contain a write
 * that another module performs.
 *
 * So this file exposes `withTransaction`, which hands the service an opaque
 * `TransactionToken`, and every write method takes that token. The SERVICE owns
 * the boundary — it decides what is inside it and it is where the mastery call
 * happens — and no repository opens one. That is D-056's rule stated exactly.
 * ===========================================================================
 */

const {
  practiceSessions,
  practiceResponses,
  practiceRetention,
  xpLedger,
  chapters,
} = schema;

export type PracticeDbHandle = DbHandle;

/** `numeric` arrives as a string from node-postgres. Converted in one place. */
function fromNumeric(value: string): number {
  return Number(value);
}

/**
 * The advisory-lock NAMESPACE for a practice submission — D-242.
 *
 * Postgres advisory locks live in one global space shared by the whole
 * database. The two-argument form splits that space into (classid, objid), so
 * this constant is what stops a lock on a student id here from colliding with
 * some future lock on the same student id somewhere else. An arbitrary value,
 * fixed forever: changing it would let an old connection and a new one hold
 * "the same" lock simultaneously.
 */
const PRACTICE_SUBMISSION_LOCK_CLASS = 8_106;

interface SessionRow {
  id: string;
  studentUserId: string;
  chapterId: string;
  tenantId: string;
  questionIds: string[];
  targetQuestionCount: number;
  optionOrder: unknown;
  answers: unknown;
  startedAt: Date;
  submittedAt: Date | null;
  scorePercent: number | null;
  xpEarned: number | null;
  isValid: boolean | null;
  invalidReason: string | null;
}

/**
 * Maps a session row.
 *
 * The two jsonb columns are cast rather than parsed, and that is a deliberate
 * limit on this layer's job: the SHAPE of `option_order` is checked by
 * `assertShuffleMap` in the domain, at the point where a wrong shape would do
 * damage, and re-validating here would put the same rule in two places with one
 * of them eventually falling behind.
 */
function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    studentUserId: row.studentUserId,
    chapterId: row.chapterId,
    tenantId: row.tenantId,
    questionIds: row.questionIds,
    targetQuestionCount: row.targetQuestionCount,
    optionOrder: (row.optionOrder ?? {}) as Record<string, number[]>,
    answers: (row.answers ?? {}) as Record<string, RecordedAnswer>,
    startedAt: row.startedAt,
    submittedAt: row.submittedAt,
    scorePercent: row.scorePercent,
    xpEarned: row.xpEarned,
    isValid: row.isValid,
    invalidReason: row.invalidReason,
  };
}

export interface CreateSessionInput {
  readonly studentUserId: string;
  readonly tenantId: string;
  readonly chapterId: string;
  readonly questionIds: readonly string[];
  readonly optionOrder: Readonly<Record<string, readonly number[]>>;
  readonly targetQuestionCount: number;
  readonly now: Date;
  /** D-401. `null` when the caller sent no usable `X-Visit-Id`. */
  readonly visitId: string | null;
}

export interface CompleteSessionInput {
  readonly sessionId: string;
  readonly scorePercent: number;
  readonly xpEarned: number;
  readonly isValid: boolean;
  readonly invalidReason: string | null;
  readonly now: Date;
}

export interface ResponseInput {
  readonly sessionId: string;
  readonly studentUserId: string;
  readonly tenantId: string;
  readonly questionId: string;
  /** CANONICAL (D-058). Translated by the service before it ever gets here. */
  readonly selectedIndex: number;
  readonly firstSelectedIndex: number | null;
  readonly isCorrect: boolean;
  readonly timeSpentMs: number;
  readonly hintLevelUsed: number;
  readonly confidence: string | null;
  readonly explanationFormatUsed: string | null;
  readonly authoredDifficulty: Difficulty;
  readonly timeTargetMs: number;
  readonly now: Date;
}

export interface XpLedgerInput {
  readonly studentUserId: string;
  readonly tenantId: string;
  readonly source: XpSource;
  readonly sourceId: string;
  readonly amount: number;
  readonly now: Date;
}

export interface RetentionInput {
  readonly studentUserId: string;
  readonly tenantId: string;
  readonly chapterId: string;
  readonly dueAt: Date;
  readonly intervalDays: number;
  readonly easeFactor: number;
  readonly repetitions: number;
  readonly lastReviewedAt: Date;
  readonly now: Date;
}

export interface PracticeRepository {
  /**
   * Runs `fn` inside one transaction and hands it an opaque token — D-056.
   *
   * The service passes the token to every write below AND to
   * `learner.updateMastery`, which is the reason it is a token rather than an
   * executor: it crosses a module boundary, and a module that is not a
   * repository must not be able to run a statement with it.
   */
  withTransaction<T>(fn: (tx: TransactionToken) => Promise<T>): Promise<T>;

  /**
   * SERIALISES EVERY CONCURRENT SUBMISSION BY ONE STUDENT — D-242.
   *
   * Held until the transaction ends. Two submissions by the SAME student queue;
   * submissions by different students never touch each other, because the key
   * is derived from the student id.
   *
   * See the long note at the implementation for why the daily XP cap cannot be
   * enforced without this.
   */
  lockStudent(tx: TransactionToken, studentUserId: string): Promise<void>;

  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  findSession(sessionId: string): Promise<SessionRecord | null>;
  /** Replaces the in-flight answer accumulator. Refuses a submitted session. */
  saveAnswers(
    sessionId: string,
    answers: Readonly<Record<string, RecordedAnswer>>,
    now: Date,
  ): Promise<boolean>;

  /**
   * Appends one served question and its shuffle to a session in flight (Task 5).
   *
   * `question_ids` grows by one and `option_order` gains exactly the one new
   * key — every earlier question's map is untouched. `where submitted_at is
   * null` is the same guard `saveAnswers` carries, and the same answer.
   *
   * IT IS A COMPARE-AND-SET ON THE ARRAY THE CALLER READ, NOT ON THE ID IT
   * CHOSE — review round 2, Finding 1. `expectedLength` is
   * `session.questionIds.length` as it stood at the read that chose this
   * question, and the UPDATE matches only while `cardinality(question_ids)`
   * still equals it.
   *
   * WHY THE ID ALONE WAS NOT ENOUGH. Two `submitAnswer` calls in flight for
   * the SAME open question both pass the "not yet answered" check (harmless:
   * both write an identical answer) and then both run `chooseQuestion`
   * independently. That ends in a RANDOM draw among the candidates at the
   * rung, so on any chapter with more than one candidate the two callers
   * usually pick DIFFERENT questions — and a guard that tested only "is MY id
   * already there" let both appends through. `question_ids` then held
   * `[q1, Q_a, Q_b]` with only one of them ever reachable by the client, and
   * at submission `questionCount` exceeded `responses.length`: anti-cheat
   * rule 3 scored the whole attempt ZERO and recorded it invalid. The length
   * check refuses the loser whichever question it drew.
   *
   * The `not (question_ids @> array[$questionId])` condition is KEPT beside
   * it: it is the guard against a re-append of an id already served (a retry,
   * a replayed request), which a length check alone would permit whenever the
   * array had not moved.
   *
   * Both conditions are evaluated by Postgres inside the row lock the
   * `UPDATE` already takes, so the second of two genuinely concurrent callers
   * re-checks them against the FIRST caller's committed row rather than
   * against the stale array it itself read.
   *
   * Returns false when the session was submitted, OR another caller has
   * already appended, OR this question was already served, between the read
   * that chose it and this write. The caller (`submitAnswer`) refuses with a
   * `ConflictError` in every case.
   */
  appendServedQuestion(
    sessionId: string,
    questionId: string,
    optionOrder: readonly number[],
    expectedLength: number,
    now: Date,
  ): Promise<boolean>;

  insertResponses(tx: TransactionToken, rows: readonly ResponseInput[]): Promise<void>;
  /**
   * Marks the session complete, ONLY if it is not already.
   *
   * Returns null when no row matched — which is what "somebody submitted this
   * session a moment ago" looks like from inside a concurrent transaction. The
   * `where submitted_at is null` is the second guard on double submission; the
   * first is the service's own check, and the third is
   * `practice_responses_session_question_key`.
   */
  completeSession(tx: TransactionToken, input: CompleteSessionInput): Promise<SessionRecord | null>;
  appendXp(tx: TransactionToken, input: XpLedgerInput): Promise<void>;
  upsertRetention(tx: TransactionToken, input: RetentionInput): Promise<void>;

  findHistory(studentUserId: string, limit: number): Promise<HistoryRecord[]>;
  /**
   * `tx` reads inside the caller's transaction. Supplied by `submitSession`,
   * which must see the schedule as it stands under the student lock rather than
   * as it stood before the transaction opened.
   */
  findRetention(studentUserId: string, tx?: TransactionToken): Promise<RetentionRecord[]>;
  totalXp(studentUserId: string): Promise<number>;
  /**
   * `tx` reads inside the caller's transaction — REQUIRED for the daily cap.
   * See `lockStudent` and D-242.
   */
  xpSince(studentUserId: string, since: Date, tx?: TransactionToken): Promise<number>;
  countCompletedSessions(studentUserId: string): Promise<number>;
  /** How many of the student's most recent answers in a chapter were wrong, in a row. */
  consecutiveWrongInChapter(studentUserId: string, chapterId: string): Promise<number>;
}

export function createPracticeRepository(handle: PracticeDbHandle): PracticeRepository {
  const { db } = handle;

  /** The executor a write should run on: the caller's transaction, always. */
  function executorOf(tx: TransactionToken): DbExecutor {
    const executor = unwrapExecutor(tx);
    if (executor === undefined) {
      // Unreachable through the public interface — the parameter is required —
      // and asserted rather than defaulted to `db`, because defaulting would
      // turn "the transaction was lost" into "it wrote anyway, outside the
      // transaction", which is the exact split-brain §8.6 forbids.
      throw new Error('practice.repository: a write was called without a transaction');
    }
    return executor;
  }

  /** The caller's transaction when there is one, this module's pool otherwise. */
  function readerOf(tx: TransactionToken | undefined): DbExecutor {
    return (tx === undefined ? undefined : unwrapExecutor(tx)) ?? db;
  }

  return {
    withTransaction<T>(fn: (tx: TransactionToken) => Promise<T>): Promise<T> {
      return handle.withTransaction((executor) => fn(wrapExecutor(executor)));
    },

    /**
     * ===========================================================================
     * THE PER-STUDENT SUBMISSION LOCK — D-242, AND WHY A READ ALONE CANNOT FIX
     * THE DAILY XP CAP.
     *
     * The cap is `min(earned, 200 - alreadyEarnedToday)`, and `xp_ledger` is
     * append-only, so `alreadyEarnedToday` is a SUM over rows. Two submissions
     * arriving together both summed the same day, both found the same room, and
     * both wrote — 200 became 400. A double-tap on a flaky connection is enough.
     *
     * MOVING THE SUM INSIDE THE TRANSACTION DOES NOT FIX IT. Under READ
     * COMMITTED — Postgres's default, and this application's — a transaction
     * cannot see another transaction's uncommitted insert no matter when it
     * looks. Both would still sum the same total. The fix has to make the two
     * submissions take turns, and nothing about an append-only table does that
     * on its own: there is no row to lock, because the row that matters has not
     * been inserted yet.
     *
     * SO THE LOCK IS EXPLICIT. `pg_advisory_xact_lock` is held to COMMIT or
     * ROLLBACK — there is no unlock to forget and no path, including a thrown
     * error, that leaks it. Keyed by the student, so two students never wait on
     * each other; the same student's concurrent submissions do, which is
     * precisely the case being made correct.
     *
     * THE CLASSID IS A NAMESPACE, not decoration. `pg_advisory_xact_lock` shares
     * one global 64-bit space across the whole database, so a bare `hashtext` of
     * a user id would collide with any other feature that happened to lock on
     * the same id — a collision that manifests as unrelated requests blocking
     * each other and is essentially undiagnosable. The two-argument form keys
     * the lock by (this use, this student).
     *
     * `statement_timeout` is set on every pool (§4), so a pathological queue
     * fails loudly rather than hanging.
     * ===========================================================================
     */
    async lockStudent(tx: TransactionToken, studentUserId: string): Promise<void> {
      await executorOf(tx).execute(
        sql`select pg_advisory_xact_lock(${PRACTICE_SUBMISSION_LOCK_CLASS}, hashtext(${studentUserId}))`,
      );
    },

    async createSession(input: CreateSessionInput): Promise<SessionRecord> {
      const rows = await db
        .insert(practiceSessions)
        .values({
          studentUserId: input.studentUserId,
          tenantId: input.tenantId,
          chapterId: input.chapterId,
          questionIds: [...input.questionIds],
          optionOrder: input.optionOrder,
          targetQuestionCount: input.targetQuestionCount,
          // D-401. A label on the session, never a key it is found by.
          visitId: input.visitId,
          answers: {},
          // From the INJECTED clock, never `defaultNow()`: the anti-cheat rules
          // and the retention schedule both compare against it, and a mix of
          // application time and database time is a comparison between two
          // clocks that can differ.
          startedAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();

      const row = rows[0];
      if (row === undefined) {
        throw new Error('createSession: no row returned');
      }
      return toSessionRecord(row);
    },

    async findSession(sessionId: string): Promise<SessionRecord | null> {
      const rows = await db
        .select()
        .from(practiceSessions)
        .where(eq(practiceSessions.id, sessionId))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toSessionRecord(row);
    },

    async saveAnswers(
      sessionId: string,
      answers: Readonly<Record<string, RecordedAnswer>>,
      now: Date,
    ): Promise<boolean> {
      // `where submitted_at is null` in the UPDATE itself rather than a
      // read-then-write: two answers arriving either side of a submission would
      // otherwise both pass a check and one would silently modify a completed
      // session's accumulator.
      const rows = await db
        .update(practiceSessions)
        .set({ answers, updatedAt: now })
        .where(
          and(eq(practiceSessions.id, sessionId), sql`${practiceSessions.submittedAt} is null`),
        )
        .returning({ id: practiceSessions.id });
      return rows.length > 0;
    },

    async appendServedQuestion(
      sessionId: string,
      questionId: string,
      optionOrder: readonly number[],
      expectedLength: number,
      now: Date,
    ): Promise<boolean> {
      // The one new key, merged in rather than replacing the column — every
      // earlier question's shuffle map survives untouched.
      const merge = JSON.stringify({ [questionId]: [...optionOrder] });
      const rows = await db
        .update(practiceSessions)
        .set({
          questionIds: sql`array_append(${practiceSessions.questionIds}, ${questionId}::uuid)`,
          optionOrder: sql`${practiceSessions.optionOrder} || ${merge}::jsonb`,
          updatedAt: now,
        })
        .where(
          and(
            eq(practiceSessions.id, sessionId),
            sql`${practiceSessions.submittedAt} is null`,
            // COMPARE-AND-SET ON THE ARRAY THE CALLER READ. Only one of two
            // concurrent callers can find the array at the length it had when
            // they both chose — whichever question each of them drew. Under
            // the row lock the UPDATE already takes, so the loser re-reads the
            // winner's committed row rather than its own stale one.
            sql`cardinality(${practiceSessions.questionIds}) = ${expectedLength}`,
            // NEVER TWICE — a re-append of an id already served, which the
            // length check alone would permit whenever the array had not moved.
            sql`not (${practiceSessions.questionIds} @> array[${questionId}]::uuid[])`,
          ),
        )
        .returning({ id: practiceSessions.id });
      return rows.length > 0;
    },

    async insertResponses(tx: TransactionToken, rows: readonly ResponseInput[]): Promise<void> {
      if (rows.length === 0) {
        return;
      }
      await executorOf(tx)
        .insert(practiceResponses)
        .values(
          rows.map((row) => ({
            sessionId: row.sessionId,
            studentUserId: row.studentUserId,
            tenantId: row.tenantId,
            questionId: row.questionId,
            selectedIndex: row.selectedIndex,
            firstSelectedIndex: row.firstSelectedIndex,
            // Derived here rather than accepted from a caller: a CHECK forces
            // it to agree with the two indices, and a value that can be sent
            // independently is a value that can be made to disagree.
            answerChanged:
              row.firstSelectedIndex === null ? null : row.firstSelectedIndex !== row.selectedIndex,
            isCorrect: row.isCorrect,
            timeSpentMs: row.timeSpentMs,
            hintLevelUsed: row.hintLevelUsed,
            confidence: row.confidence,
            explanationFormatUsed: row.explanationFormatUsed,
            authoredDifficulty: row.authoredDifficulty,
            timeTargetMs: row.timeTargetMs,
            createdAt: row.now,
          })),
        );
    },

    async completeSession(
      tx: TransactionToken,
      input: CompleteSessionInput,
    ): Promise<SessionRecord | null> {
      const rows = await executorOf(tx)
        .update(practiceSessions)
        .set({
          submittedAt: input.now,
          scorePercent: input.scorePercent,
          xpEarned: input.xpEarned,
          isValid: input.isValid,
          invalidReason: input.invalidReason,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(practiceSessions.id, input.sessionId),
            sql`${practiceSessions.submittedAt} is null`,
          ),
        )
        .returning();

      const row = rows[0];
      return row === undefined ? null : toSessionRecord(row);
    },

    async appendXp(tx: TransactionToken, input: XpLedgerInput): Promise<void> {
      await executorOf(tx).insert(xpLedger).values({
        studentUserId: input.studentUserId,
        tenantId: input.tenantId,
        source: input.source,
        sourceId: input.sourceId,
        amount: input.amount,
        createdAt: input.now,
      });
    },

    async upsertRetention(tx: TransactionToken, input: RetentionInput): Promise<void> {
      await executorOf(tx)
        .insert(practiceRetention)
        .values({
          studentUserId: input.studentUserId,
          tenantId: input.tenantId,
          chapterId: input.chapterId,
          dueAt: input.dueAt,
          intervalDays: input.intervalDays,
          easeFactor: input.easeFactor.toFixed(2),
          repetitions: input.repetitions,
          lastReviewedAt: input.lastReviewedAt,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [practiceRetention.studentUserId, practiceRetention.chapterId],
          set: {
            dueAt: input.dueAt,
            intervalDays: input.intervalDays,
            easeFactor: input.easeFactor.toFixed(2),
            repetitions: input.repetitions,
            lastReviewedAt: input.lastReviewedAt,
            updatedAt: input.now,
          },
        });
    },

    async findHistory(studentUserId: string, limit: number): Promise<HistoryRecord[]> {
      const rows = await db
        .select({
          sessionId: practiceSessions.id,
          chapterId: practiceSessions.chapterId,
          chapterTitleEn: chapters.titleEn,
          chapterTitleHi: chapters.titleHi,
          startedAt: practiceSessions.startedAt,
          submittedAt: practiceSessions.submittedAt,
          scorePercent: practiceSessions.scorePercent,
          xpEarned: practiceSessions.xpEarned,
          isValid: practiceSessions.isValid,
          invalidReason: practiceSessions.invalidReason,
        })
        .from(practiceSessions)
        .innerJoin(chapters, eq(chapters.id, practiceSessions.chapterId))
        .where(eq(practiceSessions.studentUserId, studentUserId))
        .orderBy(desc(practiceSessions.startedAt))
        .limit(limit);

      return rows;
    },

    async findRetention(
      studentUserId: string,
      tx?: TransactionToken,
    ): Promise<RetentionRecord[]> {
      const rows = await readerOf(tx)
        .select()
        .from(practiceRetention)
        .where(eq(practiceRetention.studentUserId, studentUserId));

      return rows.map((row) => ({
        chapterId: row.chapterId,
        dueAt: row.dueAt,
        intervalDays: row.intervalDays,
        easeFactor: fromNumeric(row.easeFactor),
        repetitions: row.repetitions,
        lastReviewedAt: row.lastReviewedAt,
      }));
    },

    /**
     * A student's XP: a SUM over the ledger, never a counter column.
     *
     * Plan §4 states the rule and the reason in one line — "counters drift;
     * ledgers do not". `coalesce` because a student with no rows has a total of
     * zero rather than of null.
     */
    async totalXp(studentUserId: string): Promise<number> {
      const rows = await db
        .select({ total: sql<string>`coalesce(sum(${xpLedger.amount}), 0)` })
        .from(xpLedger)
        .where(eq(xpLedger.studentUserId, studentUserId));
      return Number(rows[0]?.total ?? 0);
    },

    /**
     * The XP a student has earned since an instant.
     *
     * READ INSIDE THE SUBMISSION TRANSACTION, under `lockStudent` — D-242. The
     * lock is what makes the answer stable long enough to act on; reading here
     * without it returns a number that another submission may already have
     * invalidated. `getProgress` passes no transaction and does not need one:
     * it displays the total, it does not decide anything from it.
     */
    async xpSince(studentUserId: string, since: Date, tx?: TransactionToken): Promise<number> {
      const rows = await readerOf(tx)
        .select({ total: sql<string>`coalesce(sum(${xpLedger.amount}), 0)` })
        .from(xpLedger)
        .where(and(eq(xpLedger.studentUserId, studentUserId), gte(xpLedger.createdAt, since)));
      return Number(rows[0]?.total ?? 0);
    },

    async countCompletedSessions(studentUserId: string): Promise<number> {
      const rows = await db
        .select({ total: sql<string>`count(*)` })
        .from(practiceSessions)
        .where(
          and(
            eq(practiceSessions.studentUserId, studentUserId),
            sql`${practiceSessions.submittedAt} is not null`,
          ),
        );
      return Number(rows[0]?.total ?? 0);
    },

    /**
     * The current run of wrong answers in one chapter, most recent first.
     *
     * Reads the response log rather than a counter for the same reason the XP
     * total does: a streak column would have to be reset correctly by every
     * write path forever, and the first one that forgets leaves a student
     * permanently flagged for recovery.
     *
     * Bounded by the streak threshold plus a little, because the only question
     * being asked is "is the run at least N long" — reading a whole history to
     * answer it would get slower every month.
     */
    async consecutiveWrongInChapter(studentUserId: string, chapterId: string): Promise<number> {
      const questionIds = db
        .select({ id: schema.questions.id })
        .from(schema.questions)
        .where(eq(schema.questions.chapterId, chapterId));

      const rows = await db
        .select({ isCorrect: practiceResponses.isCorrect })
        .from(practiceResponses)
        .where(
          and(
            eq(practiceResponses.studentUserId, studentUserId),
            inArray(practiceResponses.questionId, questionIds),
          ),
        )
        .orderBy(desc(practiceResponses.createdAt))
        .limit(20);

      let streak = 0;
      for (const row of rows) {
        if (row.isCorrect) break;
        streak += 1;
      }
      return streak;
    },
  };
}
