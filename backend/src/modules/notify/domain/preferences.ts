import type { ChannelName } from '@/platform/notify-channel/index';
import type { LanguageCode } from '@/shared/constants/curriculum';
import type { QuietHours } from './quiet-hours';

/**
 * Notification preferences — the defaults, and how a stored override merges
 * onto them.
 *
 * Pure. No I/O, no clock. Where the override is READ from is
 * `notify.preferences-store.ts`'s problem; what it MEANS is this file's.
 *
 * ===========================================================================
 * DEFAULTS ARE A PRODUCT DECISION AND ARE STATED ONCE, HERE.
 *
 * The alternative — `stored?.quietHours ?? { start: 21, end: 7 }` scattered
 * across the service — puts the same decision in four places, and the day one
 * of them is edited the product has two different definitions of "quiet".
 *
 * ===========================================================================
 * A PREFERENCE FILTERS; IT NEVER EXTENDS.
 *
 * `optOut` removes channels the routing table chose. There is deliberately no
 * `optIn`: a user asking for a channel the product does not use for that kind
 * would be asking for a message that has no template. The same rule the
 * dispatcher enforces, stated here because this is where somebody adding a
 * preference will be looking.
 */

export interface NotifyPreferences {
  /** Which language the REMOTE channels render. In-app always stores both. */
  readonly language: LanguageCode;
  /** Channels this person has turned off. `in-app` is never removable. */
  readonly optOut: readonly ChannelName[];
  /** `null` disables quiet hours entirely. */
  readonly quietHours: QuietHours | null;
  /** IANA zone the quiet-hours window is expressed in. */
  readonly timezone: string;
}

/** What a store may hold. Every field optional — absent means "the default". */
export interface StoredPreferences {
  readonly language?: LanguageCode;
  readonly optOut?: readonly ChannelName[];
  /**
   * `null` is a REAL, STORED value meaning "I have turned quiet hours off",
   * and it is different from `undefined`, which means "I have never chosen".
   * Collapsing the two with `??` would make disabling quiet hours impossible:
   * the stored `null` would fall through to the default window every time.
   */
  readonly quietHours?: QuietHours | null;
  readonly timezone?: string;
}

/**
 * 21:00 to 07:00, Asia/Kolkata.
 *
 * ON BY DEFAULT, not off. The product serves children; the parent installing it
 * did not opt into being emailed at 02:00 and should not have to opt out of it.
 * Account-security kinds ignore the window anyway (`domain/kinds.ts`), so the
 * conservative default costs nothing that matters.
 */
export const DEFAULT_QUIET_HOURS: QuietHours = { startHour: 21, endHour: 7 };

/** The single tenant is Indian and the digest is expected at 09:00 IST. */
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export const DEFAULT_PREFERENCES: NotifyPreferences = {
  language: 'en',
  optOut: [],
  quietHours: DEFAULT_QUIET_HOURS,
  timezone: DEFAULT_TIMEZONE,
};

/**
 * Merges a stored override onto the defaults.
 *
 * `undefined` means "not chosen" and takes the default; every other value —
 * including `null` for `quietHours` and `[]` for `optOut` — is an explicit
 * choice and is honoured. See the note on `StoredPreferences.quietHours`.
 */
export function resolvePreferences(stored: StoredPreferences | null): NotifyPreferences {
  if (stored === null) return DEFAULT_PREFERENCES;

  return {
    language: stored.language ?? DEFAULT_PREFERENCES.language,
    optOut: stored.optOut ?? DEFAULT_PREFERENCES.optOut,
    quietHours:
      stored.quietHours === undefined ? DEFAULT_PREFERENCES.quietHours : stored.quietHours,
    timezone: stored.timezone ?? DEFAULT_PREFERENCES.timezone,
  };
}
