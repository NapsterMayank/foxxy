import { describe, expect, it } from 'vitest';
import {
  MIN_AVERAGE_MS_PER_QUESTION,
  SAME_ANSWER_MIN_QUESTIONS,
  validateAttempt,
  type AttemptResponse,
} from '../domain/anti-cheat';

/**
 * §8.6: "each anti-cheat rule both passing and failing · exactly 3 identical
 * answers is allowed, 4 is not".
 *
 * Each of the three rules gets a pass case, a fail case and — for the two with
 * thresholds — the exact boundary on both sides. A threshold tested only from
 * one side is a threshold that can be off by one forever.
 */

function response(selectedIndex: number, timeSpentMs: number): AttemptResponse {
  return { selectedIndex, timeSpentMs };
}

/** n varied answers, each comfortably above the time floor. */
function honest(count: number): AttemptResponse[] {
  return Array.from({ length: count }, (_unused, index) =>
    response(index % 4, MIN_AVERAGE_MS_PER_QUESTION * 2),
  );
}

describe('validateAttempt — rule 3: response count equals question count', () => {
  it('accepts an attempt with one response per question', () => {
    expect(validateAttempt(honest(5), 5)).toEqual({ isValid: true });
  });

  it('rejects too few responses', () => {
    expect(validateAttempt(honest(4), 5)).toEqual({
      isValid: false,
      reason: 'response_count_mismatch',
    });
  });

  it('rejects too many responses', () => {
    expect(validateAttempt(honest(6), 5)).toEqual({
      isValid: false,
      reason: 'response_count_mismatch',
    });
  });

  it('is checked FIRST, so a mismatched set is never judged on its timing', () => {
    // Every response here is instant AND identical, so both other rules would
    // also fire. The count rule has to win: an average over the wrong set is a
    // number about nothing, and reporting "too fast" would send a support agent
    // to the wrong question entirely.
    const responses = [response(0, 0), response(0, 0)];
    expect(validateAttempt(responses, 10)).toEqual({
      isValid: false,
      reason: 'response_count_mismatch',
    });
  });
});

describe('validateAttempt — rule 1: at least 3 seconds average per question', () => {
  it('accepts an attempt exactly AT the floor', () => {
    const responses = [
      response(0, MIN_AVERAGE_MS_PER_QUESTION),
      response(1, MIN_AVERAGE_MS_PER_QUESTION),
    ];
    expect(validateAttempt(responses, 2)).toEqual({ isValid: true });
  });

  it('rejects an attempt one millisecond below the floor', () => {
    const responses = [
      response(0, MIN_AVERAGE_MS_PER_QUESTION),
      response(1, MIN_AVERAGE_MS_PER_QUESTION - 2),
    ];
    expect(validateAttempt(responses, 2)).toEqual({ isValid: false, reason: 'too_fast' });
  });

  it('is an AVERAGE, so one quick answer among slow ones is fine', () => {
    // A student who reads the whole set first and then answers the last one
    // quickly is not cheating. A per-question floor would refuse them.
    const responses = [
      response(0, MIN_AVERAGE_MS_PER_QUESTION * 5),
      response(1, MIN_AVERAGE_MS_PER_QUESTION * 5),
      response(2, 200),
    ];
    expect(validateAttempt(responses, 3)).toEqual({ isValid: true });
  });

  it('rejects a whole attempt answered instantly', () => {
    const responses = [response(0, 0), response(1, 0), response(2, 0)];
    expect(validateAttempt(responses, 3)).toEqual({ isValid: false, reason: 'too_fast' });
  });
});

describe('validateAttempt — rule 2: not every answer the same index', () => {
  function allSame(count: number): AttemptResponse[] {
    return Array.from({ length: count }, () => response(2, MIN_AVERAGE_MS_PER_QUESTION * 2));
  }

  it('ALLOWS exactly 3 identical answers', () => {
    // With three four-option questions, all-the-same happens by chance about
    // once in sixteen honest attempts. A rule that fails one honest student in
    // sixteen is a rule that gets switched off.
    expect(validateAttempt(allSame(SAME_ANSWER_MIN_QUESTIONS), SAME_ANSWER_MIN_QUESTIONS)).toEqual({
      isValid: true,
    });
  });

  it('REJECTS 4 identical answers', () => {
    const count = SAME_ANSWER_MIN_QUESTIONS + 1;
    expect(validateAttempt(allSame(count), count)).toEqual({
      isValid: false,
      reason: 'all_same_answer',
    });
  });

  it('allows 4 answers where one differs', () => {
    const responses = allSame(4);
    responses[3] = response(0, MIN_AVERAGE_MS_PER_QUESTION * 2);
    expect(validateAttempt(responses, 4)).toEqual({ isValid: true });
  });

  it('allows 1 and 2 identical answers', () => {
    expect(validateAttempt(allSame(1), 1)).toEqual({ isValid: true });
    expect(validateAttempt(allSame(2), 2)).toEqual({ isValid: true });
  });
});

describe('validateAttempt — edges', () => {
  it('treats an empty attempt as vacuously valid rather than as a cheat', () => {
    // It scores zero on its own merits. Calling it a cheat would put an
    // accusation on a session where nothing happened.
    expect(validateAttempt([], 0)).toEqual({ isValid: true });
  });

  it('rejects a negative question count', () => {
    expect(() => validateAttempt([], -1)).toThrow(RangeError);
  });

  it('rejects a fractional question count', () => {
    expect(() => validateAttempt([], 2.5)).toThrow(RangeError);
  });
});
