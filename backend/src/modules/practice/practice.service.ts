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
import { applyDailyCap, calculateXp } from './domain/xp-rules';
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

      const candidates: MissionCandidate[] = [];
      for (const subjectCode of context.subjects) {
        const chapters = await deps.listChapters(actor, {
          grade: context.grade,
          subjectCode,
          limit: 100,
        });

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

      const map = shuffleFor(session, question.id, question.options.length);

      // --- THE TRANSLATION (D-058) -----------------------------------------
      const selectedIndex = toCanonicalIndex(map, input.selectedIndex);
      const firstSelectedIndex =
        input.firstSelectedIndex === undefined
          ? null
          : toCanonicalIndex(map, input.firstSelectedIndex);

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
        answerChanged: firstSelectedIndex !== null && firstSelectedIndex !== selectedIndex,
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
        answeredCount: Object.keys(session.answers).length + (session.answers[question.id] ? 0 : 1),
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
     * ORDER INSIDE THE TRANSACTION IS DELIBERATE. `completeSession` runs FIRST
     * and carries `where submitted_at is null`, so a concurrent duplicate
     * submission is refused before it can insert a single response. The unique
     * constraint on `(session_id, question_id)` is the backstop under that.
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

      const alreadyToday = await repository.xpSince(session.studentUserId, startOfDay(now));
      const capped = applyDailyCap(earned, alreadyToday);

      const retention = await repository.findRetention(session.studentUserId);
      const current = retention.find((row) => row.chapterId === session.chapterId);
      const state: RetentionState =
        current === undefined
          ? INITIAL_RETENTION
          : {
              intervalDays: current.intervalDays,
              easeFactor: current.easeFactor,
              repetitions: current.repetitions,
            };
      const schedule = scheduleNextReview(state, scorePercent, now);

      const mastery = await deps.readMastery(actor, session.studentUserId);
      const previous = mastery.find((row) => row.chapterId === session.chapterId);
      const updatedMastery = nextMastery(previous?.masteryScore ?? null, scorePercent);

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

      await repository.withTransaction(async (tx: TransactionToken) => {
        const completed = await repository.completeSession(tx, {
          sessionId: session.id,
          scorePercent,
          xpEarned: capped.awarded,
          isValid: validity.isValid,
          invalidReason: validity.isValid ? null : validity.reason,
          now,
        });

        if (completed === null) {
          throw new ConflictError('This session has already been submitted.', {
            message: 'Concurrent submission lost the race',
          });
        }

        await repository.insertResponses(tx, responses);

        await repository.appendXp(tx, {
          studentUserId: session.studentUserId,
          tenantId: session.tenantId,
          source: XP_SOURCE,
          sourceId: session.id,
          // ZERO IS A REAL ROW. "This session awarded nothing" and "this session
          // was never submitted" must not look the same in the ledger.
          amount: capped.awarded,
          now,
        });

        // THE CROSS-MODULE WRITE, INSIDE THIS TRANSACTION (D-056). `learner`
        // owns `chapter_mastery`; the executor is handed over as an opaque
        // token it unwraps inside its own repository.
        await deps.writeMastery(actor, {
          studentUserId: session.studentUserId,
          chapterId: session.chapterId,
          masteryScore: updatedMastery,
          attemptIncrement: 1,
          practised: true,
          executor: tx,
        });

        await repository.upsertRetention(tx, {
          studentUserId: session.studentUserId,
          tenantId: session.tenantId,
          chapterId: session.chapterId,
          dueAt: schedule.dueAt,
          intervalDays: schedule.intervalDays,
          easeFactor: schedule.easeFactor,
          repetitions: schedule.repetitions,
          lastReviewedAt: schedule.lastReviewedAt,
          now,
        });
      });

      logger.info(
        {
          scorePercent,
          xpAwarded: capped.awarded,
          isValid: validity.isValid,
          questionCount,
        },
        'practice.session.submitted',
      );

      return {
        sessionId: session.id,
        scorePercent,
        correctCount: validity.isValid ? correctCount : 0,
        questionCount,
        xpAwarded: capped.awarded,
        xpEarned: capped.earned,
        dailyCapReached: capped.capReached,
        isValid: validity.isValid,
        invalidReason: validity.isValid ? null : validity.reason,
        evidence: evidenceLabel(updatedMastery, (previous?.attempts ?? 0) + 1),
        nextReviewAt: schedule.dueAt.toISOString(),
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
        xpEarned: row.xpEarned,
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
     */
    async getProgress(actor: PracticeActor): Promise<{
      chapters: ChapterProgress[];
      totalXp: number;
      xpToday: number;
      sessionsCompleted: number;
    }> {
      const tenantId = await tenantOf(actor.userId);
      authorise(actor, 'read', actor.userId, 'progress', tenantId);

      const [mastery, retention, totalXp, xpToday, sessionsCompleted] = await Promise.all([
        deps.readMastery(actor, actor.userId),
        repository.findRetention(actor.userId),
        repository.totalXp(actor.userId),
        repository.xpSince(actor.userId, startOfDay(clock.now())),
        repository.countCompletedSessions(actor.userId),
      ]);

      const dueByChapter = new Map(retention.map((row) => [row.chapterId, row.dueAt]));

      const chapters: ChapterProgress[] = [];
      for (const row of mastery) {
        const chapter = await deps.readChapter(actor, row.chapterId);
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
