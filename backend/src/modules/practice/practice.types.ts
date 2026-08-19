import type { Actor } from '@/platform/authz/index';
import type { TransactionToken } from '@/platform/tx/index';
import type { BloomLevel, Difficulty, Grade } from '@/shared/constants/curriculum';
import type { ResponseConfidence } from '@/shared/constants/practice';

/**
 * Internal types for the practice module, plus the SHAPES OF ITS INJECTED
 * DEPENDENCIES.
 *
 * ===========================================================================
 * PRACTICE IS THE MOST CONNECTED MODULE IN THE BACKEND, AND IT IMPORTS NONE OF
 * THEM.
 *
 * A session needs questions (`content`), the student's grade and subjects
 * (`learner`), their mastery (`learner`), a mastery write inside its own
 * transaction (`learner`, D-056), and the tenant of the student it is serving
 * (`identity`). That is four edges to three modules — more than any other
 * module has.
 *
 * Every one of them is a FUNCTION TYPE declared here and supplied in
 * `app/routes.ts`, never an import. The rule (00-ARCHITECTURE.md Foundation 1,
 * D-051) earns its keep exactly here: with imports, `practice` would pull three
 * modules' internals into its own test setup and the dependency graph would be
 * something you reconstruct by grepping. Injected, `app/routes.ts` remains the
 * complete and greppable list of who depends on whom.
 * ===========================================================================
 */

export type PracticeActor = Actor;

/** A question as `content` hands it over. Carries the answer; never leaves the server. */
export interface PracticeQuestionRecord {
  readonly id: string;
  readonly chapterId: string;
  readonly questionText: string;
  readonly options: readonly string[];
  readonly correctIndex: number;
  readonly explanation: string;
  readonly difficulty: Difficulty;
  readonly bloomLevel: BloomLevel;
  readonly distractorMisconceptions: Readonly<Record<string, string>> | null;
}

export interface ChapterSummary {
  readonly id: string;
  readonly grade: Grade;
  readonly subjectCode: string;
  readonly chapterNumber: number;
  readonly titleEn: string;
  readonly titleHi: string | null;
}

export interface StudentContext {
  readonly grade: Grade;
  readonly subjects: readonly string[];
}

export interface MasterySnapshot {
  readonly chapterId: string;
  readonly masteryScore: number;
  readonly attempts: number;
  readonly lastPractisedAt: Date | null;
}

/**
 * PRACTICE questions for one chapter.
 *
 * Bound in `app/routes.ts` to `content.getQuestionsForChapter`, which has no
 * argument that could include a held-out question — the reserve is reached only
 * through the separately named `getHeldOutQuestionsForChapter`, and this module
 * is not given that function at all.
 *
 * THAT IS THE PROTECTION, AND IT IS STRUCTURAL RATHER THAN CAREFUL. `practice`
 * cannot serve a held-out question by mistake because it has no way to ask for
 * one: no flag, no parameter, no function. A question served in practice may
 * have been memorised and can never measure anything again — for that student,
 * permanently — so "we remembered not to" was never going to be good enough.
 */
export type QuestionReader = (
  actor: PracticeActor,
  query: {
    readonly chapterId: string;
    readonly grade: Grade;
    readonly subjectCode: string;
    readonly limit: number;
  },
) => Promise<readonly PracticeQuestionRecord[]>;

export type ChapterReader = (
  actor: PracticeActor,
  chapterId: string,
) => Promise<ChapterSummary | null>;

/** Every active chapter for a grade and subject — the mission's candidate set. */
export type ChapterListReader = (
  actor: PracticeActor,
  filter: { readonly grade: Grade; readonly subjectCode: string; readonly limit: number },
) => Promise<readonly ChapterSummary[]>;

/** The student's grade and subjects, from `learner`. */
export type StudentContextReader = (
  actor: PracticeActor,
  studentUserId: string,
) => Promise<StudentContext>;

export type MasteryReader = (
  actor: PracticeActor,
  studentUserId: string,
) => Promise<readonly MasterySnapshot[]>;

/**
 * The mastery WRITE, enlisted in this module's transaction — D-056.
 *
 * The `executor` is the opaque `TransactionToken`: this module holds an open
 * transaction and hands it to `learner`, which unwraps it inside its own
 * repository. Nothing here can run a statement with it.
 */
export type MasteryWriter = (
  actor: PracticeActor,
  input: {
    readonly studentUserId: string;
    readonly chapterId: string;
    readonly masteryScore: number;
    /**
     * The mastery `masteryScore` was blended FROM — D-241.
     *
     * `learner` applies the write only if the row still holds this value, which
     * is what makes a read taken here and a write executed there atomic with
     * respect to each other. `null` means "no row was found".
     */
    readonly expectedPreviousScore: number | null;
    readonly attemptIncrement?: number;
    readonly practised?: boolean;
    readonly executor?: TransactionToken;
  },
  /**
   * The row AS WRITTEN, or `null` when the compare-and-set was refused because
   * another submission moved the mastery in between.
   *
   * Returning the row rather than `unknown` is not a convenience: the evidence
   * label shown to the student is computed from the mastery and the attempt
   * count, and computing it from what this module *intended* to write is how
   * the label comes to disagree with the row it describes.
   */
) => Promise<MasterySnapshot | null>;

/**
 * The tenant a student's account belongs to — D-073, D-091.
 *
 * Read from `users` through `identity`, never copied off the actor. D-091 is
 * the record of what copying it costs: `assertTenantMatch` then compares a
 * value with itself, which is a check that always passes written in the shape
 * of one that sometimes fails.
 */
export type TenantReader = (studentUserId: string) => Promise<string | null>;

/** The randomness the shuffle needs, injected so a test can make it deterministic. */
export type RandomSource = () => number;

/** One in-flight answer, as accumulated on `practice_sessions.answers`. */
export interface RecordedAnswer {
  readonly questionId: string;
  /** CANONICAL (D-058). Already translated out of the presentation order. */
  readonly selectedIndex: number;
  /**
   * CANONICAL. DERIVED BY THE SERVER from the session's own record — D-282,
   * `domain/answer-change.ts` — never accepted from the request, which no longer
   * carries the field.
   *
   * Still nullable in the TYPE and never null in a value written since D-282:
   * this shape is read back out of a jsonb column, so a session that was already
   * in flight when that landed can hold a row whose first choice was never
   * recorded. `deriveAnswerChange` treats that as "seed from the prior
   * selection" rather than pretending it is known.
   */
  readonly firstSelectedIndex: number | null;
  readonly isCorrect: boolean;
  readonly timeSpentMs: number;
  readonly hintLevelUsed: number;
  readonly confidence: ResponseConfidence | null;
  readonly explanationFormatUsed: string | null;
  /** Frozen at answer time so a later correction cannot rewrite history. */
  readonly authoredDifficulty: Difficulty;
  /** The pace target in force when this question was served (Task 1). */
  readonly timeTargetMs: number;
  /** ISO 8601, so the jsonb column round-trips without a Date reviver. */
  readonly answeredAt: string;
}

/** A session row, as this module works with it. */
export interface SessionRecord {
  readonly id: string;
  readonly studentUserId: string;
  readonly chapterId: string;
  readonly tenantId: string;
  readonly questionIds: readonly string[];
  /**
   * How many questions this session is MEANT to have (Task 5).
   *
   * `questionIds` grows one at a time as `submitAnswer` serves the next
   * question, so its length is PROGRESS, not the target. This is the target —
   * `AnswerResult.questionCount` reports it, and `submitAnswer` compares
   * `questionIds.length` against it to decide whether the session is done.
   */
  readonly targetQuestionCount: number;
  /** `{ [questionId]: presentationIndex -> canonicalIndex }`. */
  readonly optionOrder: Readonly<Record<string, readonly number[]>>;
  readonly answers: Readonly<Record<string, RecordedAnswer>>;
  readonly startedAt: Date;
  readonly submittedAt: Date | null;
  readonly scorePercent: number | null;
  readonly xpEarned: number | null;
  readonly isValid: boolean | null;
  readonly invalidReason: string | null;
}

export interface HistoryRecord {
  readonly sessionId: string;
  readonly chapterId: string;
  readonly chapterTitleEn: string;
  readonly chapterTitleHi: string | null;
  readonly startedAt: Date;
  readonly submittedAt: Date | null;
  readonly scorePercent: number | null;
  readonly xpEarned: number | null;
  readonly isValid: boolean | null;
  readonly invalidReason: string | null;
}

export interface RetentionRecord {
  readonly chapterId: string;
  readonly dueAt: Date;
  readonly intervalDays: number;
  readonly easeFactor: number;
  readonly repetitions: number;
  readonly lastReviewedAt: Date;
}
