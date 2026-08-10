/**
 * THE XP ECONOMY. Every constant lives here and NOWHERE ELSE — §8.6.
 *
 * ===========================================================================
 * WHY THAT RULE IS ABSOLUTE RATHER THAN TIDY.
 *
 * XP is the only number in the product a student watches every day. A value
 * duplicated into a UI label, a notification body or a marketing page does not
 * fail loudly when it drifts — it produces a screen that promises 10 XP and a
 * ledger that awards 8, and the student is the one who notices. There is no
 * error, no log line and no test that fails, because both numbers are
 * individually plausible.
 *
 * So: no literal XP value anywhere else. A caller that needs to SAY what the
 * reward is reads it from `XP_RULES`.
 * ===========================================================================
 *
 * Pure: no I/O, no clock, no randomness.
 */

export const XP_RULES = {
  /** Awarded per correct answer. */
  perCorrect: 10,

  /**
   * The score at or above which the high-score bonus applies.
   *
   * "at 80 percent or above" — so 80 earns it and 79 does not. Tested at both,
   * because an off-by-one on a threshold is invisible in every other test.
   */
  highScoreThreshold: 80,
  highScoreBonus: 20,

  /** A further bonus at exactly 100. Stacks with the high-score bonus. */
  perfectScore: 100,
  perfectBonus: 30,

  /**
   * The most XP one student may earn from practice in one day.
   *
   * A CAP RATHER THAN A DIMINISHING CURVE, deliberately: a curve makes "how
   * much is this session worth" unanswerable before the session, which is
   * exactly the question a student asks. A flat ceiling is something the
   * interface can state.
   *
   * The cap CLAMPS, it does not reject. A session that crosses it still
   * submits, still scores and still writes a ledger row — for the remaining
   * amount, possibly zero. Refusing the submission would throw away the
   * responses, which are the part that cannot be recovered.
   */
  dailyCap: 200,
} as const;

/**
 * The XP a single session earns, BEFORE the daily cap is applied.
 *
 *     xp = correct * perCorrect
 *        + (scorePercent >= 80  ? highScoreBonus : 0)
 *        + (scorePercent === 100 ? perfectBonus  : 0)
 *
 * The two bonuses STACK. A perfect score earns both, which is the intended
 * shape: the high-score bonus rewards clearing the bar, the perfect bonus
 * rewards the last question.
 */
export function calculateXp(correct: number, scorePercent: number): number {
  if (!Number.isInteger(correct) || correct < 0) {
    throw new RangeError(
      `calculateXp: correct must be a non-negative integer, received ${String(correct)}.`,
    );
  }
  if (!Number.isFinite(scorePercent) || scorePercent < 0 || scorePercent > 100) {
    throw new RangeError(
      `calculateXp: scorePercent must be between 0 and 100, received ${String(scorePercent)}.`,
    );
  }

  const base = correct * XP_RULES.perCorrect;
  const highScore = scorePercent >= XP_RULES.highScoreThreshold ? XP_RULES.highScoreBonus : 0;
  const perfect = scorePercent === XP_RULES.perfectScore ? XP_RULES.perfectBonus : 0;

  return base + highScore + perfect;
}

/** What the cap did to an award, so the interface can explain the difference. */
export interface CappedXp {
  /** What is actually awarded. Never negative, never above the remaining room. */
  readonly awarded: number;
  /** What would have been awarded with no cap. */
  readonly earned: number;
  /** `earned - awarded`. Zero when the cap did not bite. */
  readonly withheld: number;
  readonly capReached: boolean;
}

/**
 * Applies the daily cap.
 *
 * Separated from `calculateXp` because they answer different questions and only
 * one of them needs to know what else happened today. `calculateXp` is a
 * property of the session; the cap is a property of the day. Folding them
 * together would mean the session's own worth could not be stated without
 * loading the ledger.
 *
 * ALREADY-OVER IS CLAMPED TO ZERO, not to a negative. A student who is somehow
 * past the cap earns nothing more; they do not lose XP they have already been
 * given, because the ledger is append-only and a negative row would be a
 * different fact entirely.
 */
export function applyDailyCap(earned: number, alreadyEarnedToday: number): CappedXp {
  if (!Number.isInteger(earned) || earned < 0) {
    throw new RangeError(
      `applyDailyCap: earned must be a non-negative integer, received ${String(earned)}.`,
    );
  }
  if (!Number.isInteger(alreadyEarnedToday) || alreadyEarnedToday < 0) {
    throw new RangeError(
      `applyDailyCap: alreadyEarnedToday must be a non-negative integer, received ${String(
        alreadyEarnedToday,
      )}.`,
    );
  }

  const room = Math.max(0, XP_RULES.dailyCap - alreadyEarnedToday);
  const awarded = Math.min(earned, room);

  return {
    awarded,
    earned,
    withheld: earned - awarded,
    capReached: awarded < earned,
  };
}
