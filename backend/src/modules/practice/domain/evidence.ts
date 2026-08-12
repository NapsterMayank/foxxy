import type { EvidenceLabel } from '@/shared/constants/practice';

/**
 * THE EVIDENCE LABEL — one of four words, never a percentage.
 *
 * ===========================================================================
 * WHY A WORD AND NOT A NUMBER. Plan §8.7 states it for the parent digest and it
 * is the same argument here: "She is confusing mass with weight" is useful to a
 * parent; "60 percent in Science" is not. A percentage also claims a precision
 * a six-question sample does not have — 4 of 6 and 5 of 8 both round to
 * something that looks measured and is not.
 *
 * `not_assessed` exists so the system can say "we do not know yet" instead of
 * rounding an absence up into a judgement. It is the honest answer for a
 * student who has practised once, and it is the label a parent screen should be
 * showing far more often than product instinct expects.
 * ===========================================================================
 *
 * Pure: no I/O, no clock, no randomness.
 */

/** Mastery at or above this, with enough attempts, is `strong`. */
export const STRONG_MASTERY = 0.8;

/** Mastery at or above this is `developing`; below it is `needs_another_session`. */
export const DEVELOPING_MASTERY = 0.5;

/**
 * How many attempts before `strong` may be claimed at all.
 *
 * ONE GOOD SESSION IS NOT EVIDENCE OF MASTERY, it is evidence of one good
 * session — and the difference matters most for exactly the questions a student
 * happened to find easy. A single 100% therefore reads `developing`, not
 * `strong`. This is the only place `attempts` changes the answer, and without
 * it the parameter would be decoration.
 */
export const ATTEMPTS_FOR_STRONG = 2;

/**
 * Labels a chapter's mastery.
 *
 * `mastery` is 0..1, as stored in `chapter_mastery.mastery_score` — the same
 * clamped scale `learner`'s domain owns. Out-of-range input throws rather than
 * clamping: clamping here would mask a clamping failure upstream, and this
 * function's output is what a parent reads.
 */
export function evidenceLabel(mastery: number, attempts: number): EvidenceLabel {
  if (!Number.isFinite(mastery) || mastery < 0 || mastery > 1) {
    throw new RangeError(
      `evidenceLabel: mastery must be between 0 and 1, received ${String(mastery)}.`,
    );
  }
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new RangeError(
      `evidenceLabel: attempts must be a non-negative integer, received ${String(attempts)}.`,
    );
  }

  // Nothing has been observed. Say so rather than reporting a mastery of 0 as
  // though it had been measured — an untouched chapter and a failed one are
  // very different conversations.
  if (attempts === 0) {
    return 'not_assessed';
  }

  if (mastery >= STRONG_MASTERY) {
    return attempts >= ATTEMPTS_FOR_STRONG ? 'strong' : 'developing';
  }

  if (mastery >= DEVELOPING_MASTERY) {
    return 'developing';
  }

  return 'needs_another_session';
}
