import { describe, expect, it } from 'vitest';
import { MIN_CREDIBLE_ANSWER_MS, TIME_TARGET_MS } from '../time-targets';
import { classifyAnswer, pickRungWithFallback, rungAfter, startingRung } from '../difficulty-ladder';

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

describe('startingRung', () => {
  it('starts a student who has shown nothing on easy', () => {
    expect(startingRung(null)).toBe('easy');
    expect(startingRung('not_assessed')).toBe('easy');
    expect(startingRung('needs_another_session')).toBe('easy');
  });

  it('meets a developing student in the middle and a strong one at the top', () => {
    expect(startingRung('developing')).toBe('medium');
    expect(startingRung('strong')).toBe('hard');
  });
});

describe('rungAfter', () => {
  it('holds the starting rung when nothing has been answered', () => {
    expect(rungAfter('medium', [])).toBe('medium');
  });

  it('steps up after two consecutive qualifying answers, not one', () => {
    expect(rungAfter('easy', ['qualifying'])).toBe('easy');
    expect(rungAfter('easy', ['qualifying', 'qualifying'])).toBe('medium');
  });

  it('needs two more to step again, because the streak resets on a step', () => {
    expect(rungAfter('easy', ['qualifying', 'qualifying', 'qualifying'])).toBe('medium');
    expect(rungAfter('easy', ['qualifying', 'qualifying', 'qualifying', 'qualifying']))
      .toBe('hard');
  });

  it('steps down on a single wrong answer, from anywhere', () => {
    expect(rungAfter('hard', ['wrong'])).toBe('medium');
    expect(rungAfter('medium', ['wrong'])).toBe('easy');
  });

  it('breaks a qualifying streak with a wrong answer', () => {
    expect(rungAfter('medium', ['qualifying', 'wrong', 'qualifying'])).toBe('easy');
  });

  it('steps down after two consecutive slow answers, not one', () => {
    expect(rungAfter('hard', ['slow'])).toBe('hard');
    expect(rungAfter('hard', ['slow', 'slow'])).toBe('medium');
  });

  it('does not step down for slow answers that are not consecutive', () => {
    expect(rungAfter('hard', ['slow', 'qualifying', 'slow'])).toBe('hard');
  });

  it('clamps at both ends', () => {
    expect(rungAfter('hard', ['qualifying', 'qualifying'])).toBe('hard');
    expect(rungAfter('easy', ['wrong', 'wrong', 'wrong'])).toBe('easy');
  });

  it('lets a discounted answer move nothing and break nothing', () => {
    // Under three seconds: no evidence either way. It must not step the ladder,
    // and it must not destroy a streak the student legitimately built.
    expect(rungAfter('easy', ['qualifying', 'discounted', 'qualifying'])).toBe('medium');
    expect(rungAfter('medium', ['discounted', 'discounted', 'discounted'])).toBe('medium');
  });

  it('is a total function of the sequence, so replaying gives the same answer', () => {
    const classes = ['qualifying', 'qualifying', 'wrong', 'slow', 'slow'] as const;
    expect(rungAfter('easy', classes)).toBe(rungAfter('easy', classes));
    expect(rungAfter('easy', classes)).toBe('easy');
  });
});

describe('pickRungWithFallback', () => {
  it('takes what was asked for when it is there', () => {
    expect(pickRungWithFallback('medium', new Set(['easy', 'medium', 'hard']))).toBe('medium');
  });

  it('falls to the nearest rung when the chapter has none of the wanted one', () => {
    expect(pickRungWithFallback('hard', new Set(['easy', 'medium']))).toBe('medium');
    expect(pickRungWithFallback('easy', new Set(['medium', 'hard']))).toBe('medium');
    expect(pickRungWithFallback('medium', new Set(['hard']))).toBe('hard');
  });

  /*
   * THE EQUIDISTANT TIE, PINNED. `easy` and `hard` are both one rung from
   * `medium`, so nothing about "nearest" decides between them — the stable
   * sort over `ORDER` does, and it takes the EASIER one. That is the kinder
   * choice for a student and it is a real decision, not an accident of the
   * comparator: a sort that reversed equal keys would silently start serving
   * `hard` to a student the ladder had placed at `medium`.
   */
  it('takes the easier rung when two are equidistant', () => {
    expect(pickRungWithFallback('medium', new Set(['easy', 'hard']))).toBe('easy');
  });

  it('says so plainly when the chapter has nothing left', () => {
    expect(pickRungWithFallback('medium', new Set())).toBeNull();
  });
});
