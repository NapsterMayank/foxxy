import type { CachePort } from '@/platform/cache/index';
import type { Logger } from '@/platform/logger/index';
import type { ChannelName } from '@/platform/notify-channel/index';
import { isLanguageCode } from '@/shared/constants/curriculum';
import type { StoredPreferences } from './domain/preferences';

/**
 * Where a person's notification preferences are kept.
 *
 * ===========================================================================
 * THE CACHE-ONLY ADAPTER BELOW IS NO LONGER THE INTENDED HOME — D-260.
 *
 * It used to be the only one, and the reasoning given for that was: a lost
 * preference makes the product QUIETER, never louder, so losing one is
 * survivable. That reasoning does not survive contact with the deployment.
 * `maxmemory-policy allkeys-lru` is configured, which makes eviction ORDINARY
 * OPERATION rather than an incident — and what eviction restores is the DEFAULT
 * channel set. Somebody who muted email starts receiving email again, having
 * changed nothing and having been told nothing.
 *
 * "Quieter, never louder" was also simply wrong in the one direction that
 * matters: the default is *no opt-outs*, so reverting to it is exactly the
 * louder outcome.
 *
 * D-012 and D-033 set the standing rule — "nothing whose loss changes what a
 * user is ALLOWED to do may live in a cache" — and an opt-out passed it, because
 * an opt-out is not an authorisation. The rule was too narrow. What a user has
 * DECIDED belongs beside what a user is ALLOWED: neither can be recomputed from
 * anything else we hold, and losing either one is losing something they gave us.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT DONE, STATED PLAINLY.
 *
 * `createDbPreferencesStore` (`notify.preferences.repository.ts`) is the durable
 * adapter and it is finished. `createWriteThroughPreferencesStore` below is the
 * composition that makes the database authoritative and keeps the cache as a
 * read cache. NEITHER IS WIRED, because `notification_preferences` needs a
 * migration and `drizzle/` belongs to another change in flight. The migration is
 * REPORTED — see D-260 and the module report — rather than written here, and
 * `app/routes.ts` still constructs the cache-only store until it lands.
 *
 * There is no service-level write path yet either, so today's cache-only store
 * loses nothing a user has actually set. That is what makes this latent rather
 * than live, and it is the reason it could be fixed properly instead of quickly.
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

export interface WriteThroughPreferencesStoreOptions {
  /** The AUTHORITY. Everything here is answered from this store eventually. */
  readonly durable: NotifyPreferencesStore;
  /** A read cache in front of it, and nothing more. */
  readonly cache: CachePort;
  readonly logger: Logger;
}

/**
 * =============================================================================
 * THE DURABLE STORE, WITH THE CACHE DEMOTED TO A READ CACHE — D-260.
 *
 * The ORDER OF THE TWO WRITES IS THE WHOLE DESIGN. The durable write happens
 * FIRST and its failure propagates; the cache write happens second and its
 * failure is swallowed. Reverse them and a cache that accepted the value while
 * the database refused it would serve the new preference until eviction and the
 * old one forever after — a setting that appears to save, works for a while, and
 * then silently reverts, which is the least diagnosable shape this bug has.
 *
 * A MISS IS NOT AN ANSWER. `read` falls through to the durable store on a cache
 * miss, and only a durable `null` means "this person has never chosen". That is
 * the exact inversion of the defect: eviction now costs one indexed primary-key
 * lookup instead of costing somebody their opt-out.
 *
 * THE CACHE IS NEVER THE AUTHORITY ON ABSENCE, and it is not negatively cached
 * either. Caching "no preferences" would reintroduce the failure through the
 * back door — a miss stored as a null is indistinguishable from a wish to have
 * none, and the whole point is that those two are different facts.
 * =============================================================================
 */
export function createWriteThroughPreferencesStore(
  options: WriteThroughPreferencesStoreOptions,
): NotifyPreferencesStore {
  const { durable, cache, logger } = options;

  function warn(event: string, error: unknown): void {
    // Never the user id: a log line about personal settings must not become a
    // record of who has them.
    logger.warn(
      {
        event,
        err: error instanceof Error ? error.message : 'unknown cache failure',
      },
      'the notification-preferences cache is unavailable; the database is answering',
    );
  }

  return {
    async read(userId: string): Promise<StoredPreferences | null> {
      const key = `${KEY_PREFIX}${userId}`;

      try {
        const raw = await cache.get(key);
        if (raw !== null) {
          const cached = parseStoredPreferences(raw);
          // A cached entry that no longer parses is treated as a MISS rather
          // than as "no preferences". Falling through re-reads the authority and
          // repairs the entry; returning null would apply the defaults to
          // somebody whose real settings are sitting in the database.
          if (cached !== null) return cached;
        }
      } catch (error) {
        warn('notify.preferences_cache_unavailable', error);
      }

      const stored = await durable.read(userId);
      if (stored !== null) {
        try {
          await cache.set(key, JSON.stringify(stored));
        } catch (error) {
          // A cache that cannot be populated is a slow read, not a failed one.
          warn('notify.preferences_cache_unwritable', error);
        }
      }
      return stored;
    },

    async write(userId: string, preferences: StoredPreferences): Promise<void> {
      // FIRST, AND UNGUARDED. If this throws, the caller must hear that the
      // setting was not saved — see the block above for why the other order is
      // the worst of the three possibilities.
      await durable.write(userId, preferences);

      try {
        await cache.set(`${KEY_PREFIX}${userId}`, JSON.stringify(preferences));
      } catch (error) {
        // The value IS saved. A failed cache write costs one database read on
        // the next lookup and nothing else, so it must not fail the request.
        warn('notify.preferences_cache_unwritable', error);
      }
    },
  };
}
