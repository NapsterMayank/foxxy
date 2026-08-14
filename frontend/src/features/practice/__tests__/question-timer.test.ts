import { describe, expect, it } from 'vitest';
import { MAX_TIME_SPENT_MS, elapsedMsBetween } from '../lib/question-timer';

describe('per-question timing', () => {
  it('reports the elapsed milliseconds', () => {
    expect(elapsedMsBetween(1_000, 9_500)).toBe(8_500);
  });

  it('rounds to a whole millisecond, because the contract takes an integer', () => {
    expect(elapsedMsBetween(0, 1_500.6)).toBe(1_501);
  });

  /*
   * A DEVICE CLOCK CAN STEP BACKWARDS — NTP, a timezone change, a manual
   * correction — and the contract's floor is 0. Sending a negative would 400,
   * and the answer would be lost over a number the student never saw.
   */
  it('never reports a negative when the clock goes backwards', () => {
    expect(elapsedMsBetween(9_000, 1_000)).toBe(0);
  });

  /*
   * A tab left open over lunch. The contract's ceiling is an hour; the server
   * clamps the claimed total to its own wall clock anyway, so an hour cannot
   * buy a pass through anti-cheat.
   */
  it('clamps a long idle to the contract’s ceiling instead of failing the request', () => {
    expect(elapsedMsBetween(0, 5 * 60 * 60 * 1000)).toBe(MAX_TIME_SPENT_MS);
  });

  it('survives a missing or nonsense timestamp', () => {
    expect(elapsedMsBetween(Number.NaN, 1_000)).toBe(0);
    expect(elapsedMsBetween(0, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('is zero for an instant answer rather than something negative', () => {
    expect(elapsedMsBetween(500, 500)).toBe(0);
  });
});
