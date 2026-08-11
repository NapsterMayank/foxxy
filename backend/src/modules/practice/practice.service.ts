import { createAccessGuard, type StudentScope } from '@/platform/authz/index';
import type { Clock } from '@/platform/clock/index';
import { ConflictError, NotFoundError } from '@/platform/errors/index';
import type { Logger } from '@/platform/logger/index';
import type { TransactionToken } from '@/platform/tx/index';
import type { XpSource } from '@/shared/constants/practice';
import type {
  AnswerResult,
  ChapterProgress,
  HistoryEntry,
  Mission as MissionView,
  PracticeQuestion,
  PracticeSession as PracticeSessionView,
  StartSessionRequest,
  SubmitAnswerRequest,
  SubmissionResult,
} from '@/shared/contracts/practice.contract';
import { DEFAULT_SESSION_QUESTION_COUNT } from '@/shared/contracts/practice.contract';
import { deriveAnswerChange } from './domain/answer-change';
import { validateAttempt, type AttemptResponse } from './domain/anti-cheat';
import { decideNext } from './domain/decide-next';
import { evidenceLabel } from './domain/evidence';
import { availableHintLevels, type QuestionHints } from './domain/hint-ladder';
import { nextMastery } from './domain/mastery-update';
import { chooseMission, type MissionCandidate } from './domain/mission';
import {
  applyShuffle,
  assertShuffleMap,
  buildShuffle,
  toCanonicalIndex,
  toPresentationIndex,
} from './domain/option-shuffle';
import { calculateScore } from './domain/scoring';
import {
  INITIAL_RETENTION,
  scheduleNextReview,
  type RetentionState,
} from './domain/spaced-retention';
import { applyDailyCap, calculateXp, type CappedXp } from './domain/xp-rules';
import type { PracticeRepository, ResponseInput } from './practice.repository';
import type {
  ChapterListReader,
  ChapterReader,
  MasteryReader,
  MasteryWriter,
  PracticeActor,
  PracticeQuestionRecord,
  QuestionReader,
  RandomSource,
  RecordedAnswer,
  SessionRecord,
  StudentContextReader,
  TenantReader,
} from './practice.types';

/**
 * The practice use-cases — 01-BACKEND-IMPLEMENTATION-PLAN.md §8.6, and six of
 * the client's nine session steps:
 *
 *   Today's Mission -> Concept Explanation -> Guided Practice (hint ladder)
 *   -> Independent Mastery Check -> Evidence-Based Decision -> Retention
 *
 * Prerequisite recall, prerequisite recovery and teacher alerts are out of
 * scope: the first two need a concept graph whose codes do not join to anything
 * yet (D-105) and the third needs a teacher role that does not exist.
 *
 * ===========================================================================
 * THIS LAYER ORCHESTRATES AND CALCULATES NOTHING.
 *
 * Every number below comes from `domain/`: the score, the XP, the cap, the
 * validity verdict, the next decision, the next review date, the new mastery.
 * If you find yourself writing arithmetic in this file, it belongs one
 * directory down where it can be tested in a millisecond.
 * ===========================================================================
 *
 * ===========================================================================
 * FOUR PROPERTIES THIS FILE EXISTS TO KEEP. Each is one edit away from being
 * lost, and none of the four fails loudly when it is.
 *
 * 1. HELD-OUT QUESTIONS ARE NEVER SERVED. This module is given
 *    `readQuestions`, bound to `content.getQuestionsForChapter`, which has no
 *    argument that could include the reserve. It is NOT given
 *    `getHeldOutQuestionsForChapter`. A served question may have been
 *    memorised and can never measure anything again — permanently, for that
 *    student.
 *
 * 2. EVERY PERSISTED INDEX IS THE ORIGINAL ONE (D-058). Options are shuffled
 *    for presentation; `toCanonicalIndex` translates every selection back
 *    before anything is written. Misconceptions are keyed by original index
 *    (D-048), so a shuffled index stored here mislabels every misconception,
 *    and the data stays entirely plausible.
 *
 * 3. SUBMISSION IS ONE TRANSACTION (D-056). Responses, session, XP ledger and
 *    mastery. `learner.updateMastery` is enlisted through the opaque
 *    `TransactionToken` rather than called afterwards. A partial write means a
 *    student's XP disagrees with their history permanently, and no retry
 *    repairs it.
 *
 * 4. THE RESOURCE TENANT IS READ FROM THE DATA (D-073, D-091). Session-scoped
 *    methods take it from the session row; actor-scoped ones read `users`
 *    through the injected reader. Never from `actor.tenantId` — that would
 *    compare a value with itself, which is a check that always passes written
 *    in the shape of one that sometimes fails.
 * ===========================================================================
 *
 * The clock is injected. There is no `new Date()` in this file.
 */

export interface PracticeServiceDeps {
  readonly repository: PracticeRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `content.getQuestionsForChapter`. The reserve is unreachable from here. */
  readonly readQuestions: QuestionReader;
  readonly readChapter: ChapterReader;
  readonly listChapters: ChapterListReader;
  /** `learner` — the student's grade and subjects. */
  readonly readStudentContext: StudentContextReader;
  readonly readMastery: MasteryReader;
  /** `learner.updateMastery`, enlisted in this module's transaction (D-056). */
  readonly writeMastery: MasteryWriter;
  /** `identity` — `users.tenant_id`, the authoritative copy (D-091). */
  readonly readTenantOfStudent: TenantReader;
  /**
   * Injected so the shuffle is deterministic in a test.
   *
   * A domain function may not generate a random number (§2's layer table), and
   * that is what makes "a shuffle that actually reorders still stores the
   * ORIGINAL index" a test that can be written at all.
   */
  readonly random: RandomSource;
}

/** The source string every practice XP row carries. */
const XP_SOURCE: XpSource = 'practice_session';

/**
 * ONE message for a session that cannot be reached, whatever the cause.
 *
 * "No such session" and "somebody else's session" must be indistinguishable, or
 * a 404 becomes a way to enumerate them. The access check runs first and emits
 * a contentless 403 for a session that exists in another tenant; this covers the
 * rest.
 */
const SESSION_NOT_FOUND = 'Session not found.';

/**
 * Thrown to ROLL BACK an attempt whose mastery step was computed from a value
 * another submission has since replaced — D-241.
 *
 * Deliberately module-private and deliberately not an `AppError`: it never
 * reaches a route. It is a control-flow signal between the transaction body and
 * the retry immediately outside it, and the only reason it is an exception at
 * all is that returning would COMMIT the responses, the session and the XP row
 * around a mastery write that did not happen.
 */
class StaleMasteryError extends Error {
  constructor() {
    super('practice: mastery compare-and-set was refused');
    this.name = 'StaleMasteryError';
  }
}

export interface PracticeService {
  getTodaysMission(actor: PracticeActor): Promise<MissionView | null>;
  startSession(actor: PracticeActor, input: StartSessionRequest): Promise<PracticeSessionView>;
  getSession(actor: PracticeActor, sessionId: string): Promise<PracticeSessionView>;
  submitAnswer(
    actor: PracticeActor,
    sessionId: string,
    input: SubmitAnswerRequest,
  ): Promise<AnswerResult>;
  submitSession(actor: PracticeActor, sessionId: string): Promise<SubmissionResult>;
  getHistory(actor: PracticeActor, limit: number): Promise<HistoryEntry[]>;
  getProgress(actor: PracticeActor): Promise<{
    chapters: ChapterProgress[];
    totalXp: number;
    xpToday: number;
    sessionsCompleted: number;
  }>;
}

export function createPracticeService(deps: PracticeServiceDeps): PracticeService {
  const { repository, clock, logger } = deps;

  /**
   * Authorises one operation against one student's practice data.
   *
   * `tenantId` IS A PARAMETER, and every caller resolves it from the data it is
   * about to serve — the session row for session-scoped methods, `users` for
   * actor-scoped ones. There is deliberately no overload that defaults it to
   * `actor.tenantId`: D-091 is the record of what that costs, and the fix there
   * was to make the value impossible to supply from the actor.
   *
   * The guard is built per call with a link reader that reports "no link". No
   * parent-facing practice endpoint exists yet, so a parent is refused by the
   * guard's own rule rather than by this module knowing anything about links.
   * When `parent` (§8.7) needs a child's practice history it will supply a real
   * reader here, and the guard is already in the right place.
   */
  function authorise(
    actor: PracticeActor,
    action: 'read' | 'write',
    studentUserId: string,
    scope: StudentScope,
    tenantId: string,
  ): void {
    const guard = createAccessGuard({ readLinkStatus: () => null });
    guard.assertCanAccess(actor, action, {
      kind: 'student-data',
      studentUserId,
      scope,
      tenantId,
    });
  }

  /** The tenant of an ACTOR's own data, read from `users` and never claimed. */
  async function tenantOf(studentUserId: string): Promise<string> {
    return (await deps.readTenantOfStudent(studentUserId)) ?? '';
  }

  /**
   * Loads a session and authorises against it.
   *
   * THE TENANT COMES OFF THE ROW. That is the strongest available form of
   * "from the data": it is the tenant the session was filed under, not one
   * looked up beside it, so a mismatch is refused before a single question is
   * loaded and with no payload at all.
   *
   * An unknown session is refused as a 404 AFTER the guard has had nothing to
   * check — the two are indistinguishable to a caller because both carry no
   * detail.
   */
  async function loadSession(
    actor: PracticeActor,
    sessionId: string,
    action: 'read' | 'write',
  ): Promise<SessionRecord> {
    const session = await repository.findSession(sessionId);
    if (session === null) {
      throw new NotFoundError(SESSION_NOT_FOUND, {
        message: 'Practice session lookup matched no row',
      });
    }

    authorise(actor, action, session.studentUserId, 'practice', session.tenantId);
    return session;
  }

  /** Hydrates the questions of a session, in the order they were served. */
  async function questionsOf(
    actor: PracticeActor,
    session: SessionRecord,
  ): Promise<PracticeQuestionRecord[]> {
    const chapter = await deps.readChapter(actor, session.chapterId);
    if (chapter === null) {
      throw new NotFoundError(SESSION_NOT_FOUND, {
        message: 'Practice session references a chapter that is no longer active',
      });
    }

    const pool = await deps.readQuestions(actor, {
      chapterId: session.chapterId,
      grade: chapter.grade,
      subjectCode: chapter.subjectCode,
      // The whole chapter, so that every question the session drew is present
      // even if the chapter has since grown.
      limit: 200,
    });

    const byId = new Map(pool.map((question) => [question.id, question]));
    const ordered: PracticeQuestionRecord[] = [];
    for (const id of session.questionIds) {
      const question = byId.get(id);
      if (question !== undefined) {
        ordered.push(question);
      }
    }
    return ordered;
  }

  /** The client-facing shape. Carries no answer — see the contract's header. */
  function toView(
    session: SessionRecord,
    questions: readonly PracticeQuestionRecord[],
  ): PracticeSessionView {
    return {
      id: session.id,
      chapterId: session.chapterId,
      startedAt: session.startedAt.toISOString(),
      submittedAt: session.submittedAt?.toISOString() ?? null,
      questions: questions.map((question) => toQuestionView(question, session)),
      answeredCount: Object.keys(session.answers).length,
    };
  }

  function toQuestionView(
    question: PracticeQuestionRecord,
    session: SessionRecord,
  ): PracticeQuestion {
    const map = shuffleFor(session, question.id, question.options.length);
    return {
      id: question.id,
      questionText: question.questionText,
      // SHUFFLED. The only place the student's option order is produced.
      options: applyShuffle([...question.options], map),
      difficulty: question.difficulty,
      bloomLevel: question.bloomLevel,
      hintLevelsAvailable: availableHintLevels(hintsOf()),
    };
  }

  /**
   * The hint fields a question carries — all of them empty, today.
   *
   * D-077, measured: `hint_level_1..3` and `solution_steps` are NULL on all
   * 3,791 source questions, and the schema `content` exposes has no column for
   * them at all. This function is the seam: it is where the real columns land
   * when the pedagogy generation pass of 05-ROADMAP.md §6 authors them, and
   * until then it returns the honest empty ladder rather than a fabricated one.
   * `availableHintLevels` therefore reports `[]`, and the interface offers no
   * hint buttons instead of five that apologise.
   */
  function hintsOf(): QuestionHints {
    return {
      hintLevel1: null,
      hintLevel2: null,
      hintLevel3: null,
      solutionSteps: null,
      workedExample: null,
      prerequisiteConceptTitle: null,
    };
  }

  /**
   * The shuffle map for one question of one session.
   *
   * Validated on the way out of the jsonb column rather than trusted: a map
   * that is not a permutation would translate two positions to the same
   * original index, and the resulting responses would be individually
   * plausible and collectively wrong.
   */
  function shuffleFor(session: SessionRecord, questionId: string, optionCount: number): number[] {
    const map = session.optionOrder[questionId];
    if (map === undefined) {
      throw new NotFoundError(SESSION_NOT_FOUND, {
        message: 'Practice session carries no shuffle map for one of its questions',
      });
    }
    assertShuffleMap(map, optionCount);
    return [...map];
  }

  /**
   * The SCREEN POSITION a recorded answer was tapped in.
   *
   * The stored index is canonical (D-058) and the map that produced it is on
   * the session, so this is exactly recoverable — and it has to be recovered
   * rather than stored, because storing it would put a presentation index in
   * the database, which is the one thing D-058 forbids.
   *
   * Anti-cheat rule 2 is about VARIETY OF BEHAVIOUR — "did this student tap the
   * same place six times" — and the shuffle map differs per question, so the
   * same place is a different canonical index each time. Read the canonical
   * index there and the rule measures the authored answer key instead of the
   * student.
   *
   * `assertShuffleMap` is applied against the map's own length: the map arrives
   * from a jsonb column, and a non-permutation would make `toPresentationIndex`
   * report a position nobody tapped.
   */
  function presentationIndexOf(session: SessionRecord, answer: RecordedAnswer): number {
    const map = session.optionOrder[answer.questionId];
    if (map === undefined) {
      throw new NotFoundError(SESSION_NOT_FOUND, {
        message: 'Practice session carries no shuffle map for one of its answers',
      });
    }
    assertShuffleMap(map, map.length);
    return toPresentationIndex(map, answer.selectedIndex);
  }

  /** The answers of a session, in the order the questions were served. */
  function orderedAnswers(session: SessionRecord): RecordedAnswer[] {
    const answers: RecordedAnswer[] = [];
    for (const questionId of session.questionIds) {
      const answer = session.answers[questionId];
      if (answer !== undefined) {
        answers.push(answer);
      }
    }
    return answers;
  }

  /**
   * The run of wrong answers behind this one — earlier sessions plus this one.
   *
   * Both halves matter and neither is enough alone. The persisted half misses
   * the session in progress, which is where a student actually gets stuck; the
   * in-session half misses a student who has failed the same chapter three days
   * running. `decideNext` reads the total.
   */
  function inSessionWrongStreak(session: SessionRecord): number {
    const answered = orderedAnswers(session)
      .slice()
      .sort((a, b) => a.answeredAt.localeCompare(b.answeredAt));

    let streak = 0;
    for (let index = answered.length - 1; index >= 0; index -= 1) {
      if (answered[index]?.isCorrect !== false) break;
      streak += 1;
    }
    return streak;
  }

  /** Midnight UTC of the clock's current day — the daily XP cap's window. */
  function startOfDay(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  /**
   * Everything about this submission that is decided BEFORE the transaction and
   * cannot change inside it: the score, the uncapped XP, the verdict, the rows.
   *
   * The cap, the mastery and the schedule are deliberately NOT here. Each of
   * them is a function of state another submission can move, so each is decided
   * inside the transaction, under the lock.
   */
  interface SubmissionWrite {
    readonly now: Date;
    readonly scorePercent: number;
    readonly earned: number;
    readonly isValid: boolean;
    readonly invalidReason: string | null;
    readonly responses: readonly ResponseInput[];
  }

  /** What the transaction actually wrote — the source of every number returned. */
  interface SubmissionOutcome {
    readonly capped: CappedXp;
    readonly masteryScore: number;
    readonly attempts: number;
    readonly nextReviewAt: Date;
  }

  /**
   * How many times a submission may recompute its mastery step and try again.
   *
   * Each retry is caused by ANOTHER submission of the same student committing
   * in between — so under the per-student lock the queue is at most as long as
   * the number of submissions in flight, and three is generous for a human with
   * two tabs. Exhausting it is a 409 the client can retry, never a silent write.
   */
  const MASTERY_ATTEMPTS = 3;

  /**
   * Runs one attempt at the submission transaction.
   *
   * Returns `null` — after rolling back — when the mastery compare-and-set was
   * refused, which means another submission moved this chapter's mastery
   * between this attempt's read and its write.
   */
  async function attemptSubmission(
    actor: PracticeActor,
    session: SessionRecord,
    write: SubmissionWrite,
  ): Promise<SubmissionOutcome | null> {
    /**
     * THE MASTERY READ IS OUTSIDE THE TRANSACTION, AND IT HAS TO BE.
     *
     * `chapter_mastery` belongs to `learner` and is reached through an injected
     * function bound to `learner.service.getMastery`, which runs on learner's
     * own pool — the SAME `core` pool this module's transaction is holding a
     * connection from (§3.1). Issuing that read from inside the transaction
     * would hold two `core` connections per submission, and twenty concurrent
     * submissions would deadlock the pool against itself: every connection
     * held by a transaction waiting for a connection that will never come.
     *
     * So the read stays out here and the WRITE carries the value it was
     * computed from (D-241). `learner` applies the update only if the row still
     * holds that value, which makes the pair atomic without nesting a
     * connection inside a transaction.
     */
    const mastery = await deps.readMastery(actor, session.studentUserId);
    const previous = mastery.find((row) => row.chapterId === session.chapterId);
    const previousScore = previous?.masteryScore ?? null;
    const updatedMastery = nextMastery(previousScore, write.scorePercent);

    let stale = false;

    const outcome = await repository.withTransaction(
      async (tx: TransactionToken): Promise<SubmissionOutcome | null> => {
        /**
         * FIRST STATEMENT IN THE TRANSACTION, BEFORE ANY READ THAT IS ACTED ON
         * — D-242. Everything below decides something from state another
         * submission by this student can move; the lock is what makes those
         * decisions still true when they are written.
         */
        await repository.lockStudent(tx, session.studentUserId);

        /**
         * THE DAY'S XP, READ UNDER THE LOCK. Read before the lock — which is
         * where it used to be, outside the transaction entirely — two
         * submissions both saw the same total, both computed room from it, and
         * both wrote. The 200-a-day cap became 400.
         */
        const alreadyToday = await repository.xpSince(
          session.studentUserId,
          startOfDay(write.now),
          tx,
        );
        const capped = applyDailyCap(write.earned, alreadyToday);

        /**
         * `where submitted_at is null` — the second guard on double submission.
         * It used to be the first, and under the student lock a concurrent
         * duplicate now queues here rather than racing; it stays because the
         * lock protects one student's submissions from each other and this
         * protects the row from anything else. The unique constraint on
         * `(session_id, question_id)` is the backstop under both.
         */
        const completed = await repository.completeSession(tx, {
          sessionId: session.id,
          scorePercent: write.scorePercent,
          xpEarned: capped.awarded,
          isValid: write.isValid,
          invalidReason: write.invalidReason,
          now: write.now,
        });

        if (completed === null) {
          throw new ConflictError('This session has already been submitted.', {
            message: 'Concurrent submission lost the race',
          });
        }

        await repository.insertResponses(tx, write.responses);

        await repository.appendXp(tx, {
          studentUserId: session.studentUserId,
          tenantId: session.tenantId,
          source: XP_SOURCE,
          sourceId: session.id,
          // ZERO IS A REAL ROW. "This session awarded nothing" and "this session
          // was never submitted" must not look the same in the ledger.
          amount: capped.awarded,
          now: write.now,
        });

        // THE CROSS-MODULE WRITE, INSIDE THIS TRANSACTION (D-056). `learner`
        // owns `chapter_mastery`; the executor is handed over as an opaque
        // token it unwraps inside its own repository.
        const written = await deps.writeMastery(actor, {
          studentUserId: session.studentUserId,
          chapterId: session.chapterId,
          masteryScore: updatedMastery,
          // D-241 — the write applies only if the row still holds this.
          expectedPreviousScore: previousScore,
          attemptIncrement: 1,
          practised: true,
          executor: tx,
        });

        if (written === null) {
          // Another submission blended this chapter first. THROW rather than
          // return, because returning would COMMIT everything above it — the
          // responses, the session, the XP row — around a mastery step that
          // never landed. The throw rolls the whole attempt back; the caller
          // re-reads and recomputes.
          stale = true;
          throw new StaleMasteryError();
        }

        // Read under the same lock, for the same reason the XP total is: the
        // SM-2 state is a function of the previous schedule, and two
        // submissions reading the same one produce one review step for two
        // sessions.
        const retention = await repository.findRetention(session.studentUserId, tx);
        const current = retention.find((row) => row.chapterId === session.chapterId);
        const state: RetentionState =
          current === undefined
            ? INITIAL_RETENTION
            : {
                intervalDays: current.intervalDays,
                easeFactor: current.easeFactor,
                repetitions: current.repetitions,
              };
        const schedule = scheduleNextReview(state, write.scorePercent, write.now);

        await repository.upsertRetention(tx, {
          studentUserId: session.studentUserId,
          tenantId: session.tenantId,
          chapterId: session.chapterId,
          dueAt: schedule.dueAt,
          intervalDays: schedule.intervalDays,
          easeFactor: schedule.easeFactor,
          repetitions: schedule.repetitions,
          lastReviewedAt: schedule.lastReviewedAt,
          now: write.now,
        });

        return {
          capped,
          masteryScore: written.masteryScore,
          attempts: written.attempts,
          nextReviewAt: schedule.dueAt,
        };
      },
    ).catch((error: unknown): SubmissionOutcome | null => {
      if (stale && error instanceof StaleMasteryError) {
        return null;
      }
      throw error;
    });

    return outcome;
  }

  /**
   * §8.6 — the submission transaction, retried when its mastery step went stale.
   *
   * The retry re-reads mastery and recomputes the EMA step from the value that
   * is actually stored, so two overlapping submissions produce TWO steps rather
   * than one — which is what makes the mastery agree with the attempt count that
   * SQL was incrementing correctly all along.
   */
  async function submitOnce(
    actor: PracticeActor,
    session: SessionRecord,
    write: SubmissionWrite,
  ): Promise<SubmissionOutcome> {
    for (let attempt = 1; attempt <= MASTERY_ATTEMPTS; attempt += 1) {
      const outcome = await attemptSubmission(actor, session, write);
      if (outcome !== null) {
        return outcome;
      }
      logger.warn(
        { attempt, chapterId: session.chapterId },
        'practice.session.mastery_contended',
      );
    }

    throw new ConflictError('Please try submitting again.', {
      message: `Mastery compare-and-set lost ${String(MASTERY_ATTEMPTS)} times`,
    });
  }

  return {
    /**
     * §8.6 — Today's Mission, step 1, and the client's most important screen.
     *
     * THE REASON IS DERIVED, NEVER WRITTEN. Every candidate below is a real row:
     * a `practice_retention.due_at` in the past, a `chapter_mastery` score under
     * the bar, or a chapter with no mastery row at all. `chooseMission` builds
     * the sentence from that candidate's own title, days overdue or attempt
     * count — in both languages (P7).
     */
    async getTodaysMission(actor: PracticeActor): Promise<MissionView | null> {
      const tenantId = await tenantOf(actor.userId);
      authorise(actor, 'read', actor.userId, 'practice', tenantId);

      const context = await deps.readStudentContext(actor, actor.userId);
      const mastery = await deps.readMastery(actor, actor.userId);
      const retention = await repository.findRetention(actor.userId);

      const masteryByChapter = new Map(mastery.map((row) => [row.chapterId, row]));
      const dueByChapter = new Map(retention.map((row) => [row.chapterId, row.dueAt]));

      /**
       * ONE ROUND TRIP PER SUBJECT, ISSUED TOGETHER — D-284.
       *
       * This was a sequential `await` inside the subject loop: a student with
       * six subjects paid six round trips end to end on the screen §8.6 calls
       * the client's most important. `listChapters` takes ONE subject, so the
       * query count is a `content` API shape and cannot be reduced from here
       * (see D-284 for the follow-up that would); what can be fixed here is that
       * they no longer wait for each other. The count is bounded by the
       * student's subject list, which is small and does not grow with use — the
       * property that made the `getProgress` version of this worth a different
       * fix.
       */
      const chaptersBySubject = await Promise.all(
        context.subjects.map((subjectCode) =>
          deps.listChapters(actor, { grade: context.grade, subjectCode, limit: 100 }),
        ),
      );

      const candidates: MissionCandidate[] = [];
      for (const chapters of chaptersBySubject) {
        for (const chapter of chapters) {
          const row = masteryByChapter.get(chapter.id);
          candidates.push({
            chapterId: chapter.id,
            chapterNumber: chapter.chapterNumber,
            chapterTitleEn: chapter.titleEn,
            chapterTitleHi: chapter.titleHi,
            subjectCode: chapter.subjectCode,
            dueAt: dueByChapter.get(chapter.id) ?? null,
            masteryScore: row?.masteryScore ?? null,
            attempts: row?.attempts ?? 0,
          });
        }
      }

      const mission = chooseMission(candidates, clock.now());
      if (mission === null) {
        return null;
      }

      return { ...mission, suggestedQuestionCount: DEFAULT_SESSION_QUESTION_COUNT };
    },

    /**
     * §8.6 — draws a session's questions and freezes their order.
     *
     * The grade and subject come from the STUDENT'S PROFILE, never from the
     * request, and are passed to `content` as a hard filter. A chapter id from
     * another grade therefore yields no questions rather than another grade's
     * questions — the failure is a 404 instead of a silent mis-serve.
     */
    async startSession(
      actor: PracticeActor,
      input: StartSessionRequest,
    ): Promise<PracticeSessionView> {
      const tenantId = await tenantOf(actor.userId);
      authorise(actor, 'write', actor.userId, 'practice', tenantId);

      const context = await deps.readStudentContext(actor, actor.userId);
      const chapter = await deps.readChapter(actor, input.chapterId);

      if (chapter?.grade !== context.grade) {
        throw new NotFoundError('Chapter not found.', {
          message: 'Practice start referenced a chapter outside the student’s grade',
        });
      }

      const questions = await deps.readQuestions(actor, {
        chapterId: chapter.id,
        grade: context.grade,
        subjectCode: chapter.subjectCode,
        limit: input.questionCount,
      });

      if (questions.length === 0) {
        // A chapter with no practice questions is a content gap, not an error
        // the student caused. It is a 404 because there is nothing to start.
        throw new NotFoundError('No practice questions are available for this chapter.', {
          message: 'Practice start found no eligible questions',
        });
      }

      // THE SHUFFLE, AND THE MAP THAT MAKES IT REVERSIBLE (D-058). Built here,
      // once, and stored with the session: it is the only thing that can
      // translate a student's tap back into an index misconceptions are keyed by.
      const optionOrder: Record<string, number[]> = {};
      for (const question of questions) {
        const fractions = Array.from(
          { length: Math.max(0, question.options.length - 1) },
          () => deps.random(),
        );
        optionOrder[question.id] = [...buildShuffle(question.options.length, fractions)];
      }

      const session = await repository.createSession({
        studentUserId: actor.userId,
        // The tenant the access check just passed on, so "filed under the
        // tenant that was checked" is true by construction rather than by
        // coincidence.
        tenantId,
        chapterId: chapter.id,
        questionIds: questions.map((question) => question.id),
        optionOrder,
        now: clock.now(),
      });

      logger.info(
        { chapterId: chapter.id, questionCount: questions.length },
        'practice.session.started',
      );

      return toView(session, questions);
    },

    async getSession(actor: PracticeActor, sessionId: string): Promise<PracticeSessionView> {
      const session = await loadSession(actor, sessionId, 'read');
      return toView(session, await questionsOf(actor, session));
    },

    /**
     * §8.6 — one answer: steps 3, 4 and 5 of the session.
     *
     * EVERY INDEX THAT ARRIVES HERE IS A PRESENTATION POSITION AND EVERY INDEX
     * THAT LEAVES IS CANONICAL. The two translations below are the only place
     * the vocabularies meet.
     *
     * =========================================================================
     * ONE ANSWER PER QUESTION, AND IT IS FINAL — D-281.
     *
     * The response below discloses the answer key: `isCorrect`, the correct
     * option's screen position and the explanation, immediately. That is the
     * intended pedagogy and it is kept. What is NOT kept is the ability to
     * answer again afterwards.
     *
     * The two together were a way to score 100% on a session answered entirely
     * wrong, and an auditor executed it end to end: six questions answered
     * wrong, each response read for the revealed position, all six re-answered
     * with it. `saveAnswers` replaced each previous answer wholesale, so the
     * discarded selections left no trace; the resulting rows recorded six
     * correct first-time answers with `first_selected_index` null. Anti-cheat
     * saw six responses to six questions across ample elapsed time with four
     * distinct screen positions and passed, correctly — every one of its three
     * rules was satisfied. Twelve taps, a flawless-looking attempt, and mastery,
     * the parent digest and the retention schedule all read those rows.
     *
     * WITHHOLDING THE KEY UNTIL SUBMISSION WAS THE OTHER OPTION AND IT WAS
     * REJECTED, for a product reason and a technical one. The product reason:
     * feedback at the end of a six-question set is a different activity from
     * guided practice — the hint ladder, the misconception explainer and
     * `decideNext`'s confirm/remediate branches all exist to act on the answer
     * the student just gave. The technical one: withholding
     * `correctPresentationIndex` alone would not have closed the hole. With four
     * options and a mutable answer, `isCorrect` on its own is a three-guess
     * search, and `isCorrect` cannot be withheld without withholding the whole
     * of step 5.
     *
     * So the reveal stays and the record closes with it. A second answer to the
     * same question is a 409.
     * =========================================================================
     */
    async submitAnswer(
      actor: PracticeActor,
      sessionId: string,
      input: SubmitAnswerRequest,
    ): Promise<AnswerResult> {
      const session = await loadSession(actor, sessionId, 'write');

      if (session.submittedAt !== null) {
        throw new ConflictError('This session has already been submitted.', {
          message: 'Answer arrived for a submitted session',
        });
      }

      if (!session.questionIds.includes(input.questionId)) {
        throw new NotFoundError('That question is not part of this session.', {
          message: 'Answer referenced a question outside the session',
        });
      }

      const questions = await questionsOf(actor, session);
      const question = questions.find((candidate) => candidate.id === input.questionId);
      if (question === undefined) {
        throw new NotFoundError('That question is not part of this session.', {
          message: 'Session question could not be hydrated',
        });
      }

      /**
       * THE IMMUTABILITY RULE — D-281, and the first of this fix's two halves.
       *
       * Checked BEFORE the answer key is looked up, so a refused re-answer
       * discloses nothing at all: same status, same body, whatever the student
       * picked. Read from `session.answers`, which is the accumulator the
       * previous answer wrote, so the check is against what the SERVER recorded
       * rather than anything the request claims.
       */
      const prior = session.answers[input.questionId];
      if (prior !== undefined) {
        throw new ConflictError('That question has already been answered.', {
          message: 'Re-answer refused: the answer key was disclosed when the first answer landed',
        });
      }

      const map = shuffleFor(session, question.id, question.options.length);

      // --- THE TRANSLATION (D-058) -----------------------------------------
      const selectedIndex = toCanonicalIndex(map, input.selectedIndex);

      /**
       * THE SECOND HALF — D-282. Derived from the session's own record, never
       * from the request, which no longer carries the field at all.
       *
       * `prior` is always `undefined` while the rule above stands, so this
       * writes "the first choice was this one" — a real observation, and never
       * null. The carry-forward branch inside `deriveAnswerChange` is what makes
       * the exploit still recorded rather than erased if immutability is ever
       * relaxed: the original index survives and `answer_changed` becomes true.
       */
      const change = deriveAnswerChange(prior, selectedIndex);
      const firstSelectedIndex = change.firstSelectedIndex;

      const isCorrect = selectedIndex === question.correctIndex;

      // Keyed by the CANONICAL index (D-048). Looking it up by the presentation
      // index would return a real code for the wrong distractor, and nothing
      // downstream could tell.
      const misconceptionCode = isCorrect
        ? null
        : (question.distractorMisconceptions?.[String(selectedIndex)] ?? null);

      const persistedStreak = await repository.consecutiveWrongInChapter(
        session.studentUserId,
        session.chapterId,
      );

      const decision = decideNext({
        isCorrect,
        confidence: input.confidence ?? null,
        answerChanged: change.answerChanged,
        misconceptionCode,
        consecutiveWrongInChapter:
          persistedStreak + inSessionWrongStreak(session) + (isCorrect ? 0 : 1),
      });

      const answer: RecordedAnswer = {
        questionId: question.id,
        selectedIndex,
        firstSelectedIndex,
        isCorrect,
        timeSpentMs: input.timeSpentMs,
        hintLevelUsed: input.hintLevelUsed,
        confidence: input.confidence ?? null,
        explanationFormatUsed: input.explanationFormatUsed ?? null,
        // FROZEN AT ANSWER TIME. A later difficulty correction must not
        // retroactively claim the student faced a harder question — that is
        // exactly what the denormalised column exists to prevent.
        authoredDifficulty: question.difficulty,
        answeredAt: clock.now().toISOString(),
      };

      // AN ADDITION, NEVER A REPLACEMENT — the guard above is what makes that
      // true. It used to be a replacement, and the discarded selection was the
      // evidence that vanished (D-281).
      const saved = await repository.saveAnswers(
        session.id,
        { ...session.answers, [question.id]: answer },
        clock.now(),
      );

      if (!saved) {
        // The session was submitted between the read above and this write.
        throw new ConflictError('This session has already been submitted.', {
          message: 'Answer lost a race with submission',
        });
      }

      return {
        questionId: question.id,
        isCorrect,
        // Back into presentation space, because the overlay highlights the
        // option in the position the student saw it.
        correctPresentationIndex: toPresentationIndex(map, question.correctIndex),
        explanation: question.explanation,
        decision: decision.decision,
        misconceptionCode: decision.misconceptionCode,
        // Always one more than before: a question already answered never
        // reaches here (D-281).
        answeredCount: Object.keys(session.answers).length + 1,
        questionCount: session.questionIds.length,
      };
    },

    /**
     * §8.6 — SUBMISSION, AND IT IS ONE TRANSACTION (D-056).
     *
     * Responses, the session with its score, the XP ledger entry and mastery.
     * All of it lands or none of it does. A partial write means a student's XP
     * disagrees with their history permanently — there is no retry that
     * reconciles it, because both halves individually look correct.
     *
     * ORDER INSIDE THE TRANSACTION IS DELIBERATE, and it changed — D-241,
     * D-242. `lockStudent` runs first and every value that is DECIDED from
     * mutable state is read after it: the day's XP total, the retention
     * schedule. They used to be read before the transaction opened, where two
     * overlapping submissions read the same numbers, computed from them
     * independently, and both wrote — a daily cap that could be exceeded and a
     * mastery that recorded one step for two attempts.
     *
     * `completeSession` still carries `where submitted_at is null` and the
     * unique constraint on `(session_id, question_id)` is still the backstop
     * under it. Neither was removed; they are simply no longer the only thing
     * standing between two concurrent submissions and a wrong number.
     *
     * The one read that stays outside is mastery, because it crosses a module
     * and therefore a second connection from the same pool — see the note in
     * `attemptSubmission`. It carries its own compare-and-set instead.
     */
    async submitSession(actor: PracticeActor, sessionId: string): Promise<SubmissionResult> {
      const session = await loadSession(actor, sessionId, 'write');

      if (session.submittedAt !== null) {
        throw new ConflictError('This session has already been submitted.', {
          message: 'Duplicate submission refused',
        });
      }

      const answers = orderedAnswers(session);
      const questionCount = session.questionIds.length;

      const now = clock.now();

      /**
       * THE SERVER'S OWN WINDOW, and the reason `timeSpentMs` cannot be trusted
       * alone. Both instants come from the injected clock: `started_at` was
       * written by `createSession`, and `now` is this submission. Six questions
       * claiming twelve seconds each inside a two-second session used to pass.
       *
       * Clamped at zero rather than allowed negative: a clock that went
       * backwards is an operational fault, not a cheat, and it must not turn
       * into a rejection with a student's name on it.
       */
      const realElapsedMs = Math.max(0, now.getTime() - session.startedAt.getTime());

      const attempt: AttemptResponse[] = answers.map((answer) => ({
        // CANONICAL — persisted, and what `practice_responses` will carry.
        selectedIndex: answer.selectedIndex,
        // PRESENTATION — validation only, never written. Rule 2 reads this.
        presentationIndex: presentationIndexOf(session, answer),
        timeSpentMs: answer.timeSpentMs,
      }));
      const validity = validateAttempt(attempt, questionCount, realElapsedMs);

      const correctCount = answers.filter((answer) => answer.isCorrect).length;

      // AN INVALID ATTEMPT SCORES ZERO AND RECORDS ITS REASON. It is not
      // deleted and not refused: the responses are the evidence, and the reason
      // is what makes a support conversation possible.
      const scorePercent = validity.isValid ? calculateScore(correctCount, questionCount) : 0;
      const earned = validity.isValid ? calculateXp(correctCount, scorePercent) : 0;

      const responses: ResponseInput[] = answers.map((answer) => ({
        sessionId: session.id,
        studentUserId: session.studentUserId,
        tenantId: session.tenantId,
        questionId: answer.questionId,
        selectedIndex: answer.selectedIndex,
        firstSelectedIndex: answer.firstSelectedIndex,
        isCorrect: answer.isCorrect,
        timeSpentMs: answer.timeSpentMs,
        hintLevelUsed: answer.hintLevelUsed,
        confidence: answer.confidence,
        explanationFormatUsed: answer.explanationFormatUsed,
        authoredDifficulty: answer.authoredDifficulty,
        now,
      }));

      const outcome = await submitOnce(actor, session, {
        now,
        scorePercent,
        earned,
        isValid: validity.isValid,
        invalidReason: validity.isValid ? null : validity.reason,
        responses,
      });

      logger.info(
        {
          scorePercent,
          xpAwarded: outcome.capped.awarded,
          isValid: validity.isValid,
          questionCount,
          masteryAttempts: outcome.attempts,
        },
        'practice.session.submitted',
      );

      return {
        sessionId: session.id,
        scorePercent,
        correctCount: validity.isValid ? correctCount : 0,
        questionCount,
        xpAwarded: outcome.capped.awarded,
        xpEarned: outcome.capped.earned,
        dailyCapReached: outcome.capped.capReached,
        isValid: validity.isValid,
        invalidReason: validity.isValid ? null : validity.reason,
        // FROM THE ROW THAT WAS WRITTEN, never from what this module intended
        // to write. The two used to be computed separately and could disagree.
        evidence: evidenceLabel(outcome.masteryScore, outcome.attempts),
        nextReviewAt: outcome.nextReviewAt.toISOString(),
      };
    },

    async getHistory(actor: PracticeActor, limit: number): Promise<HistoryEntry[]> {
      const tenantId = await tenantOf(actor.userId);
      authorise(actor, 'read', actor.userId, 'practice', tenantId);

      const rows = await repository.findHistory(actor.userId, limit);
      return rows.map((row) => ({
        sessionId: row.sessionId,
        chapterId: row.chapterId,
        chapterTitleEn: row.chapterTitleEn,
        chapterTitleHi: row.chapterTitleHi,
        startedAt: row.startedAt.toISOString(),
        submittedAt: row.submittedAt?.toISOString() ?? null,
        scorePercent: row.scorePercent,
        // `practice_sessions.xp_earned` STORES THE POST-CAP AMOUNT — it is what
        // `completeSession` was handed as `capped.awarded`. So the wire field is
        // `xpAwarded` (D-283); calling it `xpEarned` here made one name mean the
        // uncapped figure on submit and the awarded one on history.
        xpAwarded: row.xpEarned,
        isValid: row.isValid,
        invalidReason: row.invalidReason,
      }));
    },

    /**
     * §8.6 — progress.
     *
     * `totalXp` is a SUM over the ledger. There is no counter column anywhere in
     * this system for it to disagree with, which is the property that makes
     * "the total equals the sum of the ledger" a test worth writing.
     *
     * Per chapter the answer is an EVIDENCE LABEL and never a percentage — see
     * `domain/evidence.ts`.
     *
     * =========================================================================
     * THE CHAPTER TITLES ARE FETCHED IN BULK — D-284.
     *
     * This used to be `await deps.readChapter(...)` inside the mastery loop: ONE
     * QUERY PER CHAPTER THE STUDENT HAS EVER PRACTISED, sequentially, on the
     * progress screen. It got slower every week a student used the product, and
     * the shape hid that — nothing in the loop looks like a query.
     *
     * The mission's version of the same pattern is bounded by the subject list
     * and is fixed by issuing the calls together; this one is bounded by usage
     * and is not, so it is fixed by asking a different question. The student's
     * own grade and subjects give the whole candidate set in one `listChapters`
     * per subject — the same bounded cost the mission already pays — and the
     * mastery rows are titled from that map.
     *
     * `readChapter` REMAINS AS A FALLBACK, and it is not defensive padding: a
     * chapter practised before the student was promoted is not in this grade's
     * list, and dropping its title would silently blank rows on a history
     * screen. The fallback fires for those rows only, so the common case is
     * bounded and the uncommon one is still correct.
     * =========================================================================
     */
    async getProgress(actor: PracticeActor): Promise<{
      chapters: ChapterProgress[];
      totalXp: number;
      xpToday: number;
      sessionsCompleted: number;
    }> {
      const tenantId = await tenantOf(actor.userId);
      authorise(actor, 'read', actor.userId, 'progress', tenantId);

      const [mastery, retention, totalXp, xpToday, sessionsCompleted, context] = await Promise.all([
        deps.readMastery(actor, actor.userId),
        repository.findRetention(actor.userId),
        repository.totalXp(actor.userId),
        repository.xpSince(actor.userId, startOfDay(clock.now())),
        repository.countCompletedSessions(actor.userId),
        deps.readStudentContext(actor, actor.userId),
      ]);

      const dueByChapter = new Map(retention.map((row) => [row.chapterId, row.dueAt]));

      const chaptersBySubject = await Promise.all(
        context.subjects.map((subjectCode) =>
          deps.listChapters(actor, { grade: context.grade, subjectCode, limit: 100 }),
        ),
      );

      const titleByChapter = new Map(
        chaptersBySubject.flat().map((chapter) => [chapter.id, chapter]),
      );

      const chapters: ChapterProgress[] = [];
      for (const row of mastery) {
        // One lookup, and a query only for a chapter outside this grade.
        const chapter =
          titleByChapter.get(row.chapterId) ?? (await deps.readChapter(actor, row.chapterId));
        chapters.push({
          chapterId: row.chapterId,
          chapterTitleEn: chapter?.titleEn ?? '',
          chapterTitleHi: chapter?.titleHi ?? null,
          evidence: evidenceLabel(row.masteryScore, row.attempts),
          attempts: row.attempts,
          lastPractisedAt: row.lastPractisedAt?.toISOString() ?? null,
          nextReviewAt: dueByChapter.get(row.chapterId)?.toISOString() ?? null,
        });
      }

      return { chapters, totalXp, xpToday, sessionsCompleted };
    },
  };
}
