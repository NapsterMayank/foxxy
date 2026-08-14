import { describe, expect, it } from 'vitest';
import { formatDayAndMonth } from '../format-date';

describe('a date somebody reads', () => {
  it('writes the day before the month, as every reader here does', () => {
    // `en-IN`, not `en-US`. "August 21" is not how this audience writes it.
    expect(formatDayAndMonth('2026-08-21T04:30:00.000Z', 'en')).toBe('21 August');
  });

  /*
   * The interface language and the DEVICE LOCALE are chosen separately by every
   * browser, so `toLocaleDateString()` would put an English month in the middle
   * of a Hindi sentence for any Hindi reader on an en-US phone.
   */
  it('follows the interface language and not the device', () => {
    expect(formatDayAndMonth('2026-08-21T04:30:00.000Z', 'hi')).toContain('अगस्त');
  });

  /*
   * `new Date('nonsense')` is `Invalid Date`, and `Intl` renders that as the
   * literal English string "Invalid Date" — untranslated, in front of a child,
   * looking like a sentence the interface chose.
   */
  it('returns an unparseable value as it came rather than "Invalid Date"', () => {
    expect(formatDayAndMonth('not-a-date', 'en')).toBe('not-a-date');
    expect(formatDayAndMonth('', 'hi')).toBe('');
  });

  it('treats an unknown language as English rather than throwing', () => {
    expect(formatDayAndMonth('2026-08-21T04:30:00.000Z', 'ta')).toBe('21 August');
  });
});
