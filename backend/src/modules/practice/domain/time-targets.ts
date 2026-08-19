import type { Difficulty } from '@/shared/constants/curriculum';

/**
 * HOW LONG A QUESTION OF EACH DIFFICULTY IS EXPECTED TO TAKE.
 *
 * TARGETS, NOT LIMITS. Nothing is cut off, nothing is scored down for being
 * slow, and no countdown is ever shown. The number decides what the student is
 * asked NEXT; it never decides what this answer was worth.
 *
 * Tuning these is an edit, never a migration — `practice_responses.time_target_ms`
 * freezes the value that was in force onto each answer, so a change here cannot
 * rewrite what "fast" meant for answers already recorded.
 */
export const TIME_TARGET_MS: Readonly<Record<Difficulty, number>> = {
  easy: 30_000,
  medium: 45_000,
  hard: 60_000,
};

/**
 * Below this, an answer is not evidence of anything.
 *
 * `anti-cheat.ts` scores an attempt ZERO when its average falls under three
 * seconds a question. A ladder that rewarded speed without this floor would
 * push a student toward the exact behaviour that invalidates their own session.
 * Answers under it are recorded and counted; they simply move nothing.
 */
export const MIN_CREDIBLE_ANSWER_MS = 3_000;
