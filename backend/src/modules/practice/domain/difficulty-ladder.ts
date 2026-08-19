import { MIN_CREDIBLE_ANSWER_MS } from './time-targets';
import type { Difficulty } from '@/shared/constants/curriculum';
import type { EvidenceLabel } from '@/shared/constants/practice';

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

export type Rung = Difficulty;

const ORDER: readonly Rung[] = ['easy', 'medium', 'hard'];

/** How many in a row each direction needs. Up is earned; down is protective. */
const QUALIFYING_TO_STEP_UP = 2;
const SLOW_TO_STEP_DOWN = 2;

const STEP_UP: Record<Rung, Rung> = {
  easy: 'medium',
  medium: 'hard',
  hard: 'hard',
};

const STEP_DOWN: Record<Rung, Rung> = {
  easy: 'easy',
  medium: 'easy',
  hard: 'medium',
};

function step(rung: Rung, direction: 1 | -1): Rung {
  return direction === 1 ? STEP_UP[rung] : STEP_DOWN[rung];
}

/**
 * Where a student meets a chapter, from the evidence already on record.
 *
 * `null` is a student with no mastery row at all — a first session — and gets
 * the same answer as `not_assessed`: start where nobody can fail on arrival.
 */
export function startingRung(evidence: EvidenceLabel | null): Rung {
  if (evidence === 'strong') return 'hard';
  if (evidence === 'developing') return 'medium';
  return 'easy';
}

/**
 * REPLAYS the session's answers into a rung.
 *
 * Called with every answer so far, in order, on every question served. That is
 * deliberate and it is why there is no `current_rung` column: a stored rung is
 * a second source of truth that can drift from the rows, and the rows are the
 * evidence. The same rule keeps XP a SUM over the ledger rather than a counter.
 */
export function rungAfter(startingAt: Rung, classes: readonly AnswerClass[]): Rung {
  let rung = startingAt;
  let qualifying = 0;
  let slow = 0;

  for (const answerClass of classes) {
    // No evidence: no movement, and no damage to a streak already earned.
    if (answerClass === 'discounted') continue;

    if (answerClass === 'wrong') {
      rung = step(rung, -1);
      qualifying = 0;
      slow = 0;
      continue;
    }

    if (answerClass === 'qualifying') {
      slow = 0;
      qualifying += 1;
      if (qualifying >= QUALIFYING_TO_STEP_UP) {
        rung = step(rung, 1);
        qualifying = 0;
      }
      continue;
    }

    qualifying = 0;
    slow += 1;
    if (slow >= SLOW_TO_STEP_DOWN) {
      rung = step(rung, -1);
      slow = 0;
    }
  }

  return rung;
}

/**
 * The rung to actually draw from, given what the chapter still has unserved.
 *
 * NEAREST FIRST, and it returns the rung rather than moving the ladder: six
 * chapters in the corpus have no `hard` or no `easy`, and a content gap must
 * never be recorded as a judgement about the student.
 */
export function pickRungWithFallback(wanted: Rung, available: ReadonlySet<Rung>): Rung | null {
  if (available.has(wanted)) return wanted;

  const wantedAt = ORDER.indexOf(wanted);
  const candidates: { rung: Rung; distance: number }[] = [];

  for (const rung of ORDER) {
    if (available.has(rung)) {
      candidates.push({
        rung,
        distance: Math.abs(ORDER.indexOf(rung) - wantedAt),
      });
    }
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.at(0)?.rung ?? null;
}
