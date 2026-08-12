import { describe, expect, it } from 'vitest';
import { weekKey, weekStartOf as notifyWeekStartOf } from '@/modules/notify/index';
import {
  DAYS_PER_WEEK,
  previousWeekStart,
  weekKeyOf,
  weekStartOf,
  weekWindowOf,
} from '../domain/week-window';

/**
 * The week boundary — and the pin that keeps it identical to notify's.
 *
 * §9.5: `now` is always an argument, so every date here is stated.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

describe('weekStartOf', () => {
  it('returns midnight UTC on Monday for a Monday', () => {
    // 2026-06-01 is a Monday.
    expect(weekStartOf(new Date('2026-06-01T09:30:00.000Z')).toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('returns the SAME Monday for the Sunday that ends the week', () => {
    // The failure this pins: `getUTCDay()` is 0 on Sunday, so a naive
    // `day - 1` moves every Sunday into the next week and makes one week eight
    // days long and the next six.
    expect(weekStartOf(new Date('2026-06-07T23:59:59.999Z')).toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('rolls over at exactly the next Monday midnight', () => {
    expect(weekStartOf(new Date('2026-06-08T00:00:00.000Z')).toISOString()).toBe(
      '2026-06-08T00:00:00.000Z',
    );
  });

  it('is idempotent — the start of a week start is the same week start', () => {
    const start = weekStartOf(new Date('2026-06-04T11:00:00.000Z'));
    expect(weekStartOf(start).toISOString()).toBe(start.toISOString());
  });

  it('crosses a year boundary without moving the week', () => {
    // 2027-01-01 is a Friday; its Monday is in the previous year.
    expect(weekStartOf(new Date('2027-01-01T12:00:00.000Z')).toISOString()).toBe(
      '2026-12-28T00:00:00.000Z',
    );
  });
});

describe('weekKeyOf', () => {
  it('is the Monday as YYYY-MM-DD', () => {
    expect(weekKeyOf(new Date('2026-06-04T23:00:00.000Z'))).toBe('2026-06-01');
  });
});

describe('previousWeekStart', () => {
  it('is exactly seven days earlier', () => {
    expect(previousWeekStart(new Date('2026-06-08T00:00:00.000Z')).toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });
});

describe('weekWindowOf', () => {
  it('spans seven days, half-open at the top', () => {
    const window = weekWindowOf(new Date('2026-06-03T15:00:00.000Z'));
    expect(window.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-06-08T00:00:00.000Z');
    expect(window.to.getTime() - window.from.getTime()).toBe(DAYS_PER_WEEK * DAY_MS);
  });

  it('EXCLUDES the upper bound, so two adjacent weeks cannot both claim an instant', () => {
    const first = weekWindowOf(new Date('2026-06-01T00:00:00.000Z'));
    const second = weekWindowOf(new Date('2026-06-08T00:00:00.000Z'));
    // The boundary instant belongs to the SECOND week only.
    expect(first.to.getTime()).toBe(second.from.getTime());
  });
});

/**
 * THE DRIFT PIN.
 *
 * `parent` deliberately does not import notify's week arithmetic — a module
 * reaches another module through an injected dependency, never an import
 * (D-051) — so two implementations of one boundary exist. Two implementations
 * of one boundary drift, and the symptom of THIS drift is a parent receiving
 * two digests in one week, which nobody would connect to a date helper.
 *
 * So the agreement is asserted rather than assumed, across a whole year and at
 * every day of the week.
 */
describe('agreement with notify (the module that hands us `weekStart`)', () => {
  it('produces the same Monday as notify for 371 consecutive days', () => {
    const start = Date.UTC(2026, 0, 1);
    for (let day = 0; day < 371; day += 1) {
      const at = new Date(start + day * DAY_MS + 13 * 60 * 60 * 1000);
      expect(weekStartOf(at).toISOString()).toBe(notifyWeekStartOf(at).toISOString());
      expect(weekKeyOf(at)).toBe(weekKey(at));
    }
  });
});
