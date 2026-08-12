-- 0006_notify_preferences — the durable home for notification preferences,
-- and the index that finally matches the cursor that reads them. D-260, D-259.
--
-- ===========================================================================
-- WHAT THIS MIGRATION IS FOR.
--
-- Notification preferences were held in `platform/cache` AND NOWHERE ELSE, on
-- the record that "a lost preference makes the product QUIETER, never louder".
-- Both halves of that are wrong:
--
--   * `maxmemory-policy allkeys-lru` is configured, so eviction is ORDINARY
--     OPERATION, not an incident. A preference key is written once and read
--     rarely, which makes it among the first things evicted BY CONSTRUCTION.
--   * the default is NO opt-outs, so reverting to the default is the LOUDER
--     outcome. Somebody who muted email starts receiving email again, having
--     changed nothing and been told nothing. No error, no log line, and no way
--     for them to find out except by receiving the mail they asked us not to
--     send.
--
-- `createDbPreferencesStore` and `createWriteThroughPreferencesStore` have been
-- finished and DELIBERATELY UNWIRED since D-260, because this table did not
-- exist. This is the migration that was reported there, applied.
--
-- ===========================================================================
-- SAFE TO APPLY TO THE DATABASE HOLDING THE CORPUS.
--
-- One CREATE TABLE, one foreign key, and one index REPLACED with a wider one on
-- the same columns plus a third. Nothing is dropped, no column changes type, no
-- row is rewritten, and no existing query stops being satisfiable. The corpus
-- tables (`chapters`, `rag_chunks`, `questions`) are not referenced at all.
--
-- ===========================================================================
-- THE INDEX CHANGE — D-259's other half.
--
-- `notifications_recipient_created_idx` was `(recipient_user_id, created_at
-- desc)`. The notification list is paged with a COMPOSITE CURSOR that sorts by
-- `(created_at desc, id desc)`, because `created_at` alone is NOT UNIQUE: two
-- notifications written in the same transaction share a timestamp to the
-- microsecond, and a cursor naming fewer columns than the sort SKIPS ROWS at
-- the page boundary.
--
-- D-259 fixed the cursor, so CORRECTNESS no longer depends on this index —
-- PERFORMANCE does. With two columns Postgres satisfies the first two sort keys
-- from the index and then sorts each equal-timestamp group by `id` itself; with
-- three it is a plain index scan. This is the "the plan wants it" half that
-- D-259 recorded as outstanding.
--
-- DROP-THEN-CREATE RATHER THAN A SECOND INDEX, and the order matters: the drop
-- comes first so the two never coexist, because a leftover two-column index on
-- the same leading columns would be chosen by the planner about as often as the
-- three-column one and the change would appear to have done nothing. Both
-- statements are inside the migration's transaction, so a reader is never
-- served by a missing index — the table is locked for the duration instead, and
-- `notifications` is small enough that this is measured in milliseconds.
-- ===========================================================================

CREATE TABLE "notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- jsonb accepts `'"muted"'`, `'null'` and `'[]'` as perfectly valid
	-- documents. Every one of them would reach `parseStoredPreferences` as a
	-- shape it has to defend against forever. This makes the column mean what
	-- its name says, and matches `notifications_data_object_check` and
	-- `audit_log.metadata` — same reasoning, third instance.
	CONSTRAINT "notification_preferences_object_check" CHECK (jsonb_typeof("notification_preferences"."preferences") = 'object')
);
--> statement-breakpoint
DROP INDEX "notifications_recipient_created_idx";--> statement-breakpoint
-- ON DELETE CASCADE, matching `notifications` itself. A deleted user's stated
-- wish about notifications is not a record worth keeping, and keeping it would
-- leave a row referencing a person who has asked to be forgotten.
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "notifications" USING btree ("recipient_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
