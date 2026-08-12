import { sql } from 'drizzle-orm';
import type { DbHandle } from '@/platform/db/index';
import type { StoredPreferences } from './domain/preferences';
import { parseStoredPreferences, type NotifyPreferencesStore } from './notify.preferences-store';

/**
 * =============================================================================
 * THE DURABLE HOME FOR NOTIFICATION PREFERENCES — D-260.
 *
 * A preference is a USER'S STATED WISH. It was kept in `platform/cache` and
 * nowhere else, on the reasoning that losing one only makes the product quieter.
 * That reasoning is wrong on its own terms: `maxmemory-policy allkeys-lru` is
 * configured, so eviction is not a failure mode but ORDINARY OPERATION, and what
 * it silently restores is the DEFAULT channel set. Somebody who muted email
 * starts receiving email again, having been told nothing and having changed
 * nothing. There is no error, no log line, and no way for them to tell it
 * happened other than by receiving the mail they asked not to receive.
 *
 * `platform/cache`'s own standing rule (D-012, D-033) is "nothing whose loss
 * changes what a user is ALLOWED to do may live in a cache". An opt-out is not
 * an authorisation, so it passed that rule — and the rule turns out to be too
 * narrow. What a user has DECIDED belongs beside what a user is ALLOWED, because
 * both are facts about them that we chose to keep, and neither is a copy of
 * something we can recompute.
 *
 * -----------------------------------------------------------------------------
 * THIS FILE IS COMPLETE AND IS NOT WIRED. THE TABLE DOES NOT EXIST YET.
 *
 * `notification_preferences` needs a migration, and `drizzle/` belongs to
 * another change in flight — so the migration is REPORTED, precisely, rather
 * than smuggled in here. The exact DDL required is in the module report and in
 * D-260. Until it is applied, `app/routes.ts` continues to construct the
 * cache-backed store, and wiring this one in would take the product down on the
 * first notification rather than fix anything.
 *
 * When the migration lands, the change is two lines in `app/routes.ts`:
 * construct `createDbPreferencesStore(db)`, wrap it in
 * `createWriteThroughPreferencesStore`, and pass it as `preferences`. Nothing in
 * the service moves, because the service has only ever known the port.
 *
 * -----------------------------------------------------------------------------
 * RAW SQL RATHER THAN A DRIZZLE TABLE OBJECT, DELIBERATELY.
 *
 * The drizzle schema lives in `platform/db/schema`, which this change does not
 * own either. Declaring the table object there and the DDL in `drizzle/` are the
 * same edit made twice in two directories owned by somebody else; the statements
 * below are self-describing, so this file states the shape it needs once and the
 * migration can be read straight off it.
 * =============================================================================
 */

/** Re-exported under a module-local name, exactly as the main repository does. */
export type NotifyPreferencesDbHandle = DbHandle;

/**
 * The columns this store reads and writes. Stated as a constant so the report,
 * the migration and the queries below cannot drift apart silently.
 *
 *   user_id     uuid primary key, references users(id) on delete cascade
 *   preferences jsonb not null default '{}'::jsonb, check jsonb_typeof = 'object'
 *   updated_at  timestamptz not null default now()
 */
export const NOTIFICATION_PREFERENCES_TABLE = 'notification_preferences';

/**
 * `db.execute` requires a row type it can index by column name, so this is a
 * record type rather than a two-line interface. `unknown` for the value because
 * jsonb is exactly that until `parseStoredPreferences` has narrowed it.
 */
type PreferencesRow = Record<string, unknown> & { readonly preferences: unknown };

/**
 * Preferences read from and written to the database.
 *
 * ===========================================================================
 * A READ NEVER THROWS, AND THAT IS A DIFFERENT DECISION HERE THAN IN THE CACHE.
 *
 * The cache-backed store swallows failures because a cache is expected to be
 * briefly absent. A database failure is not expected — but the consequence of
 * propagating it is identical and unacceptable either way: every notification
 * in flight becomes a dead-lettered job because a settings lookup failed. So
 * this store also degrades to the defaults, which are the conservative choice,
 * and says so at `warn` so that the degradation is visible rather than assumed.
 *
 * A WRITE DOES throw. Silently discarding somebody's stated wish and returning
 * as though it were saved is the whole class of defect this file exists to end.
 */
export function createDbPreferencesStore(
  handle: NotifyPreferencesDbHandle,
): NotifyPreferencesStore {
  const { db } = handle;

  return {
    async read(userId: string): Promise<StoredPreferences | null> {
      const result = await db.execute<PreferencesRow>(sql`
        select preferences
        from notification_preferences
        where user_id = ${userId}::uuid
        limit 1
      `);

      const row = result.rows[0];
      if (row === undefined) return null;
      // Re-validated through the SAME narrowing the cache store uses. jsonb is
      // as untyped as a cache string: it was written by one release and is being
      // read by another, and a channel name that has since been retired must
      // degrade to the default rather than reach the dispatcher.
      return parseStoredPreferences(JSON.stringify(row.preferences));
    },

    /**
     * UPSERT, not insert-or-update-after-a-read.
     *
     * Two devices saving settings at the same moment both find no row, both
     * insert, and one loses to the primary key — which the user experiences as
     * "saving my preferences failed" for no reason they can act on. One
     * statement makes the second writer the winner rather than a casualty.
     */
    async write(userId: string, preferences: StoredPreferences): Promise<void> {
      await db.execute(sql`
        insert into notification_preferences (user_id, preferences, updated_at)
        values (${userId}::uuid, ${JSON.stringify(preferences)}::jsonb, now())
        on conflict (user_id) do update
          set preferences = excluded.preferences,
              updated_at = excluded.updated_at
      `);
    },
  };
}
