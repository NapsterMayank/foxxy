/**
 * ANTI-CHEAT — the three checks from §8.6, applied to a whole attempt.
 *
 *   1. average time is at least 3 seconds per question
 *   2. not every answer the same index, when there are MORE THAN 3 questions
 *   3. response count equals question count
 *
 * ===========================================================================
 * WHAT THESE ARE AND ARE NOT. They do not detect a determined cheat; a student
 * who wants to game them can wait four seconds and vary an index. They detect
 * the two things that actually happen at scale — a script, and a bored tap
 * through — and they do it cheaply and without accusing anyone. An attempt that
 * fails is SCORED ZERO AND RECORDED WITH ITS REASON, never deleted and never
 * silently discarded: the responses are evidence, and the reason is what makes
 * a support conversation possible.
 *
 * THE ORDER OF THE CHECKS IS LOAD-BEARING. Count first — an average over the
 * wrong number of responses is a number about nothing, and "all the same index"
 * over a partial set says nothing either. Only once the set is known to be
 * complete do the other two mean anything.
 * ===========================================================================
 *
 * Pure: no I/O, no clock (elapsed time arrives as a number), no randomness.
 */

/** The minimum average, in milliseconds, across the whole attempt. */
export const MIN_AVERAGE_MS_PER_QUESTION = 3_000;

/**
 * The same-index rule applies only ABOVE this many questions.
 *
 * "not every answer the same index when there are more than 3 questions" —
 * so exactly 3 identical answers is allowed and 4 is not. With three
 * four-option questions, all-the-same happens by chance about once in sixteen
 * honest attempts, and a rule that fails one honest student in sixteen is a
 * rule that gets switched off.
 */
export const SAME_ANSWER_MIN_QUESTIONS = 3;

export const ANTI_CHEAT_REASONS = [
  'response_count_mismatch',
  'too_fast',
  'all_same_answer',
] as const;
export type AntiCheatReason = (typeof ANTI_CHEAT_REASONS)[number];

/** The only two fields the checks read. Everything else about a response is irrelevant here. */
export interface AttemptResponse {
  /** The CANONICAL option index (D-058). The rule is about variety, not about which option. */
  readonly selectedIndex: number;
  readonly timeSpentMs: number;
}

export type AttemptValidity =
  | { readonly isValid: true }
  | { readonly isValid: false; readonly reason: AntiCheatReason };

/**
 * Runs all three checks and reports the FIRST failure.
 *
 * One reason rather than a list, because the reason is written to
 * `practice_sessions.invalid_reason` and read by a human deciding what to say
 * to a student. "Too fast, and every answer was B" is not more actionable than
 * "too fast"; it is just longer.
 */
export function validateAttempt(
  responses: readonly AttemptResponse[],
  questionCount: number,
): AttemptValidity {
  if (!Number.isInteger(questionCount) || questionCount < 0) {
    throw new RangeError(
      `validateAttempt: questionCount must be a non-negative integer, received ${String(
        questionCount,
      )}.`,
    );
  }

  // --- 3. response count equals question count ------------------------------
  // First, because the other two are meaningless over the wrong set.
  if (responses.length !== questionCount) {
    return { isValid: false, reason: 'response_count_mismatch' };
  }

  // An empty attempt is vacuously consistent. It scores zero on its own merits
  // (`calculateScore(0, 0)`), which is the honest outcome — calling it a cheat
  // would put an accusation on a session where nothing happened.
  if (responses.length === 0) {
    return { isValid: true };
  }

  // --- 1. average time at least 3 seconds per question ----------------------
  // AVERAGE, not per-question. A student who reads the whole set first and then
  // answers the last four quickly is not cheating, and a per-question floor
  // would refuse them.
  const totalMs = responses.reduce((sum, response) => sum + response.timeSpentMs, 0);
  if (totalMs / responses.length < MIN_AVERAGE_MS_PER_QUESTION) {
    return { isValid: false, reason: 'too_fast' };
  }

  // --- 2. not every answer the same index, above 3 questions ----------------
  if (responses.length > SAME_ANSWER_MIN_QUESTIONS) {
    const first = responses[0]?.selectedIndex;
    if (responses.every((response) => response.selectedIndex === first)) {
      return { isValid: false, reason: 'all_same_answer' };
    }
  }

  return { isValid: true };
}
