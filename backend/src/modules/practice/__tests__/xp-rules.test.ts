import { describe, expect, it } from 'vitest';
import { XP_RULES, applyDailyCap, calculateXp } from '../domain/xp-rules';

/**
 * §8.6: "XP at each bonus boundary, tested at 79, 80, 99 and 100" and "daily cap
 * clamping".
 *
 * Every expectation below is expressed in terms of `XP_RULES` rather than in
 * literal numbers. That is not indirection for its own sake: a test written as
 * `expect(...).toBe(120)` passes only for the current constants, so changing the
 * reward means changing the test — which turns the test into a transcription of
 * the implementation and stops it saying anything about the RULE. Written this
 * way, the tests continue to assert the shape of the economy (a bar at 80, a
 * second reward at exactly 100, both stacking) after any tuning.
 *
 * ===========================================================================
 * AND THAT IS EXACTLY WHY THE BLOCK BELOW EXISTS — D-285.
 *
 * Relative assertions move with the constant they test. An auditor changed
 * `perCorrect` 10 -> 9, `highScoreBonus` 20 -> 19 and `perfectBonus` 30 -> 29 and
 * ALL 2,530 TESTS PASSED. The whole economy was devalued by ten percent with a
 * green suite, which is precisely the failure this module's own header names: "a
 * screen that promises 10 XP and a ledger that awards 8 ... There is no error, no
 * log line and no test that fails."
 *
 * The THRESHOLDS were already safe by accident — 79, 80, 99 and 100 appear as
 * literals in the boundary tests, so moving `highScoreThreshold` to 70 goes red.
 * Only the PAYOUTS were unpinned, and `dailyCap` was caught only incidentally by
 * hardcoded fixture values in another file.
 *
 * So: literals, in the module that owns them, exactly as `anti-cheat.test.ts`
 * pins `MIN_AVERAGE_MS_PER_QUESTION` to 3000. The relative tests stay — they are
 * what says the economy has a bar at 80 and two stacking rewards — and these say
 * what the numbers ARE. Changing a payout should cost one deliberate edit here,
 * not zero.
 * ===========================================================================
 */

describe('the XP economy is the one §8.6 specifies — pinned to literals', () => {
  it('pins the per-correct payout at 10', () => {
    expect(XP_RULES.perCorrect).toBe(10);
  });

  it('pins the high-score bonus at 20', () => {
    expect(XP_RULES.highScoreBonus).toBe(20);
  });

  it('pins the perfect-score bonus at 30', () => {
    expect(XP_RULES.perfectBonus).toBe(30);
  });

  it('pins the daily cap at 200', () => {
    expect(XP_RULES.dailyCap).toBe(200);
  });

  it('pins the high-score bar at 80 and the perfect bar at 100', () => {
    // Already caught by the boundary tests below, and stated here anyway so the
    // whole economy is readable in one block.
    expect(XP_RULES.highScoreThreshold).toBe(80);
    expect(XP_RULES.perfectScore).toBe(100);
  });

  it('pins what a full six-question session actually pays: 110', () => {
    // The end-to-end number, so a change to the FORMULA — not just a constant —
    // also has to be deliberate. This is the figure the interface quotes.
    expect(calculateXp(6, 100)).toBe(110);
  });

  it('pins what a five-of-six session pays: 70', () => {
    // 83% — over the bar, under perfect. The common good session.
    expect(calculateXp(5, 83)).toBe(70);
  });

  it('pins the most one day can award: 200', () => {
    expect(applyDailyCap(500, 0).awarded).toBe(200);
  });
});

describe('calculateXp — the per-correct base', () => {
  it('pays for each correct answer', () => {
    expect(calculateXp(4, 40)).toBe(4 * XP_RULES.perCorrect);
  });

  it('pays nothing for an all-wrong attempt', () => {
    expect(calculateXp(0, 0)).toBe(0);
  });
});

describe('calculateXp — the high-score boundary is 80, not 79', () => {
  it('pays NO high-score bonus at 79', () => {
    expect(calculateXp(5, 79)).toBe(5 * XP_RULES.perCorrect);
  });

  it('pays the high-score bonus at exactly 80', () => {
    expect(calculateXp(5, 80)).toBe(5 * XP_RULES.perCorrect + XP_RULES.highScoreBonus);
  });

  it('pays the high-score bonus above 80', () => {
    expect(calculateXp(5, 81)).toBe(5 * XP_RULES.perCorrect + XP_RULES.highScoreBonus);
  });
});

describe('calculateXp — the perfect boundary is 100, not 99', () => {
  it('pays no perfect bonus at 99', () => {
    expect(calculateXp(9, 99)).toBe(9 * XP_RULES.perCorrect + XP_RULES.highScoreBonus);
  });

  it('pays BOTH bonuses at exactly 100 — they stack', () => {
    expect(calculateXp(10, 100)).toBe(
      10 * XP_RULES.perCorrect + XP_RULES.highScoreBonus + XP_RULES.perfectBonus,
    );
  });
});

describe('calculateXp — rejects impossible input', () => {
  it('rejects a negative correct count', () => {
    expect(() => calculateXp(-1, 50)).toThrow(RangeError);
  });

  it('rejects a score above 100', () => {
    expect(() => calculateXp(1, 101)).toThrow(RangeError);
  });

  it('rejects a score below 0', () => {
    expect(() => calculateXp(1, -1)).toThrow(RangeError);
  });

  it('rejects a fractional correct count', () => {
    expect(() => calculateXp(1.5, 50)).toThrow(RangeError);
  });
});

describe('applyDailyCap — clamping', () => {
  it('does not clamp when the day has room', () => {
    const result = applyDailyCap(50, 0);
    expect(result.awarded).toBe(50);
    expect(result.withheld).toBe(0);
    expect(result.capReached).toBe(false);
  });

  it('awards exactly the remaining room when the session would cross the cap', () => {
    const result = applyDailyCap(50, XP_RULES.dailyCap - 20);
    expect(result.awarded).toBe(20);
    expect(result.earned).toBe(50);
    expect(result.withheld).toBe(30);
    expect(result.capReached).toBe(true);
  });

  it('awards exactly the cap when a single session would exceed it from zero', () => {
    const result = applyDailyCap(XP_RULES.dailyCap + 100, 0);
    expect(result.awarded).toBe(XP_RULES.dailyCap);
  });

  it('awards zero once the cap is reached exactly', () => {
    const result = applyDailyCap(30, XP_RULES.dailyCap);
    expect(result.awarded).toBe(0);
    expect(result.capReached).toBe(true);
  });

  it('NEVER awards a negative amount, even past the cap', () => {
    // The ledger is append-only. A negative row would be a different fact —
    // taking XP away — and nothing in the product is allowed to do that here.
    const result = applyDailyCap(30, XP_RULES.dailyCap + 500);
    expect(result.awarded).toBe(0);
    expect(result.awarded).toBeGreaterThanOrEqual(0);
  });

  it('does not clamp at exactly the cap boundary', () => {
    const result = applyDailyCap(XP_RULES.dailyCap, 0);
    expect(result.awarded).toBe(XP_RULES.dailyCap);
    expect(result.capReached).toBe(false);
  });

  it('rejects a negative already-earned total', () => {
    expect(() => applyDailyCap(10, -1)).toThrow(RangeError);
  });

  it('rejects a negative earned amount', () => {
    expect(() => applyDailyCap(-1, 0)).toThrow(RangeError);
  });
});
