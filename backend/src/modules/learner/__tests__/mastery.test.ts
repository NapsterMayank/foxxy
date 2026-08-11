import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/platform/errors/index';
import {
  MASTERY_DECIMALS,
  MASTERY_MAX,
  MASTERY_MIN,
  assertAttemptIncrement,
  clampMastery,
  fromMasteryColumn,
  nextAttemptCount,
  toMasteryColumn,
} from '../domain/mastery';

/**
 * Domain tests — pure functions, no database, no clock. Milliseconds.
 *
 * The checklist in §9.3 applied to a clamp means: the happy path, BOTH ends of
 * the range, one value past each end, and every error path. All of them are
 * below, because "mastery clamps to 0..1" (§8.2) is a boundary rule and a
 * boundary rule tested only in the middle is not tested.
 */

describe('clampMastery — §8.2, "mastery clamps to 0..1"', () => {
  it('passes a mid-range value through unchanged', () => {
    expect(clampMastery(0.42)).toBe(0.42);
  });

  it('accepts exactly 0, the lower bound', () => {
    expect(clampMastery(MASTERY_MIN)).toBe(0);
  });

  it('accepts exactly 1, the upper bound', () => {
    expect(clampMastery(MASTERY_MAX)).toBe(1);
  });

  it('clamps a value below 0 up to 0', () => {
    expect(clampMastery(-0.3)).toBe(0);
  });

  it('clamps a value above 1 down to 1', () => {
    expect(clampMastery(1.4)).toBe(1);
  });

  it('clamps a hair past the upper bound — the case this exists for', () => {
    // Not a caller bug: this is what `0.1 + 0.2`-shaped arithmetic produces.
    // Refusing it would fail a student's submission over a rounding artefact,
    // which is why the HTTP schema rejects out-of-range values and this
    // function clamps them. Different callers, different answers.
    expect(clampMastery(1.0000000001)).toBe(1);
  });

  it('rounds to the column’s three decimal places', () => {
    // `numeric(4, 3)`. Rounding here rather than letting Postgres do it keeps
    // the value the module believes it wrote identical to the value stored.
    expect(clampMastery(0.123456)).toBe(0.123);
    expect(clampMastery(0.9999)).toBe(1);
    expect(MASTERY_DECIMALS).toBe(3);
  });

  it('rounds half away from zero, not toward it', () => {
    expect(clampMastery(0.0005)).toBe(0.001);
  });

  it('throws on NaN rather than clamping it to 0', () => {
    // NaN is not a value at one end of the range — it is the residue of a
    // division by zero upstream, most plausibly `correct / total` on a session
    // with no questions. Clamping it to 0 would record "this student knows
    // nothing about this chapter", which is a specific and wrong claim, and it
    // would erase the evidence of the arithmetic bug that produced it.
    expect(() => clampMastery(Number.NaN)).toThrow(ValidationError);
  });

  it('throws on Infinity', () => {
    expect(() => clampMastery(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
    expect(() => clampMastery(Number.NEGATIVE_INFINITY)).toThrow(ValidationError);
  });

  it('tells the client nothing about the value it received', () => {
    // The safe message is generic; the offending value appears only in the
    // log-side message. §11: no personal or internal data in a client payload.
    try {
      clampMastery(Number.NaN);
      expect.unreachable('clampMastery accepted NaN');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).safeMessage).toBe(
        'Mastery must be a number between 0 and 1.',
      );
    }
  });
});

describe('toMasteryColumn', () => {
  it('renders a fixed three-decimal STRING, not a number', () => {
    // A string, because node-postgres would serialise a JavaScript number
    // through float formatting — handing `numeric` the very representation
    // problem the column type was chosen to escape.
    expect(toMasteryColumn(0.5)).toBe('0.500');
    expect(typeof toMasteryColumn(0.5)).toBe('string');
  });

  it('clamps before rendering', () => {
    expect(toMasteryColumn(2)).toBe('1.000');
    expect(toMasteryColumn(-1)).toBe('0.000');
  });

  it('survives the classic floating-point sum', () => {
    expect(toMasteryColumn(0.1 + 0.2)).toBe('0.300');
  });
});

describe('fromMasteryColumn', () => {
  it('parses the string node-postgres returns for a numeric column', () => {
    expect(fromMasteryColumn('0.750')).toBe(0.75);
  });

  it('accepts a number too, in case a driver setting changes', () => {
    expect(fromMasteryColumn(0.75)).toBe(0.75);
  });

  it('throws rather than yielding NaN for an unparseable value', () => {
    // `Number('abc')` is NaN, and a NaN mastery flowing into a parent report
    // renders as "NaN%". Failing here names the real problem.
    expect(() => fromMasteryColumn('not-a-number')).toThrow(ValidationError);
  });
});

describe('nextAttemptCount', () => {
  it('adds one by default', () => {
    expect(nextAttemptCount(3)).toBe(4);
  });

  it('accepts an explicit increment', () => {
    expect(nextAttemptCount(3, 5)).toBe(8);
  });

  it('accepts an increment of zero — a mastery correction is not an attempt', () => {
    expect(nextAttemptCount(3, 0)).toBe(3);
  });

  it('starts from zero', () => {
    expect(nextAttemptCount(0)).toBe(1);
  });

  it('refuses a negative current count, which can only be a corrupted read', () => {
    expect(() => nextAttemptCount(-1)).toThrow(ValidationError);
  });

  it('refuses a fractional current count', () => {
    expect(() => nextAttemptCount(1.5)).toThrow(ValidationError);
  });

  it('refuses a negative increment — attempts never go backwards', () => {
    expect(() => nextAttemptCount(3, -1)).toThrow(ValidationError);
  });

  it('refuses a fractional increment', () => {
    expect(() => nextAttemptCount(3, 0.5)).toThrow(ValidationError);
  });
});

/**
 * ===========================================================================
 * D-243 — the guard that is ACTUALLY ON THE WRITE PATH.
 *
 * Everything in `nextAttemptCount` above has always refused a negative
 * increment, and none of it ever ran on a write: `upsertMastery` increments in
 * SQL (`attempts + $n`) precisely so two concurrent writers cannot lose the
 * update, and SQL adds a negative number without complaint.
 *
 * Nor does the CHECK constraint close it — `attempts >= 0` only fires when the
 * RESULT would go below zero, so `attempts = 7` with an increment of `-3` lands
 * 4 and satisfies the constraint. A validation that catches one case in seven
 * is the worst kind, because it looks installed.
 *
 * `assertAttemptIncrement` is what `learner.service.updateMastery` calls, and
 * these are its tests. The service-level proof that it is really wired in lives
 * in `learner.write-path.test.ts` against a real database.
 * ===========================================================================
 */
describe('assertAttemptIncrement — D-243, the attempt counter is monotonic', () => {
  it('returns a positive increment unchanged, so it can be used inline', () => {
    expect(assertAttemptIncrement(1)).toBe(1);
    expect(assertAttemptIncrement(4)).toBe(4);
  });

  it('accepts zero — a mastery correction is not an attempt', () => {
    expect(assertAttemptIncrement(0)).toBe(0);
  });

  it('REFUSES -1, the increment the CHECK constraint would have accepted', () => {
    expect(() => assertAttemptIncrement(-1)).toThrow(ValidationError);
  });

  it('refuses a large negative increment', () => {
    expect(() => assertAttemptIncrement(-3)).toThrow(ValidationError);
  });

  it('refuses a fractional increment — `attempts` is an integer column', () => {
    expect(() => assertAttemptIncrement(0.5)).toThrow(ValidationError);
  });

  it('refuses NaN and Infinity rather than letting them reach SQL', () => {
    expect(() => assertAttemptIncrement(Number.NaN)).toThrow(ValidationError);
    expect(() => assertAttemptIncrement(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
  });
});
