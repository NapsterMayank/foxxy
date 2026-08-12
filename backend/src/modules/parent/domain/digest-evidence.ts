import type { BilingualText } from '@/platform/notify-channel/index';
import type { WeekActivity } from './snapshot';

/**
 * THE EVIDENCE A DIGEST IS ALLOWED TO BE BUILT FROM.
 *
 * ===========================================================================
 * NOTHING IS INFERRED HERE THAT WAS NOT MEASURED.
 *
 * Every field on `DigestEvidence` is filled from a row that exists:
 * `practice_sessions`, `practice_responses`, `questions.distractor_misconceptions`
 * and `misconception_patterns`. There is no field for "how they are feeling",
 * "predicted grade" or "learning style", because nothing in the database
 * supports one — and a digest that implies data we do not have is worse than a
 * shorter digest, because a parent cannot tell the two apart.
 *
 * THE MISCONCEPTION LIST IS EMPTY TODAY, CORPUS-WIDE (D-077).
 * `questions.distractor_misconceptions` is NULL on all 2,741 imported
 * questions, so `misconceptions` will be `[]` for essentially every real week
 * until the pedagogy authoring lands. That is handled by saying what improved
 * instead — see `digest-content.ts`. It is NEVER handled by inventing one.
 * ===========================================================================
 *
 * Pure. These types and the two classifiers below have no I/O, no clock and no
 * randomness; the repository does the measuring and this decides what it means.
 */

/** One chapter's week, as counted from real sessions. */
export interface ChapterWeek {
  readonly chapterId: string;
  readonly title: BilingualText;
  readonly sessions: number;
  readonly questionsAnswered: number;
  /**
   * The mean session score for this chapter THIS week, 0..100.
   *
   * INTERNAL. It decides which chapter the digest talks about; it is never
   * printed, and `assertDigestIsHonest` refuses any draft that contains a
   * percentage at all (§8.7: "never a percentage").
   */
  readonly averageScore: number;
  /** The same mean over every session BEFORE this week. Null when there were none. */
  readonly priorAverageScore: number | null;
}

/**
 * A misconception the child actually walked into, with the pattern that names
 * it.
 *
 * `descriptionHi` is nullable because `misconception_patterns` HAS NO HINDI
 * COLUMN — not "usually null", it does not exist (D-098, open item 14). The
 * composer falls back to the English description inside an otherwise-Hindi
 * sentence rather than dropping the line, because a parent reading Hindi is
 * better served by one English clause than by silence about the one thing in
 * the digest that matters.
 */
export interface MisconceptionSighting {
  readonly code: string;
  readonly description: string;
  readonly descriptionHi: string | null;
  readonly chapterTitle: BilingualText;
  readonly occurrences: number;
}

export interface DigestEvidence {
  /** Midnight UTC on the Monday of the week being reported. */
  readonly weekStart: Date;
  readonly activity: WeekActivity;
  readonly chapters: readonly ChapterWeek[];
  /** Empty for essentially every real week today — see the header (D-077). */
  readonly misconceptions: readonly MisconceptionSighting[];
  /** Answers changed from a wrong first choice to a right final one. */
  readonly recoveries: number;
  /** Hint rungs consumed. Effort, not failure. */
  readonly hintsUsed: number;
}

/**
 * How much a chapter's mean session score must rise to count as improvement.
 *
 * Ten points on a six-question session is one more question right. Below that
 * the "improvement" is which questions happened to be drawn, and a digest that
 * celebrates sampling noise teaches a parent to stop believing it.
 */
export const IMPROVEMENT_POINTS = 10;

/**
 * At or below this mean score, a chapter is where the child is struggling.
 *
 * Not shown to anyone. It selects WHICH CHAPTER the digest names; the number
 * itself never leaves this module.
 */
export const STRUGGLING_SCORE = 60;

/**
 * Deterministic ordering, always.
 *
 * Two chapters with the same delta must come out in the same order on every
 * run, or the digest text changes between two builds of the same week and the
 * idempotence test passes for the wrong reason. `chapterId` is the tiebreak
 * because it is stable and it is already unique.
 */
function byDeltaThenId(a: ChapterWeek, b: ChapterWeek): number {
  const deltaA = a.averageScore - (a.priorAverageScore ?? 0);
  const deltaB = b.averageScore - (b.priorAverageScore ?? 0);
  if (deltaA !== deltaB) return deltaB - deltaA;
  return a.chapterId < b.chapterId ? -1 : 1;
}

function byScoreThenId(a: ChapterWeek, b: ChapterWeek): number {
  if (a.averageScore !== b.averageScore) return a.averageScore - b.averageScore;
  return a.chapterId < b.chapterId ? -1 : 1;
}

/**
 * The chapters that moved up, best first.
 *
 * A chapter with NO prior score is excluded rather than counted as improvement
 * from zero. A first attempt is not an improvement; treating it as one would
 * make every new chapter a success story on the week it was started.
 */
export function improvedChapters(chapters: readonly ChapterWeek[]): readonly ChapterWeek[] {
  return chapters
    .filter(
      (chapter) =>
        chapter.priorAverageScore !== null &&
        chapter.averageScore - chapter.priorAverageScore >= IMPROVEMENT_POINTS,
    )
    .sort(byDeltaThenId);
}

/** The chapters that are hard, hardest first. */
export function strugglingChapters(chapters: readonly ChapterWeek[]): readonly ChapterWeek[] {
  return chapters.filter((chapter) => chapter.averageScore <= STRUGGLING_SCORE).sort(byScoreThenId);
}

/**
 * The one misconception a digest names, or null.
 *
 * ONE, never a list. A parent given three things to fix does none of them, and
 * the most frequent sighting is the one most likely to come up again this week.
 * Ties break on the code so the same week always produces the same digest.
 */
export function pickMisconception(
  sightings: readonly MisconceptionSighting[],
): MisconceptionSighting | null {
  const ranked = [...sightings].sort((a, b) => {
    if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
    return a.code < b.code ? -1 : 1;
  });
  return ranked[0] ?? null;
}
