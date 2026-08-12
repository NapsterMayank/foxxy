import { describe, expect, it } from 'vitest';
import { isWithinQuietHours, localHourIn, quietHoursEndAt } from '../domain/quiet-hours';

/**
 * Quiet hours — pure, and every instant is an argument. No clock, no sleep.
 *
 * IST is UTC+5:30, so the arithmetic below is deliberately written with times
 * that are unremarkable in one zone and awkward in the other: 18:00 UTC is
 * 23:30 IST, which is inside a 21:00-07:00 window; 04:00 UTC is 09:30 IST,
 * which is outside it. A test that used only midnight would pass against a
 * timezone-blind implementation.
 */

const IST = 'Asia/Kolkata';
const NIGHT = { startHour: 21, endHour: 7 };

const at = (iso: string): Date => new Date(iso);

describe('localHourIn', () => {
  it('reads the hour in the target zone, not in UTC', () => {
    // 18:00 UTC is 23:30 IST. An implementation that used `getUTCHours` would
    // answer 18 and every window test below would still pass for the wrong
    // reason, so this is asserted separately.
    expect(localHourIn(IST, at('2026-06-01T18:00:00.000Z'))).toBe(23);
    expect(localHourIn('UTC', at('2026-06-01T18:00:00.000Z'))).toBe(18);
  });

  it('reports midnight as 0 and never as 24', () => {
    // `hour12: false` alone yields "24" for midnight in some locales — a value
    // out of range for every comparison in this file, which would put midnight
    // OUTSIDE a window that contains it. `hourCycle: 'h23'` is what prevents it.
    expect(localHourIn('UTC', at('2026-06-01T00:00:00.000Z'))).toBe(0);
    expect(localHourIn(IST, at('2026-05-31T18:30:00.000Z'))).toBe(0);
  });
});

describe('isWithinQuietHours — the wrapping window', () => {
  it('is inside just after the window opens', () => {
    // 21:00 IST exactly — the boundary, and INCLUSIVE.
    expect(isWithinQuietHours(at('2026-06-01T15:30:00.000Z'), NIGHT, IST)).toBe(true);
  });

  it('is inside after midnight, on the other side of the wrap', () => {
    // 02:00 IST. The union half of the window; an implementation that used
    // `and` instead of `or` would report false here and nowhere else.
    expect(isWithinQuietHours(at('2026-05-31T20:30:00.000Z'), NIGHT, IST)).toBe(true);
  });

  it('is OUTSIDE at the closing hour, which is exclusive', () => {
    // 07:00 IST. `endHour` is exclusive, so the window has ended.
    expect(isWithinQuietHours(at('2026-06-01T01:30:00.000Z'), NIGHT, IST)).toBe(false);
  });

  it('is outside one hour before the window opens', () => {
    // 20:00 IST.
    expect(isWithinQuietHours(at('2026-06-01T14:30:00.000Z'), NIGHT, IST)).toBe(false);
  });

  it('is outside in the middle of the day', () => {
    // 12:00 IST.
    expect(isWithinQuietHours(at('2026-06-01T06:30:00.000Z'), NIGHT, IST)).toBe(false);
  });
});

describe('isWithinQuietHours — the other shapes', () => {
  it('handles a window that does not wrap', () => {
    const siesta = { startHour: 13, endHour: 15 };
    expect(isWithinQuietHours(at('2026-06-01T08:30:00.000Z'), siesta, IST)).toBe(true); // 14:00
    expect(isWithinQuietHours(at('2026-06-01T09:30:00.000Z'), siesta, IST)).toBe(false); // 15:00
    expect(isWithinQuietHours(at('2026-06-01T07:00:00.000Z'), siesta, IST)).toBe(false); // 12:30
  });

  it('treats a null window as no quiet hours at all', () => {
    expect(isWithinQuietHours(at('2026-05-31T20:30:00.000Z'), null, IST)).toBe(false);
  });

  it('treats start === end as DISABLED, not as twenty-four hours', () => {
    // The alternative reading turns a configuration typo into a product that
    // silently never emails anybody — the exact failure this module exists to
    // make impossible.
    const degenerate = { startHour: 9, endHour: 9 };
    expect(isWithinQuietHours(at('2026-06-01T03:30:00.000Z'), degenerate, IST)).toBe(false);
    expect(isWithinQuietHours(at('2026-05-31T20:30:00.000Z'), degenerate, IST)).toBe(false);
  });
});

describe('quietHoursEndAt', () => {
  it('returns the next 07:00 local for a notification raised at 23:30 local', () => {
    // 18:00 UTC is 23:30 IST on 1 June; 07:00 IST on 2 June is 01:30 UTC.
    const end = quietHoursEndAt(at('2026-06-01T18:00:00.000Z'), NIGHT, IST);
    expect(end.toISOString()).toBe('2026-06-02T01:30:00.000Z');
    expect(localHourIn(IST, end)).toBe(7);
  });

  it('returns the SAME morning for a notification raised after midnight', () => {
    // 20:30 UTC on 31 May is 02:00 IST on 1 June, so the window ends at 07:00
    // IST that same morning — 01:30 UTC on 1 June. An implementation that
    // always added a day would push this a full day late.
    const end = quietHoursEndAt(at('2026-05-31T20:30:00.000Z'), NIGHT, IST);
    expect(end.toISOString()).toBe('2026-06-01T01:30:00.000Z');
  });

  it('aligns to the top of the hour, discarding stray milliseconds', () => {
    // The result becomes a job's `run_at`. Carrying the caller's milliseconds
    // into it would make every deferred delivery land at a different offset for
    // no reason, and would make this test unwritable.
    const end = quietHoursEndAt(at('2026-06-01T18:07:43.219Z'), NIGHT, IST);
    expect(end.getUTCSeconds()).toBe(0);
    expect(end.getUTCMilliseconds()).toBe(0);
  });

  it('never returns an instant before the one it was given', () => {
    const from = at('2026-06-01T18:00:00.000Z');
    expect(quietHoursEndAt(from, NIGHT, IST).getTime()).toBeGreaterThan(from.getTime());
  });

  it('is bounded rather than looping on an impossible window', () => {
    // `endHour: 99` cannot occur. The function returns the 48-hour bound rather
    // than spinning: this is a scheduling decision on a delivery path, and a
    // bounded-late notification beats an exception that dead-letters it.
    const from = at('2026-06-01T18:00:00.000Z');
    const end = quietHoursEndAt(from, { startHour: 21, endHour: 99 }, IST);
    expect(end.getTime()).toBe(from.getTime() + 48 * 60 * 60 * 1000);
  });
});
