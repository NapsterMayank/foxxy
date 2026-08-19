import { describe, expect, it } from 'vitest';
import { MIN_CREDIBLE_ANSWER_MS, TIME_TARGET_MS } from '../time-targets';
import { classifyAnswer } from '../difficulty-ladder';

describe('TIME_TARGET_MS', () => {
  it('rises with difficulty and is stated in milliseconds', () => {
    expect(TIME_TARGET_MS.easy).toBe(30_000);
    expect(TIME_TARGET_MS.medium).toBe(45_000);
    expect(TIME_TARGET_MS.hard).toBe(60_000);
  });
});

describe('classifyAnswer', () => {
  const target = 45_000;

  it('counts a correct answer inside the target as qualifying', () => {
    expect(classifyAnswer({ isCorrect: true, timeSpentMs: 20_000, targetMs: target }))
      .toBe('qualifying');
  });

  it('treats exactly the target as inside it', () => {
    // A boundary a student cannot perceive must not decide anything against them.
    expect(classifyAnswer({ isCorrect: true, timeSpentMs: target, targetMs: target }))
      .toBe('qualifying');
  });

  it('counts a correct answer one millisecond over as slow', () => {
    expect(classifyAnswer({ isCorrect: true, timeSpentMs: target + 1, targetMs: target }))
      .toBe('slow');
  });

  it('counts any incorrect answer as wrong, however fast', () => {
    expect(classifyAnswer({ isCorrect: false, timeSpentMs: 90_000, targetMs: target }))
      .toBe('wrong');
    expect(classifyAnswer({ isCorrect: false, timeSpentMs: 10_000, targetMs: target }))
      .toBe('wrong');
  });

  it('discounts anything under the credible floor, right or wrong', () => {
    // The anti-cheat rule zeroes an attempt averaging under three seconds a
    // question. Rewarding speed below that line would teach students to
    // invalidate their own sessions.
    expect(classifyAnswer({ isCorrect: true, timeSpentMs: 2_999, targetMs: target }))
      .toBe('discounted');
    expect(classifyAnswer({ isCorrect: false, timeSpentMs: 0, targetMs: target }))
      .toBe('discounted');
  });

  it('treats exactly the floor as credible', () => {
    expect(classifyAnswer({ isCorrect: true, timeSpentMs: MIN_CREDIBLE_ANSWER_MS, targetMs: target }))
      .toBe('qualifying');
  });
});
