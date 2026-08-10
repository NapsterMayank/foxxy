import { describe, expect, it } from 'vitest';
import { calculateScore } from '../domain/scoring';

/**
 * §8.6's named domain tests for the score, plus the boundaries §9.3 requires.
 *
 * The three worked examples in the plan are here verbatim — 7 of 9 is 78, 0 of
 * 10 is 0, 10 of 10 is 100 — because they are the specification, not examples
 * of it. 7/9 is 77.77…, so 78 is a statement about the ROUNDING as much as
 * about the division, and it is the one that catches a `Math.floor` or a
 * `toFixed(0)` substituted for `Math.round`.
 */

describe('calculateScore — the three worked examples from §8.6', () => {
  it('scores 7 of 9 as 78', () => {
    expect(calculateScore(7, 9)).toBe(78);
  });

  it('scores 0 of 10 as 0', () => {
    expect(calculateScore(0, 10)).toBe(0);
  });

  it('scores 10 of 10 as 100', () => {
    expect(calculateScore(10, 10)).toBe(100);
  });
});

describe('calculateScore — rounding', () => {
  it('rounds .5 up, as Math.round does', () => {
    // 1/8 = 12.5 exactly. A `toFixed` implementation banker's-rounds this to 12.
    expect(calculateScore(1, 8)).toBe(13);
  });

  it('rounds below .5 down', () => {
    // 3/8 = 37.5 -> 38; 2/9 = 22.22 -> 22.
    expect(calculateScore(2, 9)).toBe(22);
  });

  it('never returns a fraction', () => {
    for (let total = 1; total <= 20; total += 1) {
      for (let correct = 0; correct <= total; correct += 1) {
        expect(Number.isInteger(calculateScore(correct, total))).toBe(true);
      }
    }
  });
});

describe('calculateScore — division by zero', () => {
  it('scores an empty attempt as 0 rather than NaN', () => {
    // NaN survives arithmetic silently and only fails at the integer column,
    // with a message about a type rather than about a score.
    expect(calculateScore(0, 0)).toBe(0);
  });

  it('does not return NaN for any zero-total input', () => {
    expect(Number.isNaN(calculateScore(0, 0))).toBe(false);
  });
});

describe('calculateScore — incoherent input throws rather than inventing a score', () => {
  it('rejects more correct answers than questions', () => {
    expect(() => calculateScore(5, 4)).toThrow(RangeError);
  });

  it('rejects a negative correct count', () => {
    expect(() => calculateScore(-1, 10)).toThrow(RangeError);
  });

  it('rejects a negative total', () => {
    expect(() => calculateScore(0, -1)).toThrow(RangeError);
  });

  it('rejects a fractional count', () => {
    expect(() => calculateScore(1.5, 10)).toThrow(RangeError);
  });
});
