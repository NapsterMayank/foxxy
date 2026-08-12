/**
 * HOW ONE SESSION MOVES A CHAPTER'S MASTERY.
 *
 * `chapter_mastery.mastery_score` is a 0..1 LEVEL, not a tally — the learner
 * repository writes it outright rather than accumulating it, precisely because
 * the caller is expected to have decided what the new value is from the whole
 * of the student's history. This function is that decision.
 *
 * ===========================================================================
 * AN EXPONENTIAL MOVING AVERAGE, AND WHY NOT SOMETHING CLEVERER.
 *
 * Two obvious alternatives are both worse:
 *
 *   "The latest score IS the mastery" makes mastery as noisy as a six-question
 *   sample. One unlucky session takes a student from strong to
 *   needs-another-session, a parent sees it, and the number stops being
 *   believed — which costs more than any accuracy it buys.
 *
 *   A full running mean over every session makes recent evidence weaker than
 *   old evidence, forever. A student who has genuinely learned the chapter is
 *   held down by their first three attempts, which is exactly backwards for a
 *   measure whose job is to say where they are NOW.
 *
 * The EMA is the smallest thing that is right in both directions: recent
 * sessions dominate, one bad session cannot erase a history, and the constant
 * is a single number that can be explained to a teacher in one sentence.
 *
 * IRT calibration (05-ROADMAP.md §6, deferred) replaces this once there is
 * enough response data to fit it. Until then a stated, simple rule beats an
 * unfitted sophisticated one.
 * ===========================================================================
 *
 * Pure: no I/O, no clock, no randomness.
 */

/**
 * How much of the new score the updated mastery takes. 0.4 means "the last
 * session is worth about 40%, everything before it about 60%".
 */
export const MASTERY_LEARNING_RATE = 0.4;

/**
 * The mastery after this session.
 *
 * `previous` is null for a chapter never practised, in which case the session's
 * own score IS the mastery — there is nothing to blend with, and averaging
 * against an invented zero would open every student at half of what they scored.
 *
 * AN INVALID ATTEMPT MUST NOT REACH THIS FUNCTION WITH ITS REAL SCORE. It
 * scores zero, and zero blended in is a real fall in mastery — which is
 * correct: the session happened, nothing was demonstrated, and pretending
 * otherwise is how anti-cheat becomes free.
 */
export function nextMastery(previous: number | null, scorePercent: number): number {
  if (!Number.isFinite(scorePercent) || scorePercent < 0 || scorePercent > 100) {
    throw new RangeError(
      `nextMastery: scorePercent must be between 0 and 100, received ${String(scorePercent)}.`,
    );
  }
  if (previous !== null && (!Number.isFinite(previous) || previous < 0 || previous > 1)) {
    throw new RangeError(
      `nextMastery: previous mastery must be between 0 and 1, received ${String(previous)}.`,
    );
  }

  const observed = scorePercent / 100;
  if (previous === null) {
    return round(observed);
  }

  return round(previous * (1 - MASTERY_LEARNING_RATE) + observed * MASTERY_LEARNING_RATE);
}

/**
 * Three decimals, matching `chapter_mastery.mastery_score`, which is
 * `numeric(4, 3)`.
 *
 * Rounded HERE rather than left to the column, for the same reason the ease
 * factor is: a value that differs between what the domain computed and what
 * comes back out of the database compounds, and the drift is invisible because
 * both numbers are plausible. There is a test asserting that the returned value
 * survives a round trip through three decimal places unchanged, so a widening
 * of the column without a change here fails loudly.
 */
function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
