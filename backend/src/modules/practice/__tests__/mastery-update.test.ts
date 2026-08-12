import { describe, expect, it } from 'vitest';
import { MASTERY_LEARNING_RATE, nextMastery } from '../domain/mastery-update';

/**
 * How one session moves a chapter's mastery.
 *
 * The two boundary behaviours worth pinning are the FIRST session (there is
 * nothing to blend with) and the two directions of the blend — because the
 * failure mode of an exponential moving average is not a crash, it is a number
 * that moves too fast or too slow and that nobody can tell is wrong by looking
 * at it.
 */

describe('nextMastery — the first session', () => {
  it('takes the score outright when there is no history', () => {
    // Averaging against an invented zero would open every student at half of
    // what they actually scored.
    expect(nextMastery(null, 80)).toBe(0.8);
  });

  it('records a zero first session as zero', () => {
    expect(nextMastery(null, 0)).toBe(0);
  });

  it('records a perfect first session as 1', () => {
    expect(nextMastery(null, 100)).toBe(1);
  });
});

describe('nextMastery — the blend', () => {
  it('weights the new score by the learning rate', () => {
    const expected = 0.5 * (1 - MASTERY_LEARNING_RATE) + 1 * MASTERY_LEARNING_RATE;
    expect(nextMastery(0.5, 100)).toBeCloseTo(expected, 3);
  });

  it('moves UP after a better session, but not all the way', () => {
    const result = nextMastery(0.5, 100);
    expect(result).toBeGreaterThan(0.5);
    expect(result).toBeLessThan(1);
  });

  it('moves DOWN after a worse session, but not all the way', () => {
    const result = nextMastery(0.9, 0);
    expect(result).toBeLessThan(0.9);
    expect(result).toBeGreaterThan(0);
  });

  it('ONE BAD SESSION CANNOT ERASE A HISTORY', () => {
    // The whole reason it is not "the latest score IS the mastery". A student
    // at 0.95 who has one unlucky session must not drop to
    // needs-another-session, because a number that swings like that stops being
    // believed — which costs more than any accuracy it buys.
    expect(nextMastery(0.95, 0)).toBeGreaterThan(0.5);
  });

  it('converges toward a repeated score rather than overshooting it', () => {
    let mastery = 0.1;
    for (let session = 0; session < 30; session += 1) {
      mastery = nextMastery(mastery, 80);
    }
    expect(mastery).toBeCloseTo(0.8, 2);
    expect(mastery).toBeLessThanOrEqual(0.8);
  });

  it('stays inside 0..1 for every combination', () => {
    for (let previous = 0; previous <= 1.0001; previous += 0.1) {
      for (const score of [0, 33, 50, 79, 80, 100]) {
        const result = nextMastery(Math.min(1, previous), score);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('nextMastery — rounding matches the column', () => {
  it('returns at most three decimals, as numeric(4,3) stores', () => {
    // A value that differs between what the domain computed and what comes
    // back out of the column compounds across sessions into a different label.
    const result = nextMastery(0.333, 67);
    expect(Math.round(result * 1000) / 1000).toBe(result);
  });
});

describe('nextMastery — rejects impossible input', () => {
  it('rejects a score above 100', () => {
    expect(() => nextMastery(0.5, 101)).toThrow(RangeError);
  });

  it('rejects a negative score', () => {
    expect(() => nextMastery(0.5, -1)).toThrow(RangeError);
  });

  it('rejects a previous mastery outside 0..1', () => {
    expect(() => nextMastery(1.5, 50)).toThrow(RangeError);
    expect(() => nextMastery(-0.1, 50)).toThrow(RangeError);
  });
});
