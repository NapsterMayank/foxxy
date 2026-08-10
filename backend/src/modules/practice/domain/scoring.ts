/**
 * THE SCORE. One expression, one file, one place in the codebase.
 *
 * 01-BACKEND-IMPLEMENTATION-PLAN.md §8.6:
 *
 *     score_percent = Math.round((correct / total) * 100)
 *
 * "This exact expression, in exactly one place in the codebase." The previous
 * system had it in three — a submit function, a results component and a
 * database RPC — and keeping three copies of a rounding rule in agreement is a
 * thing nobody succeeds at indefinitely. When they disagree the symptom is a
 * student seeing 67% on one screen and 66% on another, which reads as a display
 * bug and is in fact two different scores having been computed.
 *
 * Pure: no I/O, no clock, no randomness. Everything it needs is an argument.
 */

/**
 * The percentage of questions answered correctly, rounded to a whole number.
 *
 * ZERO QUESTIONS SCORES ZERO rather than raising or returning NaN. It is a real
 * state — a session abandoned before any answer, or an invalid attempt whose
 * responses were discarded — and `0 / 0` is `NaN`, which survives arithmetic
 * silently, reaches an integer column, and fails there with a message about a
 * type rather than about a score.
 *
 * INCOHERENT INPUT THROWS. More correct answers than questions, or a negative
 * count, is not a data case the product can produce; it is a defect upstream,
 * and returning a plausible number for it would file that defect permanently in
 * a student's history where nothing would ever question it.
 */
export function calculateScore(correct: number, total: number): number {
  assertCount(correct, 'correct');
  assertCount(total, 'total');

  if (correct > total) {
    throw new RangeError(
      `calculateScore: ${correct} correct out of ${total} questions is impossible.`,
    );
  }

  if (total === 0) {
    return 0;
  }

  return Math.round((correct / total) * 100);
}

function assertCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `calculateScore: ${name} must be a non-negative integer, received ${String(value)}.`,
    );
  }
}
