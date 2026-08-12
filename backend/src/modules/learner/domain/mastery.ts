import { ValidationError } from '@/platform/errors/index';

/**
 * Mastery arithmetic — pure. No database, no network, no clock (§2, layer
 * table). Everything here is a total function of its arguments.
 */

/** The closed interval mastery lives in. Mirrors `chapter_mastery_score_check`. */
export const MASTERY_MIN = 0;
export const MASTERY_MAX = 1;

/**
 * Three decimal places, matching `numeric(4, 3)` exactly.
 *
 * The column was chosen as `numeric` rather than `double precision` because
 * mastery is compared against thresholds and shown to a parent, and binary
 * floating point turns "0.8 or above" into a question about representation.
 * Rounding HERE, in the same place the clamp happens, keeps the value the
 * module believes it wrote identical to the value the database stores — the
 * alternative is a silent rounding step inside Postgres that no test can see.
 */
export const MASTERY_DECIMALS = 3;

const MASTERY_SCALE = 10 ** MASTERY_DECIMALS;

/**
 * Clamps a COMPUTED mastery value into 0..1 and rounds it to the column's
 * precision.
 *
 * ON WHY THIS EXISTS ALONGSIDE THE CONTRACT AND THE CHECK — three defences
 * that are not redundant, because they cover three different callers:
 *
 *   `masteryScoreSchema`  rejects an out-of-range value that arrived over
 *                         HTTP. A caller sending 1.4 has a BUG, and clamping
 *                         it would hide the bug behind a plausible 1.0.
 *   `clampMastery`        clamps a value the system COMPUTED. Here 1.0000001
 *                         is not a bug, it is floating-point arithmetic, and
 *                         refusing it would fail a student's submission over
 *                         a rounding artefact.
 *   the CHECK constraint  is the backstop that turns a clamping bug into a
 *                         loud failure rather than a mastery of 1.4 sitting
 *                         in a parent report.
 *
 * Both, not either. Plan §8.2 asks only for "mastery clamps to 0..1"; the
 * split above is which caller gets which behaviour.
 *
 * A NON-FINITE INPUT THROWS rather than clamping. `NaN` is not a value at one
 * end of the range — it is the residue of a division by zero somewhere
 * upstream, most plausibly `correct / total` on a session with no questions.
 * Clamping it to 0 would record "this student knows nothing about this
 * chapter", which is a specific and wrong claim, and it would erase the
 * evidence of the arithmetic bug that produced it.
 */
export function clampMastery(value: number): number {
  if (!Number.isFinite(value)) {
    throw new ValidationError('Mastery must be a number between 0 and 1.', {
      message: `clampMastery received a non-finite value: ${String(value)}`,
    });
  }

  const bounded = Math.min(MASTERY_MAX, Math.max(MASTERY_MIN, value));
  return Math.round(bounded * MASTERY_SCALE) / MASTERY_SCALE;
}

/**
 * Renders mastery for the `numeric(4, 3)` column.
 *
 * A STRING, not a number. node-postgres serialises a JavaScript number through
 * its own float formatting, and `numeric` is precisely the type chosen to
 * avoid a float round trip — sending `0.1 + 0.2` as a number would hand
 * Postgres `0.30000000000000004` to round, which is the representation problem
 * the column type exists to escape.
 */
export function toMasteryColumn(value: number): string {
  return clampMastery(value).toFixed(MASTERY_DECIMALS);
}

/**
 * Reads mastery back out of the `numeric` column.
 *
 * node-postgres returns `numeric` as a STRING, deliberately and correctly:
 * numeric is arbitrary precision and a JavaScript number is not, so the driver
 * refuses to guess. Every read path therefore has to convert, and doing it in
 * one named function is what stops `Number(row.mastery_score)` appearing in
 * three repositories with one of them forgetting.
 */
export function fromMasteryColumn(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError('Stored mastery is not a number.', {
      message: `fromMasteryColumn could not parse: ${String(value)}`,
    });
  }
  return parsed;
}

/**
 * REFUSES AN ATTEMPT INCREMENT THAT WOULD MOVE THE COUNTER BACKWARDS.
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE, EXPORTED FUNCTION AND NOT A LINE INSIDE
 * `nextAttemptCount` — D-243.
 *
 * `nextAttemptCount` is the pure arithmetic and it has ALWAYS rejected a
 * negative increment. It was never called on the write path. The write path is
 * `learner.service.updateMastery` -> `repository.upsertMastery`, which
 * increments IN SQL (`attempts + $n`) precisely so that two concurrent writers
 * cannot lose the update — and SQL will happily add a negative number.
 *
 * WHAT THE DATABASE ACTUALLY DOES, MEASURED RATHER THAN ASSUMED. An earlier
 * draft of this note claimed the `chapter_mastery_attempts_check` CHECK
 * (`attempts >= 0`) does not close the hole, on the reasoning that it fires
 * only when the RESULT goes below zero — so `attempts = 7` with an increment of
 * `-3` would land 4 and be accepted. THAT IS FALSE FOR THIS STATEMENT, and the
 * probe is one line:
 *
 *     insert into t (..., attempts) values (..., -3)
 *       on conflict (...) do update set attempts = t.attempts + -3;
 *     -- ERROR: new row violates check constraint
 *     -- DETAIL: Failing row contains (1, 1, -3).
 *
 * Postgres evaluates a CHECK when it FORMS the tuple, before it detects the
 * conflict, and `upsertMastery` puts the raw increment in the INSERT's VALUES.
 * So a negative increment trips the constraint every time, whatever the stored
 * count is.
 *
 * WHICH LEAVES A REAL, SMALLER REASON — and it is worth stating precisely,
 * because a guard justified by a gap that does not exist is a guard the next
 * reader deletes:
 *
 *   1. WITHOUT this, the failure is an unhandled driver error escaping the
 *      repository — a 500 naming an internal constraint. WITH it, the caller
 *      gets a named `ValidationError`, which is a 400 that says what was wrong.
 *      "Attempts cannot go backwards" is a fact about the domain, and the
 *      domain is where it should be stated.
 *   2. The constraint's protection is INCIDENTAL TO THE STATEMENT'S SHAPE. It
 *      holds because the increment happens to travel in the INSERT's VALUES;
 *      rewrite `upsertMastery` as a plain UPDATE — a perfectly reasonable
 *      change once every row is guaranteed to exist — and `7 + (-3) = 4`
 *      really would be accepted, silently, with the evidence label a parent
 *      reads computed from the smaller count.
 *
 * So the refusal lives HERE, at the domain boundary, where every caller of
 * `updateMastery` passes through it whether or not the row already exists and
 * whatever shape the statement underneath it takes.
 * ===========================================================================
 *
 * Returns the increment so it can be used inline at a call site, which is what
 * makes "the value that was validated is the value that was written" true by
 * construction rather than by two adjacent statements agreeing.
 */
export function assertAttemptIncrement(increment: number): number {
  if (!Number.isInteger(increment) || increment < 0) {
    throw new ValidationError('An attempt increment cannot be negative.', {
      message: `assertAttemptIncrement received increment=${String(increment)}`,
    });
  }
  return increment;
}

/**
 * The attempt counter after one more attempt.
 *
 * Trivial, and named anyway: it is the one place that decides whether an
 * attempt count can go backwards. It cannot. A caller passing a negative
 * current count is a corrupted read, not a request to decrement.
 */
export function nextAttemptCount(current: number, increment = 1): number {
  if (!Number.isInteger(current) || current < 0) {
    throw new ValidationError('Attempts must be a non-negative whole number.', {
      message: `nextAttemptCount received current=${String(current)}`,
    });
  }
  return current + assertAttemptIncrement(increment);
}
