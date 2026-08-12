import type { EvidenceLabel, MissionReason } from '@/shared/constants/practice';
import { evidenceLabel } from './evidence';
import { isDue } from './spaced-retention';

/**
 * TODAY'S MISSION — step 1 of the session, and the client's most important
 * screen.
 *
 * ===========================================================================
 * THE REASON IS THE FEATURE, NOT A LABEL ON IT.
 *
 * "Today's mission: 10 questions" is a to-do item. "Review of The Human Eye is
 * 3 days overdue" is a reason to open the app. The difference is whether the
 * student believes the system knows anything about them, and a generic message
 * answers that question badly and permanently — a student who reads one
 * hard-coded encouragement twice stops reading them.
 *
 * So every reason this function produces is DERIVED FROM A ROW THAT EXISTS:
 * a `practice_retention.due_at` in the past, a `chapter_mastery.mastery_score`
 * below the bar, or the absence of any mastery row for the next chapter in the
 * syllabus. There is no branch that returns encouragement, and the only
 * constant string in the file is the one for "there is genuinely nothing" —
 * which says so plainly rather than inventing something to do.
 *
 * NEVER A PERCENTAGE, for the same reason `evidence.ts` gives: the weak-chapter
 * reason names the evidence LABEL, not the score behind it.
 * ===========================================================================
 *
 * BILINGUAL AT THE POINT OF CONSTRUCTION (P7). Both strings are built here,
 * together, from the same data — rather than an English string plus a
 * translation step that can be skipped. `notify` learned this the expensive
 * way: both languages are required at the type level AND by NOT NULL columns.
 *
 * Pure: no I/O, no clock (`now` is an argument), no randomness.
 */

/** Mastery at or below this makes a chapter a weak-chapter candidate. */
export const WEAK_CHAPTER_MASTERY = 0.6;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * One chapter the student could be sent to, with everything known about it.
 *
 * Assembled by the repository from real rows. A candidate with no
 * `practice_retention` row has `dueAt: null`; one the student has never
 * practised has `masteryScore: null` and `attempts: 0`.
 */
export interface MissionCandidate {
  readonly chapterId: string;
  readonly chapterNumber: number;
  readonly chapterTitleEn: string;
  readonly chapterTitleHi: string | null;
  readonly subjectCode: string;
  /** From `practice_retention.due_at`. Null when never scheduled. */
  readonly dueAt: Date | null;
  /** From `chapter_mastery.mastery_score`, 0..1. Null when never practised. */
  readonly masteryScore: number | null;
  /** From `chapter_mastery.attempts`. */
  readonly attempts: number;
}

export interface Mission {
  readonly chapterId: string;
  readonly chapterNumber: number;
  readonly chapterTitleEn: string;
  readonly chapterTitleHi: string | null;
  readonly subjectCode: string;
  readonly reason: MissionReason;
  /** Built from this candidate's own data. Never a template with no values. */
  readonly reasonEn: string;
  readonly reasonHi: string;
  /** Where the student stands on this chapter today. A word, never a number. */
  readonly evidence: EvidenceLabel;
}

/**
 * Picks one chapter and says why.
 *
 * THE PRIORITY ORDER IS PEDAGOGY, NOT CONVENIENCE:
 *
 *  1. A DUE REVIEW outranks everything. The whole point of scheduling a review
 *     is that the date is the right date; a system that schedules one and then
 *     offers something else has not scheduled anything.
 *  2. The WEAKEST CHAPTER next. Ground already lost is worth more than ground
 *     not yet covered, and a student who moves on with a weak chapter behind
 *     them carries it into every chapter that builds on it.
 *  3. NEXT IN SYLLABUS last — the lowest-numbered chapter with no mastery at
 *     all. Forward motion, once nothing is owed.
 *
 * Returns `null` when the student has no candidates whatsoever. The caller says
 * so; this function does not manufacture a mission out of an empty list.
 */
export function chooseMission(
  candidates: readonly MissionCandidate[],
  now: Date,
): Mission | null {
  const [fallback] = candidates;
  if (fallback === undefined) {
    return null;
  }

  /**
   * `flatMap` RATHER THAN `filter` PLUS AN ASSERTION, in both ranked passes.
   *
   * `filter` cannot narrow the element type, so a `.sort` over its result has to
   * assert that `dueAt` is not null — an assertion whose truth lives in a
   * predicate several lines away. `flatMap` carries the narrowed value out
   * alongside the candidate, so the comparator reads a `Date` rather than a
   * `Date | null` that somebody promised. It is also the only form the lint
   * rules allow: `!` is banned outside tests, for exactly this reason.
   */

  // --- 1. due reviews, most overdue first ----------------------------------
  const due = candidates
    .flatMap((candidate) =>
      candidate.dueAt !== null && isDue(candidate.dueAt, now)
        ? [{ candidate, dueAt: candidate.dueAt }]
        : [],
    )
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());

  const overdue = due[0];
  if (overdue !== undefined) {
    return build(overdue.candidate, 'due_review', now);
  }

  // --- 2. the weakest chapter that is actually weak -------------------------
  const weak = candidates
    .flatMap((candidate) =>
      candidate.masteryScore !== null && candidate.masteryScore <= WEAK_CHAPTER_MASTERY
        ? [{ candidate, mastery: candidate.masteryScore }]
        : [],
    )
    .sort((a, b) => a.mastery - b.mastery);

  const weakest = weak[0];
  if (weakest !== undefined) {
    return build(weakest.candidate, 'weak_chapter', now);
  }

  // --- 3. the next unstarted chapter ---------------------------------------
  const unstarted = candidates
    .filter((candidate) => candidate.attempts === 0)
    .sort((a, b) => a.chapterNumber - b.chapterNumber);

  const next = unstarted[0];
  if (next !== undefined) {
    return build(next, 'next_in_syllabus', now);
  }

  // Everything is practised, nothing is weak and nothing is due. A real state,
  // and the one place a fixed string is honest: there is nothing to derive a
  // reason from, so the message says exactly that instead of dressing it up.
  return build(fallback, 'nothing_available', now);
}

function build(candidate: MissionCandidate, reason: MissionReason, now: Date): Mission {
  const titleEn = candidate.chapterTitleEn;
  const titleHi = candidate.chapterTitleHi ?? candidate.chapterTitleEn;
  const evidence = evidenceLabel(candidate.masteryScore ?? 0, candidate.attempts);

  /**
   * Computed HERE, in the one place that can SEE whether `dueAt` is null, so
   * `reasonText` receives a number and has no nullable field to assert away.
   */
  const daysOverdue = candidate.dueAt === null ? 0 : wholeDaysBetween(candidate.dueAt, now);

  const { reasonEn, reasonHi } = reasonText(
    candidate,
    reason,
    titleEn,
    titleHi,
    evidence,
    daysOverdue,
  );

  return {
    chapterId: candidate.chapterId,
    chapterNumber: candidate.chapterNumber,
    chapterTitleEn: candidate.chapterTitleEn,
    chapterTitleHi: candidate.chapterTitleHi,
    subjectCode: candidate.subjectCode,
    reason,
    reasonEn,
    reasonHi,
    evidence,
  };
}

function reasonText(
  candidate: MissionCandidate,
  reason: MissionReason,
  titleEn: string,
  titleHi: string,
  evidence: EvidenceLabel,
  daysOverdue: number,
): { reasonEn: string; reasonHi: string } {
  switch (reason) {
    case 'due_review': {
      // DAYS RELATIVE TO THE INJECTED CLOCK, not a formatted date. A formatted
      // date needs a timezone and a locale, and both are decisions this layer
      // has no business making — "3 days overdue" is the same fact in both
      // languages and in every timezone the product ships to.
      const days = daysOverdue;
      if (days <= 0) {
        return {
          reasonEn: `Your review of "${titleEn}" is due today.`,
          reasonHi: `"${titleHi}" का दोहराव आज करना है।`,
        };
      }
      return {
        reasonEn: `Your review of "${titleEn}" is ${days} ${days === 1 ? 'day' : 'days'} overdue.`,
        reasonHi: `"${titleHi}" का दोहराव ${days} दिन से बाकी है।`,
      };
    }

    case 'weak_chapter': {
      const phraseEn = evidence === 'needs_another_session' ? 'needs another session' : 'is still developing';
      const phraseHi = evidence === 'needs_another_session' ? 'एक और सत्र चाहिए' : 'अभी बन रहा है';
      return {
        reasonEn: `"${titleEn}" ${phraseEn} after ${candidate.attempts} ${
          candidate.attempts === 1 ? 'attempt' : 'attempts'
        }.`,
        reasonHi: `${candidate.attempts} प्रयास के बाद "${titleHi}" ${phraseHi}।`,
      };
    }

    case 'next_in_syllabus':
      return {
        reasonEn: `"${titleEn}" is chapter ${candidate.chapterNumber} and you have not started it yet.`,
        reasonHi: `"${titleHi}" अध्याय ${candidate.chapterNumber} है और आपने इसे अभी शुरू नहीं किया है।`,
      };

    case 'nothing_available':
      return {
        reasonEn: 'Nothing is due and nothing is weak. Practise anything you like.',
        reasonHi: 'कुछ भी बाकी या कमज़ोर नहीं है। जो चाहें उसका अभ्यास करें।',
      };
  }
}

/** Whole days from `from` to `now`, floored at 0. */
function wholeDaysBetween(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / MS_PER_DAY));
}
