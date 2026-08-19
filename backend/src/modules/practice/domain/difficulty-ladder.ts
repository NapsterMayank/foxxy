import { MIN_CREDIBLE_ANSWER_MS } from './time-targets';

/**
 * THE LADDER — pure. No clock, no I/O, no randomness.
 *
 * Two questions answered correctly and inside their target step the difficulty
 * up; a wrong answer steps it down at once; two slow-but-correct answers step
 * it down, because a student who is right and labouring is not helped by
 * something harder.
 */

export type AnswerClass = 'qualifying' | 'slow' | 'wrong' | 'discounted';

export function classifyAnswer(input: {
  readonly isCorrect: boolean;
  readonly timeSpentMs: number;
  readonly targetMs: number;
}): AnswerClass {
  /*
   * THE FLOOR IS TESTED FIRST, and before correctness. An answer given in
   * under three seconds tells us nothing about whether the student knew it —
   * including when it is right.
   */
  if (input.timeSpentMs < MIN_CREDIBLE_ANSWER_MS) return 'discounted';
  if (!input.isCorrect) return 'wrong';
  return input.timeSpentMs <= input.targetMs ? 'qualifying' : 'slow';
}
