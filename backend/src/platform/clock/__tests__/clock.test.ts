import { describe, expect, it } from 'vitest';
import { FixedClock, createSystemClock } from '../index';

describe('the system clock', () => {
  it('returns a Date close to now', () => {
    const before = Date.now();
    const value = createSystemClock().now().getTime();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThan(before + 5000);
  });
});

describe('FixedClock', () => {
  it('defaults to a known instant', () => {
    expect(new FixedClock().now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('accepts a start instant as a string or a Date', () => {
    expect(new FixedClock('2026-03-04T05:06:07.000Z').now().toISOString()).toBe(
      '2026-03-04T05:06:07.000Z',
    );
    expect(new FixedClock(new Date(0)).now().toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });

  it('does not move on its own', () => {
    const clock = new FixedClock();
    expect(clock.now().getTime()).toBe(clock.now().getTime());
  });

  it('returns a copy, so a caller cannot mutate the clock', () => {
    const clock = new FixedClock();
    const first = clock.now();
    first.setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  it('advances by milliseconds, seconds and days', () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    clock.advanceMs(500);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.500Z');
    clock.advanceSeconds(30);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:30.500Z');
    clock.advanceDays(1);
    expect(clock.now().toISOString()).toBe('2026-01-02T00:00:30.500Z');
  });

  it('accepts a zero advance', () => {
    const clock = new FixedClock();
    clock.advanceMs(0);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('refuses to move backwards', () => {
    expect(() => {
      new FixedClock().advanceMs(-1);
    }).toThrow(RangeError);
  });

  it('jumps to an absolute instant', () => {
    const clock = new FixedClock();
    clock.setTo('2027-06-01T12:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2027-06-01T12:00:00.000Z');
    clock.setTo(new Date('2028-01-01T00:00:00.000Z'));
    expect(clock.now().getUTCFullYear()).toBe(2028);
  });

  it('makes an expiry boundary testable exactly', () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    const expiresAt = new Date('2026-01-01T00:15:00.000Z');

    clock.advanceMs(15 * 60 * 1000 - 1);
    expect(clock.now() < expiresAt).toBe(true);

    clock.advanceMs(1);
    expect(clock.now() < expiresAt).toBe(false);
  });
});
