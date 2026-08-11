import { describe, expect, it } from 'vitest';
import { deriveAnswerChange, type PriorSelection } from '../domain/answer-change';

/**
 * D-282 — `first_selected_index` and `answer_changed`, derived from what the
 * SERVER recorded.
 *
 * These two columns cannot be backfilled: a student who wavered in September
 * leaves no trace of it unless the value was written in September. They were
 * populated from an optional request field, and an audit of an honest journey
 * found them null on five of six responses.
 *
 * The carry-forward cases below are unreachable through HTTP while D-281's
 * immutability rule stands. They are tested anyway — they are the half of the
 * fix that survives if that rule is ever relaxed, and an untested branch is a
 * branch that is wrong the day it starts running.
 */

function prior(selectedIndex: number, firstSelectedIndex: number | null): PriorSelection {
  return { selectedIndex, firstSelectedIndex };
}

describe('deriveAnswerChange — a first answer', () => {
  it('records the selection AS the first choice, never null', () => {
    expect(deriveAnswerChange(undefined, 2)).toEqual({
      firstSelectedIndex: 2,
      answerChanged: false,
    });
  });

  it('never reports a change when there is nothing to have changed from', () => {
    for (const index of [0, 1, 2, 3]) {
      expect(deriveAnswerChange(undefined, index).answerChanged).toBe(false);
      expect(deriveAnswerChange(undefined, index).firstSelectedIndex).toBe(index);
    }
  });
});

describe('deriveAnswerChange — a re-answer preserves the ORIGINAL index', () => {
  it('keeps the first choice and reports the change', () => {
    // The exploit's shape: answered 3, told the answer was 1, answers 1.
    expect(deriveAnswerChange(prior(3, 3), 1)).toEqual({
      firstSelectedIndex: 3,
      answerChanged: true,
    });
  });

  it('carries the FIRST choice forward across a third answer, not the second', () => {
    // Reading `prior.selectedIndex` here instead of `prior.firstSelectedIndex`
    // would report 1 — the position they moved to after the reveal — and the
    // diagnosis the column exists for would be gone, plausibly.
    const second = deriveAnswerChange(prior(3, 3), 1);
    const third = deriveAnswerChange(prior(1, second.firstSelectedIndex), 0);

    expect(third.firstSelectedIndex).toBe(3);
    expect(third.answerChanged).toBe(true);
  });

  it('reports NO change when a re-answer lands back on the original choice', () => {
    expect(deriveAnswerChange(prior(1, 3), 3)).toEqual({
      firstSelectedIndex: 3,
      answerChanged: false,
    });
  });

  it('seeds from the prior selection when the prior row predates this column', () => {
    // A session already in flight when D-282 landed holds answers with a null
    // first choice. The best available seed is what that row selected — not
    // null, which would be a fabricated "we do not know" about an answer the
    // server itself recorded.
    expect(deriveAnswerChange(prior(2, null), 0)).toEqual({
      firstSelectedIndex: 2,
      answerChanged: true,
    });
  });
});

describe('deriveAnswerChange — rejects impossible input', () => {
  it('rejects a negative selection', () => {
    expect(() => deriveAnswerChange(undefined, -1)).toThrow(RangeError);
  });

  it('rejects a fractional selection', () => {
    expect(() => deriveAnswerChange(undefined, 1.5)).toThrow(RangeError);
  });

  it('rejects a prior row whose carried index is impossible', () => {
    expect(() => deriveAnswerChange(prior(-1, null), 0)).toThrow(RangeError);
  });
});
