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
    /** The only read shape: "my notifications, newest first". */
    index('notifications_recipient_created_idx').on(
      table.recipientUserId,
      table.createdAt.desc(),
    ),
    /** The unread badge, which is a count over a small partial index. */
    index('notifications_unread_idx')
      .on(table.recipientUserId)
      .where(sql`read_at is null`),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;
