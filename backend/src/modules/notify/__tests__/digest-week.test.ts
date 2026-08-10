import { describe, expect, it } from 'vitest';
import { utcWeekKey } from '../../../worker/scheduler';
import {
  digestJobKey,
  digestScanKey,
  frequencyCapKey,
  weekKey,
  weekStartOf,
} from '../domain/digest-week';

/**
 * Week arithmetic — the entire idempotence mechanism for the weekly digest.
 *
 * `platform/jobs` makes `(kind, idempotency_key)` UNIQUE and enqueues with
 * `ON CONFLICT DO NOTHING`, so "one digest per parent per week" is a property
 * of these strings and of nothing else. There is no "have I already sent this"
 * query anywhere, because the unique index IS that query.
 *
 * 1 June 2026 is a Monday, which makes every boundary below checkable by hand.
 */

describe('weekStartOf', () => {
  it('returns the same Monday for every day of that week', () => {
    const monday = '2026-06-01T00:00:00.000Z';
    for (const day of [
      '2026-06-01T00:00:00.000Z',
      '2026-06-03T13:45:00.000Z',
      '2026-06-07T23:59:59.999Z', // Sunday, the last instant of the week
    ]) {
      expect(weekStartOf(new Date(day)).toISOString()).toBe(monday);
    }
  });

  it('puts SUNDAY in the week that started six days earlier', () => {
    // THE OFF-BY-ONE THIS TEST EXISTS FOR. `getUTCDay()` returns 0 for Sunday,
    // so the naive `day - 1` sends Sunday BACKWARDS a day into the previous
    // Saturday. The visible symptom is one week's digest covering eight days
    // and the next covering six — which nobody would trace to a modulo.
    expect(weekStartOf(new Date('2026-06-07T12:00:00.000Z')).toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('rolls over on the Monday, not before it', () => {
    expect(weekStartOf(new Date('2026-06-07T23:59:59.999Z')).toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
    expect(weekStartOf(new Date('2026-06-08T00:00:00.000Z')).toISOString()).toBe(
      '2026-06-08T00:00:00.000Z',
    );
  });

  it('crosses a month boundary correctly', () => {
    // Wednesday 3 June belongs to a week that started in May? No — 1 June is a
    // Monday. Thursday 2 July 2026 does start in June, and that is the case a
    // date-arithmetic bug tends to survive.
    expect(weekStartOf(new Date('2026-07-02T09:00:00.000Z')).toISOString()).toBe(
      '2026-06-29T00:00:00.000Z',
    );
  });

  it('returns midnight, discarding the time of day', () => {
    const start = weekStartOf(new Date('2026-06-03T13:45:22.531Z'));
    expect(start.toISOString().slice(11)).toBe('00:00:00.000Z');
  });
});

describe('the keys', () => {
  it('gives every day of one week the same key', () => {
    expect(weekKey(new Date('2026-06-01T00:00:00.000Z'))).toBe('2026-06-01');
    expect(weekKey(new Date('2026-06-07T23:00:00.000Z'))).toBe('2026-06-01');
  });

  it('gives the next week a different key', () => {
    expect(weekKey(new Date('2026-06-08T00:00:00.000Z'))).toBe('2026-06-08');
  });

  it('makes a digest job key unique per parent and per week', () => {
    const monday = new Date('2026-06-03T09:00:00.000Z');
    const nextWeek = new Date('2026-06-10T09:00:00.000Z');

    expect(digestJobKey('parent-1', monday)).toBe(digestJobKey('parent-1', monday));
    expect(digestJobKey('parent-1', monday)).not.toBe(digestJobKey('parent-2', monday));
    expect(digestJobKey('parent-1', monday)).not.toBe(digestJobKey('parent-1', nextWeek));
  });

  it('makes the scan key stable across a week', () => {
    const kind = 'notify.scan_weekly_digests';
    expect(digestScanKey(kind, new Date('2026-06-01T02:00:00.000Z'))).toBe(
      digestScanKey(kind, new Date('2026-06-06T22:00:00.000Z')),
    );
  });

  it('contains no timestamp and no random component', () => {
    // The rule `platform/jobs` states outright: "NEVER a timestamp and never a
    // random value: either makes every enqueue a new row and silently removes
    // the only protection this design offers." Two calls separated in time must
    // produce the identical string.
    const first = digestJobKey('parent-1', new Date('2026-06-01T00:00:00.000Z'));
    const second = digestJobKey('parent-1', new Date('2026-06-05T18:22:07.913Z'));
    expect(first).toBe(second);
  });
});

describe('the worker scheduler agrees with the module', () => {
  it('derives the same week key from the same instant', () => {
    // `worker/scheduler.ts` duplicates this arithmetic rather than importing
    // it, because the worker's cadence machinery must not depend on any module.
    // THIS TEST IS WHAT STOPS THE TWO COPIES DRIFTING — and a drift would mean
    // the scan job and the per-parent job disagreed about which week it was,
    // which reads as "the digest ran but nobody got one".
    for (const iso of [
      '2026-06-01T00:00:00.000Z',
      '2026-06-07T23:59:59.999Z',
      '2026-07-02T09:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-12-31T23:00:00.000Z',
    ]) {
      expect(utcWeekKey(new Date(iso))).toBe(weekKey(new Date(iso)));
    }
  });
});

describe('frequencyCapKey', () => {
  it('is one counter per user, per kind, per UTC day', () => {
    const morning = new Date('2026-06-01T02:00:00.000Z');
    const evening = new Date('2026-06-01T22:00:00.000Z');
    const tomorrow = new Date('2026-06-02T02:00:00.000Z');

    expect(frequencyCapKey('u1', 'digest_ready', morning)).toBe(
      frequencyCapKey('u1', 'digest_ready', evening),
    );
    expect(frequencyCapKey('u1', 'digest_ready', morning)).not.toBe(
      frequencyCapKey('u1', 'digest_ready', tomorrow),
    );
    expect(frequencyCapKey('u1', 'digest_ready', morning)).not.toBe(
      frequencyCapKey('u1', 'streak_reminder', morning),
    );
    expect(frequencyCapKey('u1', 'digest_ready', morning)).not.toBe(
      frequencyCapKey('u2', 'digest_ready', morning),
    );
  });
});
