import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  DEFAULT_QUIET_HOURS,
  resolvePreferences,
} from '../domain/preferences';
import { parseStoredPreferences } from '../notify.preferences-store';

/**
 * Preferences — the defaults and the merge.
 *
 * The interesting cases are all about the difference between "absent" and
 * "explicitly set to the empty value", which is where a `??` quietly makes a
 * setting impossible to choose.
 */

describe('resolvePreferences', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(resolvePreferences(null)).toEqual(DEFAULT_PREFERENCES);
  });

  it('defaults quiet hours ON', () => {
    // The product serves children. The parent installing it did not opt in to
    // being emailed at 02:00 and should not have to opt out of it.
    expect(DEFAULT_PREFERENCES.quietHours).toEqual(DEFAULT_QUIET_HOURS);
  });

  it('takes the default for a field the user has never chosen', () => {
    const resolved = resolvePreferences({ language: 'hi' });
    expect(resolved.language).toBe('hi');
    expect(resolved.optOut).toEqual([]);
    expect(resolved.quietHours).toEqual(DEFAULT_QUIET_HOURS);
    expect(resolved.timezone).toBe(DEFAULT_PREFERENCES.timezone);
  });

  it('honours an EXPLICIT null for quiet hours', () => {
    // THE CASE A `??` GETS WRONG. `stored.quietHours ?? DEFAULT` would fall
    // through to the default window here, making "turn quiet hours off"
    // impossible to express — and the failure would look like a settings screen
    // whose toggle does nothing.
    expect(resolvePreferences({ quietHours: null }).quietHours).toBeNull();
  });

  it('honours an EXPLICIT empty opt-out list', () => {
    expect(resolvePreferences({ optOut: [] }).optOut).toEqual([]);
  });

  it('carries a stored window through unchanged', () => {
    const window = { startHour: 22, endHour: 6 };
    expect(resolvePreferences({ quietHours: window }).quietHours).toEqual(window);
  });
});

describe('parseStoredPreferences', () => {
  it('reads a complete record back', () => {
    const stored = {
      language: 'hi',
      optOut: ['email'],
      quietHours: { startHour: 22, endHour: 6 },
      timezone: 'Asia/Kolkata',
    };
    expect(parseStoredPreferences(JSON.stringify(stored))).toEqual(stored);
  });

  it('returns null on unparseable JSON rather than throwing', () => {
    // A cache outage or a half-written value must not fail a send. Null
    // resolves to the defaults, which are the conservative choice.
    expect(parseStoredPreferences('{not json')).toBeNull();
    expect(parseStoredPreferences('[]')).toBeNull();
    expect(parseStoredPreferences('null')).toBeNull();
  });

  it('DROPS an unrecognised channel from optOut rather than carrying it', () => {
    // A stored preference from an older release must degrade to the default,
    // not fail the send. Worse, an unknown channel carried into the dispatcher
    // would filter nothing and look like a preference that had stopped working.
    const parsed = parseStoredPreferences(JSON.stringify({ optOut: ['email', 'telegram', 7] }));
    expect(parsed?.optOut).toEqual(['email']);
  });

  it('drops a language that is not a language code', () => {
    expect(parseStoredPreferences(JSON.stringify({ language: 'fr' }))?.language).toBeUndefined();
  });

  it('drops an out-of-range hour rather than storing it', () => {
    // 24 is not an hour. Left in, it would make `isWithinQuietHours` compare
    // against a value no clock produces, so the window would never open.
    const parsed = parseStoredPreferences(
      JSON.stringify({ quietHours: { startHour: 24, endHour: 7 } }),
    );
    expect(parsed?.quietHours).toBeUndefined();
  });

  it('preserves the difference between a stored null and an absent key', () => {
    // The two mean different things and the whole merge depends on telling them
    // apart. See the note on `StoredPreferences.quietHours`.
    expect(parseStoredPreferences(JSON.stringify({ quietHours: null }))?.quietHours).toBeNull();
    expect(parseStoredPreferences(JSON.stringify({}))?.quietHours).toBeUndefined();
  });

  it('round-trips through resolvePreferences with the defaults intact', () => {
    const parsed = parseStoredPreferences(JSON.stringify({ language: 'hi' }));
    expect(resolvePreferences(parsed)).toEqual({ ...DEFAULT_PREFERENCES, language: 'hi' });
  });
});
