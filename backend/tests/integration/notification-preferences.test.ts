import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryCache } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { createDb, type DbHandle } from '@/platform/db/index';
import { FakeLogger } from '@/platform/logger/index';
import {
  createCachePreferencesStore,
  createDbPreferencesStore,
  createWriteThroughPreferencesStore,
  type NotifyPreferencesStore,
} from '@/modules/notify/index';
import { parseConfig } from '@/platform/config/load-config';
import { RecordingMail } from '@/platform/mail/index';
import { createContainer } from '@/app/container';
import { buildModules } from '@/app/routes';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../helpers/postgres';

/**
 * =============================================================================
 * `notification_preferences` — migration 0006, and the wiring D-260 asked for.
 *
 * WHAT WAS WRONG. Preferences lived in `platform/cache` AND NOWHERE ELSE,
 * justified on record with "a lost preference makes the product QUIETER, never
 * louder". Both halves are false:
 *
 *   * `maxmemory-policy allkeys-lru` is configured, so eviction is ORDINARY
 *     OPERATION, not an incident — and a preference key is written once and
 *     read rarely, which puts it near the front of the eviction queue BY
 *     CONSTRUCTION.
 *   * the default is NO OPT-OUTS, so reverting to the default is the LOUDER
 *     outcome. Somebody who muted email starts receiving it again, having
 *     changed nothing and been told nothing.
 *
 * WHY THIS FILE NEEDS A REAL POSTGRES. `createDbPreferencesStore` was finished
 * and deliberately unwired for exactly one reason — the table did not exist —
 * and every unit test of it passed against a fake handle the whole time. The
 * only thing that can tell "this store is correct" from "this store is correct
 * and has nowhere to write" is the schema. The `CHECK` constraint and the
 * `ON DELETE CASCADE` are likewise properties of the DATABASE and cannot be
 * asserted anywhere else.
 * =============================================================================
 */

let postgres: TestPostgres;
let handle: DbHandle;
let clock: FixedClock;

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeAll(async () => {
  postgres = await startTestPostgres();
  await applyAllMigrations(postgres.client);
  handle = createDb({ url: postgres.url, poolMax: 4, ssl: false });
}, 180_000);

afterAll(async () => {
  await handle.close();
  await postgres.stop();
}, 60_000);

beforeEach(async () => {
  clock = new FixedClock('2026-08-09T09:00:00.000Z');
  await postgres.client.query('truncate table notification_preferences, users cascade');
  for (const id of [USER, OTHER]) {
    await postgres.client.query(
      `insert into users (id, email, password_hash, role, tenant_id)
       values ($1, $2, 'x', 'student', (select id from tenants limit 1))`,
      [id, `${id}@example.test`],
    );
  }
});

function durableStore(): NotifyPreferencesStore {
  return createDbPreferencesStore(handle);
}

function writeThrough(cache: MemoryCache): NotifyPreferencesStore {
  return createWriteThroughPreferencesStore({
    durable: durableStore(),
    cache,
    logger: new FakeLogger(),
  });
}

describe('the table exists and holds what the store writes', () => {
  it('round-trips a stored preference', async () => {
    const store = durableStore();
    await store.write(USER, { optOut: ['email'] });
    expect(await store.read(USER)).toEqual({ optOut: ['email'] });
  });

  it('returns null for a user who has never chosen — absence is a real answer', async () => {
    // The distinction the cache could not make. `null` means "never chosen";
    // it is NOT the same as "we lost it", and the whole design rests on the two
    // being different facts.
    expect(await durableStore().read(OTHER)).toBeNull();
  });

  it('is keyed by the user, so a second write REPLACES rather than duplicates', async () => {
    // No surrogate id: two preference rows for one user is not a resolvable
    // state, because whichever you read, the other is also something they said.
    const store = durableStore();
    await store.write(USER, { optOut: ['email'] });
    await store.write(USER, { optOut: ['whatsapp'] });

    expect(await store.read(USER)).toEqual({ optOut: ['whatsapp'] });
    const count = await postgres.client.query<{ n: number }>(
      'select count(*)::int as n from notification_preferences where user_id = $1',
      [USER],
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it('keeps one user’s preferences out of another’s', async () => {
    const store = durableStore();
    await store.write(USER, { optOut: ['email'] });
    expect(await store.read(OTHER)).toBeNull();
  });
});

describe('the constraints are the database’s, not the application’s', () => {
  it.each([
    ['a JSON string', '"muted"'],
    ['a JSON null', 'null'],
    ['an array', '[]'],
    ['a number', '3'],
  ])('REFUSES %s in the preferences column', async (_label, literal) => {
    /**
     * jsonb accepts all four of these as perfectly valid documents, and every
     * one would reach `parseStoredPreferences` as a shape it has to defend
     * against forever. The CHECK is what makes the column mean what its name
     * says — and it has to be enforced here, because a raw INSERT from a psql
     * session or an import script never passes through the TypeScript.
     */
    await expect(
      postgres.client.query(
        `insert into notification_preferences (user_id, preferences)
         values ($1, $2::jsonb)`,
        [USER, literal],
      ),
    ).rejects.toThrow(/notification_preferences_object_check/);
  });

  it('accepts an empty object — "chosen nothing" is not "never chosen"', async () => {
    await postgres.client.query(
      `insert into notification_preferences (user_id, preferences) values ($1, '{}'::jsonb)`,
      [USER],
    );
    expect(await durableStore().read(USER)).not.toBeNull();
  });

  it('CASCADES on user deletion — no orphan record of a forgotten person', async () => {
    await durableStore().write(USER, { optOut: ['email'] });
    await postgres.client.query('delete from users where id = $1', [USER]);

    const rows = await postgres.client.query(
      'select 1 from notification_preferences where user_id = $1',
      [USER],
    );
    expect(rows.rowCount).toBe(0);
  });

  it('refuses a preference for a user who does not exist', async () => {
    await expect(
      postgres.client.query(
        `insert into notification_preferences (user_id, preferences)
         values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

describe('the write-through store survives what killed the cache-only one', () => {
  it('STILL RETURNS THE OPT-OUT after the cache entry is gone', async () => {
    /**
     * THE DEFECT, REPRODUCED AND CLOSED. `allkeys-lru` evicting this key used
     * to restore the DEFAULT channel set — no opt-outs — so the user started
     * receiving the email they had muted, silently. A miss is now a
     * primary-key lookup, not an answer.
     */
    const cache = new MemoryCache(clock);
    const store = writeThrough(cache);

    await store.write(USER, { optOut: ['email'] });
    expect(await store.read(USER)).toEqual({ optOut: ['email'] });

    // Eviction: every key gone, no error, no signal — ordinary operation.
    await cache.close();
    const evicted = new MemoryCache(clock);

    expect(await writeThrough(evicted).read(USER)).toEqual({ optOut: ['email'] });
  });

  it('writes the DURABLE store first, so the cache can never hold what the database refused', async () => {
    /**
     * The order is the design. Reversed, a cache that accepted a value the
     * database rejected would serve it until eviction and the old one forever
     * after — the least diagnosable shape this bug has.
     *
     * Proved by making the durable write fail: the caller is told, and the
     * cache is left with nothing to serve.
     */
    const cache = new MemoryCache(clock);
    const failing = createWriteThroughPreferencesStore({
      durable: {
        read: () => Promise.resolve(null),
        write: () => Promise.reject(new Error('database refused the write')),
      },
      cache,
      logger: new FakeLogger(),
    });

    await expect(failing.write(USER, { optOut: ['email'] })).rejects.toThrow(
      /database refused/,
    );
    // Nothing was cached, so a subsequent read cannot serve the value that was
    // never stored.
    expect(await createCachePreferencesStore({ cache, logger: new FakeLogger() }).read(USER)).toBeNull();
  });

  it('does NOT negatively cache absence', async () => {
    // Caching "no preferences" would reintroduce the defect through the back
    // door: a miss stored as a null is indistinguishable from a wish to have
    // none, and those are different facts.
    const cache = new MemoryCache(clock);
    const store = writeThrough(cache);

    expect(await store.read(OTHER)).toBeNull();
    // Written directly, bypassing the store — as another replica would.
    await durableStore().write(OTHER, { optOut: ['email'] });

    expect(await store.read(OTHER)).toEqual({ optOut: ['email'] });
  });
});

describe('app/routes.ts wires the DURABLE store, not the cache-only one', () => {
  /**
   * ==========================================================================
   * THE WIRING ASSERTION, AND IT IS THE ONE WITH NO OTHER WITNESS.
   *
   * `createNotifyModule` defaults `preferences` to
   * `createCachePreferencesStore` when the composition root passes nothing —
   * so every notify test in the repository was green while the durable store
   * was finished, correct and CONNECTED TO NOTHING. That is the same shape as
   * the unwired audit port, the unwired metrics sink and the unwired
   * `TimeoutRule.retries` before it: the component works, and it is not
   * plugged in.
   *
   * Observed end-to-end rather than by inspecting the module, because
   * `NotifyModule` deliberately does not expose its store. A row is written
   * DIRECTLY to `notification_preferences` — as another replica would, and as
   * nothing that touched this process's cache ever did — and then `send` is
   * asked to schedule a kind that goes by email. If routes.ts still passed the
   * cache-backed store, that row is invisible and email is scheduled.
   * ==========================================================================
   */
  it('honours an opt-out that exists ONLY in the database', async () => {
    const clock2 = new FixedClock('2026-08-09T09:00:00.000Z');
    const container = createContainer(
      parseConfig({
        NODE_ENV: 'test',
        DATABASE_URL: postgres.url,
        REDIS_URL: 'redis://localhost:6379',
        CORS_READ_ORIGINS: 'http://localhost:3000',
        CORS_WRITE_ORIGINS: 'http://localhost:3000',
        SESSION_COOKIE_NAME: 'foxxy_session',
        APP_URL: 'http://localhost:3000',
        API_URL: 'http://localhost:4000',
      }),
      {
        clock: clock2,
        logger: new FakeLogger(),
        // A FRESH cache with nothing in it. The opt-out below is reachable only
        // through Postgres, which is exactly the state `allkeys-lru` leaves the
        // process in after an eviction.
        cache: new MemoryCache(clock2),
        mail: new RecordingMail(),
      },
    );

    try {
      const modules = buildModules(container);

      // Written straight to the table, never through this process's cache.
      await postgres.client.query(
        `insert into notification_preferences (user_id, preferences)
         values ($1, $2::jsonb)`,
        [USER, JSON.stringify({ optOut: ['email'] })],
      );

      const result = await modules.notify.service.send({
        recipientUserId: USER,
        kind: 'digest_ready',
        title: { en: 'Your weekly digest', hi: 'आपका साप्ताहिक सारांश' },
        body: { en: 'It is ready.', hi: 'यह तैयार है।' },
      });

      // `digest_ready` routes to email and to nothing else, so an honoured
      // opt-out leaves nothing scheduled. With the cache-only store this reads
      // `['email']`.
      expect(result.scheduledChannels).toEqual([]);
    } finally {
      await container.shutdown();
    }
  }, 60_000);
});

describe('the notifications index matches the cursor that reads it — D-259', () => {
  it('carries all three sort columns, in order', async () => {
    /**
     * The list is paged by `(created_at desc, id desc)` because `created_at`
     * alone is NOT UNIQUE — two notifications written in one transaction share
     * a timestamp, and a cursor naming fewer columns than the sort skips rows
     * at the page boundary. D-259 fixed the cursor; this is the index half.
     *
     * Read back from `pg_indexes` rather than from the migration file, because
     * the question is what the DATABASE has after the whole chain has run, not
     * what one file says.
     */
    const result = await postgres.client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where tablename = 'notifications' and indexname = 'notifications_recipient_created_idx'`,
    );
    const def = result.rows[0]?.indexdef ?? '';

    expect(def).toMatch(/recipient_user_id/);
    expect(def).toMatch(/created_at DESC/);
    expect(def).toMatch(/id DESC/);
    // Order matters: `(recipient, created_at, id)` and not some other permutation.
    expect(def.indexOf('recipient_user_id')).toBeLessThan(def.indexOf('created_at'));
    expect(def.indexOf('created_at')).toBeLessThan(def.lastIndexOf('id DESC'));
  });

  it('leaves exactly ONE index on that leading column pair', async () => {
    // A leftover two-column index on the same leading columns would be chosen
    // by the planner about as often as the three-column one, and the change
    // would appear to have done nothing.
    const result = await postgres.client.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where tablename = 'notifications'`,
    );
    const onRecipientAndCreated = result.rows.filter(
      (row) => row.indexdef.includes('recipient_user_id') && row.indexdef.includes('created_at'),
    );
    expect(onRecipientAndCreated).toHaveLength(1);
  });
});
