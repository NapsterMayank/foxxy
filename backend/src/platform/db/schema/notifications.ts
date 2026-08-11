import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { tenants } from './tenants';

/**
 * notifications — the row the `in-app` notification channel writes.
 *
 * 05-ROADMAP.md §8: the notification CHANNEL PORT is a Phase 0 hook, priced at
 * half a day now against "rewrite every call site" later. `platform/notify-channel`
 * is that port; this table is the storage its in-app adapter needs, and it is
 * the only table the port owns.
 *
 * ===========================================================================
 * BOTH LANGUAGES ARE NOT NULL. This is P7 made structural.
 *
 * Every user-facing string in this product ships in Hindi and English. The
 * usual way that rule decays is a notification added in a hurry with English
 * only and a `// TODO: hi` that outlives the person who wrote it — and it
 * decays invisibly, because an English-only notification renders perfectly
 * well for the person who wrote it.
 *
 * So both are enforced twice, at two different layers, on purpose:
 *
 *   AT THE TYPE LEVEL, `BilingualText` in `platform/notify-channel` requires
 *   both `en` and `hi`. A single-language message does not compile.
 *
 *   AT THE DATABASE LEVEL, all four columns are NOT NULL with a non-empty
 *   CHECK. That is what catches the import script, the psql session and the
 *   future service written in a language the type system cannot see.
 *
 * Neither layer alone is enough: types do not survive a raw INSERT, and a
 * CHECK does not stop `hi: ''` being written deliberately to get past it, which
 * is why the check is `length(btrim(...)) > 0` rather than merely NOT NULL.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
    /** What kind of message this is. Drives dispatch policy — see the port. */
    kind: text('kind').notNull(),
    titleEn: text('title_en').notNull(),
    bodyEn: text('body_en').notNull(),
    titleHi: text('title_hi').notNull(),
    bodyHi: text('body_hi').notNull(),
    /**
     * Structured payload for the client to act on — ids and counts, never
     * prose and never PII. Scrubbed through `platform/pii` on the way in, the
     * same as `audit_log.metadata`.
     */
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('notifications_kind_check', sql`length(btrim(${table.kind})) > 0`),
    // One constraint covering all four, so a violation names "both languages"
    // rather than naming whichever column happened to be checked first.
    check(
      'notifications_bilingual_check',
      sql`length(btrim(${table.titleEn})) > 0
          and length(btrim(${table.bodyEn})) > 0
          and length(btrim(${table.titleHi})) > 0
          and length(btrim(${table.bodyHi})) > 0`,
    ),
    check('notifications_data_object_check', sql`jsonb_typeof(${table.data}) = 'object'`),
    /**
     * The only read shape: "my notifications, newest first" — D-259/D-268.
     *
     * THREE COLUMNS, NOT TWO, and the third is the whole point. The list is
     * paged with a COMPOSITE CURSOR that sorts by `(created_at desc, id desc)`,
     * because `created_at` alone is not unique: two notifications written in
     * the same transaction share a timestamp, and a cursor that names fewer
     * columns than the sort SKIPS ROWS at the page boundary — silently, and
     * only for the users who have enough notifications to page.
     *
     * D-259 fixed the cursor and left the index at `(recipient_user_id,
     * created_at desc)`, so correctness stopped depending on this and
     * PERFORMANCE started to: Postgres can satisfy the first two sort keys from
     * the index and then has to sort each group by `id` itself. The index now
     * matches the ORDER BY exactly, which is what makes the page a plain
     * index scan again.
     */
    index('notifications_recipient_created_idx').on(
      table.recipientUserId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    /** The unread badge, which is a count over a small partial index. */
    index('notifications_unread_idx')
      .on(table.recipientUserId)
      .where(sql`read_at is null`),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;

/**
 * =============================================================================
 * notification_preferences — WHAT A USER HAS DECIDED, KEPT DURABLY. D-260.
 *
 * Preferences lived in `platform/cache` AND NOWHERE ELSE, justified on record
 * with "a lost preference makes the product QUIETER, never louder". Both halves
 * of that are wrong:
 *
 *   - `maxmemory-policy allkeys-lru` is configured, so eviction is ORDINARY
 *     OPERATION rather than an incident. A preference key is touched rarely and
 *     is therefore among the first things evicted, by construction.
 *   - the DEFAULT is no opt-outs, so reverting to it is the LOUDER outcome.
 *     Somebody who muted email starts receiving email again, having changed
 *     nothing and been told nothing. No error, no log line, and no way for them
 *     to notice except by receiving the mail they asked us not to send.
 *
 * THIS NARROWS THE STANDING RULE. D-012/D-033 say "nothing whose loss changes
 * what a user is ALLOWED to do may live in a cache", and an opt-out passed that
 * test because an opt-out is not an authorisation. The rule was too narrow:
 * WHAT A USER HAS DECIDED BELONGS BESIDE WHAT A USER IS ALLOWED. Neither can be
 * recomputed from anything else we hold, and losing either loses something they
 * gave us.
 *
 * -----------------------------------------------------------------------------
 * WHY THE SHAPE IS THIS AND NOT A COLUMN PER CHANNEL.
 *
 * `preferences` is one jsonb document rather than `email_enabled boolean,
 * whatsapp_enabled boolean, …`. Channels are added by `platform/notify-channel`
 * (`whatsapp` and `push` already exist as adapters), and a column per channel
 * makes every new one a migration plus a deploy ordering problem. The document
 * is narrowed by `parseStoredPreferences` on the way out, so the type safety
 * lives at the boundary where it can also cope with a row written by an older
 * version of the code.
 *
 * The CHECK is what stops that flexibility becoming formlessness: jsonb accepts
 * `'"muted"'`, `'null'` and `'[]'` as perfectly valid documents, and every one
 * of them would reach `parseStoredPreferences` as a shape it has to defend
 * against forever. `jsonb_typeof = 'object'` makes the column mean what its
 * name says. It matches `notifications_data_object_check` and
 * `audit_log.metadata` above — same reasoning, third instance.
 *
 * NO SEPARATE `id`: the user IS the key. A surrogate key would permit two
 * preference rows for one user, which is not a state that can be resolved —
 * whichever one you read, the other is also a thing they said.
 *
 * ON DELETE CASCADE, matching `notifications` itself: a deleted user's stated
 * wish about notifications is not a record worth keeping, and keeping it would
 * make the row an orphan referencing a person who has asked to be forgotten.
 * =============================================================================
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    preferences: jsonb('preferences')
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'notification_preferences_object_check',
      sql`jsonb_typeof(${table.preferences}) = 'object'`,
    ),
  ],
);

export type NotificationPreferencesRow = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreferencesRow = typeof notificationPreferences.$inferInsert;
