import { describe, expect, it } from 'vitest';
import { FixedClock } from '@/platform/clock/index';
import {
  INITIAL_RETENTION,
  PASSING_QUALITY,
  RETENTION,
  isDue,
  scheduleNextReview,
  scoreToQuality,
  type RetentionState,
} from '../domain/spaced-retention';

/**
 * "spaced-retention intervals on the injected clock."
 *
 * EVERY instant below comes from a `FixedClock`. There is no `new Date()` and
 * no `sleep` — §9.5 bans both, and a scheduler is precisely the kind of code
 * where a test that waits is a test that is slow AND flaky, because the thing
 * it is waiting for is a day away.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function clockAt(instant: string): FixedClock {
  return new FixedClock(instant);
}

describe('scoreToQuality', () => {
  it('maps 100 to the top quality', () => {
    expect(scoreToQuality(100)).toBe(5);
  });

  it('maps 0 to the bottom quality', () => {
    expect(scoreToQuality(0)).toBe(0);
  });

  it('maps 60 to the pass mark', () => {
    expect(scoreToQuality(60)).toBe(PASSING_QUALITY);
  });

  it('maps 50 below the pass mark', () => {
    // 50/20 = 2.5, which rounds to 3 under Math.round — assert the actual
    // boundary rather than the one that feels right.
    expect(scoreToQuality(50)).toBe(3);
    expect(scoreToQuality(49)).toBe(2);
  });

  it('rejects a score outside 0..100', () => {
    expect(() => scoreToQuality(101)).toThrow(RangeError);
    expect(() => scoreToQuality(-1)).toThrow(RangeError);
  });
});

describe('scheduleNextReview — the SM-2 ladder, on the injected clock', () => {
  const clock = clockAt('2026-06-01T09:00:00.000Z');

  it('sends a first success to tomorrow', () => {
    const schedule = scheduleNextReview(INITIAL_RETENTION, 100, clock.now());
    expect(schedule.repetitions).toBe(1);
    expect(schedule.intervalDays).toBe(RETENTION.firstIntervalDays);
    expect(schedule.dueAt.toISOString()).toBe('2026-06-02T09:00:00.000Z');
  });

  it('sends a second success six days out', () => {
    const first = scheduleNextReview(INITIAL_RETENTION, 100, clock.now());
    const second = scheduleNextReview(first, 100, clock.now());
    expect(second.repetitions).toBe(2);
    expect(second.intervalDays).toBe(RETENTION.secondIntervalDays);
    expect(second.dueAt.toISOString()).toBe('2026-06-07T09:00:00.000Z');
  });

  it('multiplies by the ease factor from the third success onwards', () => {
    const state: RetentionState = { intervalDays: 6, easeFactor: 2.6, repetitions: 2 };
    const third = scheduleNextReview(state, 100, clock.now());
    // ease rises to 2.7 at quality 5, so 6 * 2.7 = 16.2 -> 16.
    expect(third.easeFactor).toBe(2.7);
    expect(third.intervalDays).toBe(16);
    expect(third.dueAt.getTime() - clock.now().getTime()).toBe(16 * MS_PER_DAY);
  });

  it('advances the due date by exactly the interval, from the supplied instant', () => {
    const later = clockAt('2026-12-25T00:00:00.000Z');
    const schedule = scheduleNextReview(INITIAL_RETENTION, 100, later.now());
    expect(schedule.dueAt.toISOString()).toBe('2026-12-26T00:00:00.000Z');
    expect(schedule.lastReviewedAt.toISOString()).toBe('2026-12-25T00:00:00.000Z');
  });
});

describe('scheduleNextReview — a failed review', () => {
  const clock = clockAt('2026-06-01T09:00:00.000Z');

  it('sends a failure back to tomorrow and resets the repetition count', () => {
    const state: RetentionState = { intervalDays: 30, easeFactor: 2.5, repetitions: 5 };
    const schedule = scheduleNextReview(state, 20, clock.now());
    expect(schedule.repetitions).toBe(0);
    expect(schedule.intervalDays).toBe(RETENTION.relearnIntervalDays);
  });

  it('does NOT reduce the ease factor on failure', () => {
    // SM-2 as published, and deliberate: the quality-based adjustment already
    // handles a poor-but-passing answer, and compounding a reset on top of it
    // drives a struggling student to the floor after two bad days.
    const state: RetentionState = { intervalDays: 30, easeFactor: 2.5, repetitions: 5 };
    expect(scheduleNextReview(state, 20, clock.now()).easeFactor).toBe(2.5);
  });

  it('treats the pass mark as a pass and one below it as a failure', () => {
    const state: RetentionState = { intervalDays: 6, easeFactor: 2.5, repetitions: 2 };
    expect(scheduleNextReview(state, 60, clock.now()).repetitions).toBe(3);
    expect(scheduleNextReview(state, 40, clock.now()).repetitions).toBe(0);
  });
});

describe('scheduleNextReview — the ease floor', () => {
  const clock = clockAt('2026-06-01T09:00:00.000Z');

  it('never falls below the floor, however many barely-passing reviews', () => {
    let state: RetentionState = { ...INITIAL_RETENTION };
    for (let review = 0; review < 20; review += 1) {
      state = scheduleNextReview(state, 60, clock.now());
    }
    expect(state.easeFactor).toBe(RETENTION.minEase);
  });

  it('raises ease on a perfect review', () => {
    const state: RetentionState = { intervalDays: 6, easeFactor: 2.5, repetitions: 2 };
    expect(scheduleNextReview(state, 100, clock.now()).easeFactor).toBeGreaterThan(2.5);
  });

  it('leaves ease unchanged at quality 4', () => {
    const state: RetentionState = { intervalDays: 6, easeFactor: 2.5, repetitions: 2 };
    // 80% -> quality 4, where SM-2's adjustment is exactly zero.
    expect(scheduleNextReview(state, 80, clock.now()).easeFactor).toBe(2.5);
  });

  it('rounds ease to two decimals, matching the numeric(4,2) column', () => {
    // A difference of 0.004 between what the domain returns and what comes back
    // out of the column compounds across reviews into a different interval.
    const state: RetentionState = { intervalDays: 6, easeFactor: 2.5, repetitions: 2 };
    const ease = scheduleNextReview(state, 60, clock.now()).easeFactor;
    expect(Math.round(ease * 100) / 100).toBe(ease);
  });
});

describe('scheduleNextReview — rejects impossible state', () => {
  const now = clockAt('2026-06-01T09:00:00.000Z').now();

  it('rejects an ease factor below the floor', () => {
    expect(() => scheduleNextReview({ intervalDays: 1, easeFactor: 1, repetitions: 1 }, 90, now)).toThrow(
      RangeError,
    );
  });

  it('rejects negative repetitions', () => {
    expect(() =>
      scheduleNextReview({ intervalDays: 1, easeFactor: 2.5, repetitions: -1 }, 90, now),
    ).toThrow(RangeError);
  });

  it('rejects a fractional interval', () => {
    expect(() =>
      scheduleNextReview({ intervalDays: 1.5, easeFactor: 2.5, repetitions: 1 }, 90, now),
    ).toThrow(RangeError);
  });
});

describe('isDue — inclusive at the boundary', () => {
  const clock = clockAt('2026-06-01T09:00:00.000Z');

  it('is due at exactly the due instant', () => {
    expect(isDue(new Date('2026-06-01T09:00:00.000Z'), clock.now())).toBe(true);
  });

  it('is not due one millisecond earlier', () => {
    expect(isDue(new Date('2026-06-01T09:00:00.001Z'), clock.now())).toBe(false);
  });

  it('is due once the clock is advanced past it', () => {
    const due = new Date('2026-06-03T09:00:00.000Z');
    expect(isDue(due, clock.now())).toBe(false);
    clock.advanceDays(2);
    expect(isDue(due, clock.now())).toBe(true);
  });
});
