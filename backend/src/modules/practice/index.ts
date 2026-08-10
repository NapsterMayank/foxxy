import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { Clock } from '@/platform/clock/index';
import type { Logger } from '@/platform/logger/index';
import { createPracticeRepository, type PracticeDbHandle } from './practice.repository';
import { registerPracticeRoutes } from './practice.routes';
import { createPracticeService, type PracticeService } from './practice.service';
import type {
  ChapterListReader,
  ChapterReader,
  MasteryReader,
  MasteryWriter,
  QuestionReader,
  RandomSource,
  StudentContextReader,
  TenantReader,
} from './practice.types';

/**
 * ============================================================================
 * practice — THE PUBLIC SURFACE.
 *
 * This is the only file another module may import (00-ARCHITECTURE.md,
 * Foundation 1, enforced by ESLint `no-restricted-imports`). Everything else in
 * this directory is private.
 *
 * Owns: practice sessions, scoring, XP, the response log, the retention
 * schedule and Today's Mission (plan §8.6). Calls no other module — the four
 * things it needs from `content`, `learner` and `identity` all arrive as
 * injected functions, so every cross-module edge lives in `app/routes.ts` and
 * nowhere else.
 * ============================================================================
 *
 * THE FOUR THINGS ABOUT THIS MODULE MOST LIKELY TO BE UNDONE BY ACCIDENT.
 *
 * 1. `readQuestions` IS BOUND TO `content.getQuestionsForChapter`, WHICH CANNOT
 *    RETURN A HELD-OUT QUESTION. There is no flag, no parameter and no second
 *    function on this module's dependencies that could reach the reserve. Do
 *    not add `readHeldOutQuestions` here "for the mastery check" without
 *    reading `content.service.ts`'s header first: a held-out question served in
 *    ordinary practice may have been memorised and can never measure anything
 *    again, for that student, permanently. There is no un-serving it.
 *
 * 2. EVERY INDEX THIS MODULE PERSISTS IS THE ORIGINAL ONE (D-058). Options are
 *    shuffled per session for presentation and the map is stored on the session;
 *    the service translates every selection back before writing. Store the
 *    shuffled index instead and every misconception lookup returns the code for
 *    a different distractor — silently, plausibly, and unrecoverably, because
 *    the map that would have translated it is what you stopped using.
 *
 * 3. SUBMISSION IS ONE TRANSACTION AND IT INCLUDES ANOTHER MODULE'S TABLE
 *    (D-056). The service opens it; `learner.updateMastery` is enlisted through
 *    an opaque `TransactionToken`. Moving the mastery write to after the
 *    transaction would compile, pass most tests, and leave a student's XP
 *    permanently disagreeing with their mastery on the first failed write.
 *
 * 4. THE EVIDENCE COLUMNS ARE WRITTEN ON EVERY RESPONSE — `first_selected_index`,
 *    `answer_changed`, `hint_level_used`, `confidence`, `time_spent_ms`,
 *    `authored_difficulty` (05-ROADMAP.md §8, D-065). They cannot be backfilled.
 *    A student who practised in September and changed four answers with two
 *    hints leaves no trace of either unless these were written in September.
 */

export interface PracticeModuleDeps {
  /** §3.1: practice is ordinary request traffic and gets the `core` pool. */
  readonly db: PracticeDbHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Identity's session validator, passed in rather than imported. */
  readonly requireSession: preHandlerAsyncHookHandler;

  /**
   * PRACTICE questions only. See note 1 above before changing this binding.
   */
  readonly readQuestions: QuestionReader;
  readonly readChapter: ChapterReader;
  readonly listChapters: ChapterListReader;
  readonly readStudentContext: StudentContextReader;
  readonly readMastery: MasteryReader;
  /** Enlisted in this module's submission transaction — D-056. */
  readonly writeMastery: MasteryWriter;
  /** `users.tenant_id`, read from the DATA and never off the actor (D-091). */
  readonly readTenantOfStudent: TenantReader;
  /**
   * The randomness behind the option shuffle.
   *
   * Injected rather than `Math.random()` in the service, for the same reason
   * the clock is: it is the only way to write a test that proves a shuffle
   * which ACTUALLY REORDERS still stores the canonical index. Defaults to
   * `Math.random` when the composition root does not care.
   */
  readonly random?: RandomSource;
}

export interface PracticeModule {
  readonly service: PracticeService;
  /** Registers the seven `/practice/…` endpoints under `/api/v1`. */
  registerRoutes(app: FastifyInstance): void;
}

export function createPracticeModule(deps: PracticeModuleDeps): PracticeModule {
  const service = createPracticeService({
    repository: createPracticeRepository(deps.db),
    clock: deps.clock,
    logger: deps.logger,
    readQuestions: deps.readQuestions,
    readChapter: deps.readChapter,
    listChapters: deps.listChapters,
    readStudentContext: deps.readStudentContext,
    readMastery: deps.readMastery,
    writeMastery: deps.writeMastery,
    readTenantOfStudent: deps.readTenantOfStudent,
    random: deps.random ?? ((): number => Math.random()),
  });

  return {
    service,
    registerRoutes(app: FastifyInstance): void {
      registerPracticeRoutes(app, { service, requireSession: deps.requireSession });
    },
  };
}

/**
 * ---------------------------------------------------------------------------
 * The use-cases, as named in §8.6 plus the three the client's session steps
 * require. Each is reached through `module.service`, and each calls
 * `assertCanAccess` before it touches anything.
 *
 *   getTodaysMission  Step 1. One chapter, and WHY — derived from a due review,
 *                     a weak chapter or the next unstarted chapter, in both
 *                     languages. Never a generic message.
 *   startSession      Draws the questions, shuffles the options, freezes both.
 *   getSession        The session as the student sees it. No answers.
 *   submitAnswer      Steps 3-5: records the answer canonically, captures the
 *                     evidence, and returns the branch (`decideNext`).
 *   submitSession     Scores, awards XP, updates mastery and schedules the next
 *                     review — ALL IN ONE TRANSACTION.
 *   getHistory        The student's own sessions, newest first.
 *   getProgress       Evidence labels per chapter, plus the XP ledger SUM.
 * ---------------------------------------------------------------------------
 */
export type { PracticeService } from './practice.service';

/** The injected-dependency shapes `app/routes.ts` has to satisfy. */
export type {
  ChapterListReader,
  ChapterReader,
  ChapterSummary,
  MasteryReader,
  MasterySnapshot,
  MasteryWriter,
  PracticeQuestionRecord,
  QuestionReader,
  RandomSource,
  StudentContext,
  StudentContextReader,
  TenantReader,
} from './practice.types';
