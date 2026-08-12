import type { NextDecision, ResponseConfidence } from '@/shared/constants/practice';

/**
 * THE EVIDENCE-BASED DECISION — the client's Screen 7, step 5 of the session.
 *
 * The client's branch, stated verbatim in the brief:
 *
 *   correct and confident and consistent  -> go forward
 *   correct but uncertain                 -> a confirmation question
 *   incorrect with a known misconception  -> targeted remediation
 *   repeated difficulty                   -> flag for recovery
 *
 * ===========================================================================
 * THE FIFTH BRANCH IS THE ONE THE BRIEF DOES NOT MENTION, AND IT IS THE COMMON
 * CASE. "Incorrect with a known misconception" requires a misconception code on
 * the chosen distractor, and `questions.distractor_misconceptions` is NULL on
 * all 2,741 imported questions (D-077). So `remediate_general` exists and is
 * SEPARATE from `remediate_misconception`.
 *
 * Collapsing the two would be the expensive mistake. A generic "let's look at
 * that again" delivered under the label of targeted remediation makes the
 * content gap invisible: the funnel reports that misconception-driven
 * remediation is firing, the metric looks healthy, and nobody authors the codes
 * that would make it true. Two decisions means the gap is countable.
 * ===========================================================================
 *
 * Pure: no I/O, no clock, no randomness.
 */

/** After how many consecutive wrong answers in one chapter recovery is flagged. */
export const RECOVERY_WRONG_STREAK = 3;

export interface AnswerEvidence {
  readonly isCorrect: boolean;
  /**
   * What the student said BEFORE answering, or null where the interface did not
   * ask.
   *
   * NULL IS NOT UNCERTAINTY. A question that never asked has produced no
   * evidence of doubt, and treating its absence as doubt would put a
   * confirmation question in front of every student on every screen that has
   * not adopted the confidence prompt yet — which is most of them.
   */
  readonly confidence: ResponseConfidence | null;
  /** True when the student moved off their first choice. `answer_changed`. */
  readonly answerChanged: boolean;
  /**
   * The misconception code for the distractor chosen, or null.
   *
   * Looked up by the CANONICAL option index (D-048, D-058). If a caller ever
   * looks it up by the shuffled index this branch will fire with the wrong code
   * and nothing will look wrong — see the note in `option-shuffle.ts`.
   */
  readonly misconceptionCode: string | null;
  /** How many in a row the student has now got wrong in this chapter. */
  readonly consecutiveWrongInChapter: number;
}

export interface NextStep {
  readonly decision: NextDecision;
  /** Present only on `remediate_misconception`. Null on every other branch. */
  readonly misconceptionCode: string | null;
}

/**
 * Chooses what happens after one answer.
 *
 * ORDER MATTERS AND IS DELIBERATE. Recovery is tested first among the
 * incorrect branches: a student on their third consecutive wrong answer does
 * not need a fourth targeted remediation on a fourth misconception, they need
 * somebody to notice. Remediating a known misconception is the right move
 * once; three times in a row it is the wrong altitude.
 */
export function decideNext(evidence: AnswerEvidence): NextStep {
  if (
    !Number.isInteger(evidence.consecutiveWrongInChapter) ||
    evidence.consecutiveWrongInChapter < 0
  ) {
    throw new RangeError(
      `decideNext: consecutiveWrongInChapter must be a non-negative integer, received ${String(
        evidence.consecutiveWrongInChapter,
      )}.`,
    );
  }

  if (!evidence.isCorrect) {
    if (evidence.consecutiveWrongInChapter >= RECOVERY_WRONG_STREAK) {
      return { decision: 'flag_for_recovery', misconceptionCode: null };
    }

    const code = evidence.misconceptionCode?.trim() ?? '';
    if (code.length > 0) {
      return { decision: 'remediate_misconception', misconceptionCode: code };
    }

    return { decision: 'remediate_general', misconceptionCode: null };
  }

  // Correct from here.
  //
  // "Consistent" is read as "did not waver": a student who selected the
  // misconception distractor and then corrected themselves got the mark and has
  // also shown the misconception, and one confirmation question is a cheaper
  // way to tell those apart than waiting for the next session.
  const uncertain =
    evidence.confidence === 'unsure' ||
    evidence.confidence === 'unsure_ish' ||
    evidence.answerChanged;

  return uncertain
    ? { decision: 'confirm', misconceptionCode: null }
    : { decision: 'advance', misconceptionCode: null };
}
