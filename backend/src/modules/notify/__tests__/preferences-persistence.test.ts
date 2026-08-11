import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCache, type CachePort } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { FakeLogger } from '@/platform/logger/index';
import type { StoredPreferences } from '../domain/preferences';
import { resolvePreferences } from '../domain/preferences';
import {
  createCachePreferencesStore,
  createWriteThroughPreferencesStore,
  type NotifyPreferencesStore,
} from '../notify.preferences-store';

/**
 * =============================================================================
 * D-260 — A PREFERENCE IS A USER'S STATED WISH, NOT A CACHE ENTRY.
 *
 * Notification preferences lived in `platform/cache` and nowhere else. The
 * justification on record was that losing one only makes the product QUIETER, so
 * a loss is survivable. Both halves of that are wrong:
 *
 *   `maxmemory-policy allkeys-lru` is configured, so eviction is ORDINARY
 *   OPERATION rather than an incident; and
 *
 *   the default is NO OPT-OUTS, so reverting to the default is the LOUDER
 *   outcome, not the quieter one. Somebody who muted email starts receiving
 *   email again, having changed nothing and been told nothing.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS FILE PROVES, AND WHAT IT CANNOT.
 *
 * It proves the write-through composition: that the durable store is the
 * AUTHORITY, that eviction costs a lookup rather than a preference, that a cache
 * outage does not lose a write, and that a failed durable write is reported
 * rather than swallowed.
 *
 * It CANNOT prove the real adapter against Postgres, because
 * `notification_preferences` does not exist yet — the migration is reported
 * rather than written, since `drizzle/` belongs to another change in flight. The
 * durable store here is therefore an in-memory stand-in with the same port. When
 * the table lands, `createDbPreferencesStore` drops into the same seam and this
 * file's assertions are the contract it has to satisfy.
 *
 * THE FIRST TEST IS THE DEFECT ITSELF, ASSERTED AGAINST THE OLD STORE. It stays
 * green by describing what the cache-only store does — so if somebody "fixes"
 * the cache store instead of persisting, that test fails and says why.
 * =============================================================================
 */

const NOW = new Date('2026-08-11T09:00:00.000Z');

/**
 * A durable store with no database — a `Map`, plus a switch for making a write
 * fail.
 *
 * Deliberately NOT a mock library: the interesting assertions are about call
 * ORDER and about what survives, and a hand-written double that actually stores
 * things can answer both.
 */
class MemoryDurableStore implements NotifyPreferencesStore {
  readonly rows = new Map<string, StoredPreferences>();
  reads = 0;
  failWrites = false;

  read(userId: string): Promise<StoredPreferences | null> {
    this.reads += 1;
    return Promise.resolve(this.rows.get(userId) ?? null);
  }

  write(userId: string, preferences: StoredPreferences): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error('database unavailable'));
    this.rows.set(userId, preferences);
    return Promise.resolve();
  }
}

const USER = '11111111-1111-4111-8111-111111111111';

/** Somebody who has muted email. The exact wish that used to be lost. */
const MUTED_EMAIL: StoredPreferences = { optOut: ['email'] };

let clock: FixedClock;
let cache: MemoryCache;
let logger: FakeLogger;
let durable: MemoryDurableStore;
let store: NotifyPreferencesStore;

beforeEach(() => {
  clock = new FixedClock(NOW);
  cache = new MemoryCache(clock);
  logger = new FakeLogger();
  durable = new MemoryDurableStore();
  store = createWriteThroughPreferencesStore({ durable, cache, logger });
});

describe('the cache-only store LOSES a preference on eviction — the defect (D-260)', () => {
  it('restores the DEFAULT channel set, which is the opposite of quieter', async () => {
    const cacheOnly = createCachePreferencesStore({ cache, logger });
    await cacheOnly.write(USER, MUTED_EMAIL);

    // `allkeys-lru` evicts whatever it likes. A delete is the same event.
    await cache.del(`notify:prefs:${USER}`);

    expect(await cacheOnly.read(USER)).toBeNull();
    // And what "null" means downstream: the defaults, which opt out of nothing.
    // So the person who muted email is now receiving email again.
    expect(resolvePreferences(await cacheOnly.read(USER)).optOut).toEqual([]);
  });
});

describe('the write-through store keeps the preference across eviction (D-260)', () => {
  it('STILL RETURNS THE OPT-OUT after the cache entry is gone', async () => {
    await store.write(USER, MUTED_EMAIL);
    await cache.del(`notify:prefs:${USER}`);

    // THE ASSERTION THE OLD STORE FAILED.
    expect(await store.read(USER)).toEqual(MUTED_EMAIL);
    expect(resolvePreferences(await store.read(USER)).optOut).toEqual(['email']);
  });

  it('repopulates the cache from the authority, so eviction costs ONE read', async () => {
    await store.write(USER, MUTED_EMAIL);
    await cache.del(`notify:prefs:${USER}`);

    const before = durable.reads;
    await store.read(USER); // misses, falls through, repopulates
    await store.read(USER); // served from the cache again
    await store.read(USER);

    expect(durable.reads).toBe(before + 1);
  });

  it('treats a cache MISS as a miss and never as "this person chose nothing"', async () => {
    // The inversion that mattered: absence in the cache is not an answer. Only
    // a durable null means "never chosen".
    await store.write(USER, MUTED_EMAIL);
    await cache.del(`notify:prefs:${USER}`);

    expect(await store.read(USER)).not.toBeNull();
    expect(await store.read('22222222-2222-4222-8222-222222222222')).toBeNull();
  });

  it('does NOT negatively cache an absent preference', async () => {
    // Caching "no preferences" would reintroduce the whole failure sideways: a
    // miss stored as a null is indistinguishable from a wish to have none.
    expect(await store.read(USER)).toBeNull();

    // A write now must be visible immediately, not after a TTL nobody set.
    await store.write(USER, MUTED_EMAIL);
    expect(await store.read(USER)).toEqual(MUTED_EMAIL);
  });

  it('writes to the DATABASE FIRST, so a cache failure cannot fake a save', async () => {
    // The order is the design. Cache-first would serve the new value until
    // eviction and the old one forever after — a setting that appears to save,
    // works for a while, then silently reverts.
    await store.write(USER, MUTED_EMAIL);
    expect(durable.rows.get(USER)).toEqual(MUTED_EMAIL);
  });

  it('REPORTS a failed durable write rather than returning as though it saved', async () => {
    durable.failWrites = true;

    await expect(store.write(USER, MUTED_EMAIL)).rejects.toThrow('database unavailable');
    // And nothing was cached either, so a later read cannot serve a value that
    // was never stored.
    expect(await store.read(USER)).toBeNull();
  });

  it('survives a cache OUTAGE on both paths, answering from the authority', async () => {
    /**
     * A cache that refuses everything, implementing the whole port.
     *
     * Written out rather than spread over a `MemoryCache` instance: spreading a
     * class instance drops its prototype, which produces a "cache" whose
     * remaining methods are silently absent — a fake that fails for a reason
     * unrelated to the outage being simulated.
     */
    const down = (): Promise<never> => Promise.reject(new Error('valkey down'));
    const brokenCache: CachePort = {
      get: down,
      set: down,
      del: down,
      incr: down,
      expire: down,
      close: (): Promise<void> => Promise.resolve(),
    };
    const resilient = createWriteThroughPreferencesStore({
      durable,
      cache: brokenCache,
      logger,
    });

    // A cache that refuses writes must not fail the save …
    await resilient.write(USER, MUTED_EMAIL);
    expect(durable.rows.get(USER)).toEqual(MUTED_EMAIL);

    // … and a cache that refuses reads must not lose the answer.
    expect(await resilient.read(USER)).toEqual(MUTED_EMAIL);

    // Visible rather than silent: degradation is reported at `warn`.
    const warned = logger.lines.filter(
      (line) =>
        typeof line.obj.event === 'string' &&
        line.obj.event.startsWith('notify.preferences_cache_'),
    );
    expect(warned.length).toBeGreaterThan(0);
    // And never with the user id in it — a log line about personal settings
    // must not become a record of who has them.
    expect(JSON.stringify(warned)).not.toContain(USER);
  });

  it('treats an UNPARSEABLE cache entry as a miss, not as "no preferences"', async () => {
    await store.write(USER, MUTED_EMAIL);
    await cache.set(`notify:prefs:${USER}`, 'not json at all');

    // Falls through to the authority and repairs itself, rather than applying
    // the defaults to somebody whose real settings are sitting in the database.
    expect(await store.read(USER)).toEqual(MUTED_EMAIL);
  });
});
