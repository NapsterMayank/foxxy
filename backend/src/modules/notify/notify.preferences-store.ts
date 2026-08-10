import type { CachePort } from '@/platform/cache/index';
import type { Logger } from '@/platform/logger/index';
import type { ChannelName } from '@/platform/notify-channel/index';
import { isLanguageCode } from '@/shared/constants/curriculum';
import type { StoredPreferences } from './domain/preferences';

/**
 * Where a person's notification preferences are kept.
 *
 * ===========================================================================
 * READ THIS BEFORE RELYING ON IT. THE ADAPTER BELOW IS CACHE-BACKED, AND THAT
 * IS A KNOWN, REPORTED GAP — NOT A DESIGN.
 *
 * Preferences are durable user settings. They belong in a
 * `notification_preferences` table, keyed by user, with the tenant alongside.
 * That is a MIGRATION, and this module was built under an explicit instruction
 * not to write one while the migration chain is being rewritten underneath it.
 * So the shape that needs the migration is behind this PORT, the port has a
 * cache-backed adapter today, and swapping in a repository is one line at the
 * composition root.
 *
 * The honest consequence, stated rather than discovered: a cache eviction
 * resets a person's preferences to the defaults. That is survivable ONLY
 * because of what the defaults are — quiet hours ON, no opt-outs, English. A
 * lost preference makes the product QUIETER and more conservative, never
 * louder, and it never grants anyone access to anything.
 *
 * D-012 and D-033 set the standing rule: "nothing whose loss changes what a
 * user is ALLOWED to do may live in a cache." A channel opt-out is not that —
 * losing it means an email somebody had muted arrives once. Losing a link code
 * (the case that produced the rule) meant a parent could not link at all.
 *
 * It would still be wrong to leave it here. Hence: reported.
 *
 * ===========================================================================
 * A READ NEVER THROWS.
 *
 * A cache outage must not stop a notification. `read` catches, logs once at
 * `warn`, and returns null — which resolves to the defaults, which are the
 * conservative choice. The alternative, propagating the failure, would mean a
 * Valkey blip silently converts every notification into a dead-lettered job.
 */

export interface NotifyPreferencesStore {
  read(userId: string): Promise<StoredPreferences | null>;
  write(userId: string, preferences: StoredPreferences): Promise<void>;
}

const KEY_PREFIX = 'notify:prefs:';

/** Channel names, for validating what came back out of storage. */
const CHANNEL_NAMES: readonly string[] = ['email', 'in-app', 'whatsapp', 'push'];

function isHour(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23;
}

/**
 * Narrows whatever was stored back into `StoredPreferences`.
 *
 * Validated field by field rather than cast. The value came out of a string
 * store, so TypeScript's belief about its shape stands behind nothing; and an
 * `optOut` array holding a channel name that no longer exists would be silently
 * carried into the dispatcher, where it would filter nothing and look like a
 * preference that had stopped working.
 *
 * Anything unrecognised is DROPPED rather than rejected. A stored preference
 * from an older release must degrade to the default, not fail the send.
 */
export function parseStoredPreferences(raw: string): StoredPreferences | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const value = parsed as Record<string, unknown>;
  // Built as a MUTABLE partial and assigned key by key. `exactOptionalPropertyTypes`
  // is on, so writing `{ language: maybeUndefined }` would be a type error — an
  // absent key and a key holding `undefined` are genuinely different here, and
  // the difference is what carries "never chosen" through to the defaults.
  const out: Record<string, unknown> = {};

  if (typeof value.language === 'string' && isLanguageCode(value.language)) {
    out.language = value.language;
  }

  if (Array.isArray(value.optOut)) {
    out.optOut = value.optOut.filter(
      (entry): entry is ChannelName => typeof entry === 'string' && CHANNEL_NAMES.includes(entry),
    );
  }

  if (value.quietHours === null) {
    // An EXPLICIT null: "I have turned quiet hours off". Distinct from absent,
    // which means "never chosen" and takes the default window. See the note on
    // `StoredPreferences.quietHours`.
    out.quietHours = null;
  } else if (typeof value.quietHours === 'object') {
    const window = value.quietHours as Record<string, unknown>;
    if (isHour(window.startHour) && isHour(window.endHour)) {
      out.quietHours = { startHour: window.startHour, endHour: window.endHour };
    }
  }

  if (typeof value.timezone === 'string' && value.timezone.length > 0) {
    out.timezone = value.timezone;
  }

  // Every key above was written only after being narrowed, so what leaves here
  // satisfies `StoredPreferences` by construction rather than by assertion.
  return out;
}

export interface CachePreferencesStoreOptions {
  readonly cache: CachePort;
  readonly logger: Logger;
}

export function createCachePreferencesStore(
  options: CachePreferencesStoreOptions,
): NotifyPreferencesStore {
  const { cache, logger } = options;

  return {
    async read(userId: string): Promise<StoredPreferences | null> {
      try {
        const raw = await cache.get(`${KEY_PREFIX}${userId}`);
        return raw === null ? null : parseStoredPreferences(raw);
      } catch (error) {
        // Never the user id: a log line about personal settings must not become
        // a record of who has them.
        logger.warn(
          {
            event: 'notify.preferences_unavailable',
            err: error instanceof Error ? error.message : 'unknown cache failure',
          },
          'notification preferences could not be read; falling back to the defaults',
        );
        return null;
      }
    },

    /**
     * No TTL. A preference is not a cache entry that should expire; it expires
     * only because this adapter is standing in for a table. Setting one would
     * add a second, invisible way for a setting to revert.
     */
    async write(userId: string, preferences: StoredPreferences): Promise<void> {
      await cache.set(`${KEY_PREFIX}${userId}`, JSON.stringify(preferences));
    },
  };
}
