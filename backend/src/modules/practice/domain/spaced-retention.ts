/**
 * SPACED RETENTION — SM-2, pure, on the injected clock.
 *
 * 05-ROADMAP.md §6 scopes this as "full — FSRS or SM-2, pure functions on the
 * injected clock". SM-2 is chosen over FSRS for one reason: FSRS's parameters
 * are FITTED to a review history, and there is no review history yet. Shipping
 * FSRS with its published defaults would be SM-2 wearing a more impressive
 * name, plus seventeen constants nobody in this codebase can justify. SM-2's
 * three numbers can each be explained in a sentence, which is what makes the
 * schedule something a teacher can be shown.
 *
 * ===========================================================================
 * THE CLOCK IS AN ARGUMENT, NOT AN IMPORT. §2's layer table: a domain function
 * may not read the clock. Every function here takes `now` and returns absolute
 * instants computed from it, which is what makes "a 6-day interval is due on
 * the 6th day" a test that runs in a millisecond instead of one that sleeps.
 * ===========================================================================
 */

export const RETENTION = {
  /** SM-2's starting ease. The published value. */
  initialEase: 2.5,
  /**
   * The floor on ease. Below this the intervals collapse toward daily and the
   * schedule stops being spaced repetition and becomes a punishment.
   */
  minEase: 1.3,
  /** First successful review: come back tomorrow. */
  firstIntervalDays: 1,
  /** Second successful review: six days. Both are SM-2's published values. */
  secondIntervalDays: 6,
  /**
   * Where a failed review goes: tomorrow, and the repetition count resets.
   *
   * The ease factor is NOT reduced on failure, which is SM-2 as published and
   * is deliberate: the quality-based ease adjustment below already handles a
   * poor-but-passing answer, and compounding a reset on top of it drives a
   * struggling student to the floor after two bad days.
   */
  relearnIntervalDays: 1,
} as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The SM-2 state carried between reviews, as stored in `practice_retention`. */
export interface RetentionState {
  readonly intervalDays: number;
  readonly easeFactor: number;
  readonly repetitions: number;
}

export interface RetentionSchedule extends RetentionState {
  readonly dueAt: Date;
  readonly lastReviewedAt: Date;
}

/** The state a chapter starts in, before its first review. */
export const INITIAL_RETENTION: RetentionState = {
  intervalDays: 0,
  easeFactor: RETENTION.initialEase,
  repetitions: 0,
};

/**
 * Maps a session score to SM-2's 0..5 quality.
 *
 * A LINEAR MAP RATHER THAN A CURVE, so that the relationship between "what I
 * scored" and "when I see this again" is something a student can predict. 60%
 * is quality 3, which is SM-2's pass mark — and that lines up with the
 * `DEVELOPING_MASTERY` boundary in `evidence.ts` closely enough that a student
 * is never told "developing" and then made to relearn from scratch.
 */
export function scoreToQuality(scorePercent: number): number {
  if (!Number.isFinite(scorePercent) || scorePercent < 0 || scorePercent > 100) {
    throw new RangeError(
      `scoreToQuality: scorePercent must be between 0 and 100, received ${String(scorePercent)}.`,
    );
  }
  return Math.round(scorePercent / 20);
}

/** SM-2's pass mark. Below it the chapter is relearned rather than advanced. */
export const PASSING_QUALITY = 3;

/**
 * The next review, from the current state and this session's score.
 *
 * Deterministic and total: every input produces a schedule, and the same inputs
 * always produce the same schedule. There is no jitter — a scheduler that
 * randomises due dates cannot be reasoned about by the person it is scheduling.
 */
export function scheduleNextReview(
  state: RetentionState,
  scorePercent: number,
  now: Date,
): RetentionSchedule {
  assertState(state);

  const quality = scoreToQuality(scorePercent);

  if (quality < PASSING_QUALITY) {
    // FAILED. Back to tomorrow, repetitions reset, ease untouched.
    return {
      intervalDays: RETENTION.relearnIntervalDays,
      easeFactor: state.easeFactor,
      repetitions: 0,
      lastReviewedAt: new Date(now.getTime()),
      dueAt: addDays(now, RETENTION.relearnIntervalDays),
    };
  }

  const repetitions = state.repetitions + 1;
  const easeFactor = nextEase(state.easeFactor, quality);

  const intervalDays =
    repetitions === 1
      ? RETENTION.firstIntervalDays
      : repetitions === 2
        ? RETENTION.secondIntervalDays
        : Math.max(1, Math.round(state.intervalDays * easeFactor));

  return {
    intervalDays,
    easeFactor,
    repetitions,
    lastReviewedAt: new Date(now.getTime()),
    dueAt: addDays(now, intervalDays),
  };
}

/** Whether a scheduled chapter is due at `now`. Inclusive at the boundary. */
export function isDue(dueAt: Date, now: Date): boolean {
  return dueAt.getTime() <= now.getTime();
}

/**
 * SM-2's ease adjustment, floored.
 *
 *     EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
 *
 * At q=5 it rises by 0.1; at q=4 it is unchanged; at q=3 it falls by 0.14. The
 * floor is what stops a chapter a student keeps barely passing from spiralling
 * into a daily obligation.
 */
function nextEase(easeFactor: number, quality: number): number {
  const gap = 5 - quality;
  const adjusted = easeFactor + (0.1 - gap * (0.08 + gap * 0.02));
  // Rounded to two decimals to match `practice_retention.ease_factor`, which is
  // numeric(4,2). Rounding HERE rather than letting the column do it keeps the
  // value the domain returns identical to the value that comes back out — a
  // difference of 0.004 compounds across reviews into a different interval.
  return Math.max(RETENTION.minEase, Math.round(adjusted * 100) / 100);
}

function addDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * MS_PER_DAY);
}

function assertState(state: RetentionState): void {
  if (!Number.isInteger(state.intervalDays) || state.intervalDays < 0) {
    throw new RangeError(
      `scheduleNextReview: intervalDays must be a non-negative integer, received ${String(
        state.intervalDays,
      )}.`,
    );
  }
  if (!Number.isInteger(state.repetitions) || state.repetitions < 0) {
    throw new RangeError(
      `scheduleNextReview: repetitions must be a non-negative integer, received ${String(
        state.repetitions,
      )}.`,
    );
  }
  if (!Number.isFinite(state.easeFactor) || state.easeFactor < RETENTION.minEase) {
    throw new RangeError(
      `scheduleNextReview: easeFactor must be at least ${RETENTION.minEase}, received ${String(
        state.easeFactor,
      )}.`,
    );
  }
}
