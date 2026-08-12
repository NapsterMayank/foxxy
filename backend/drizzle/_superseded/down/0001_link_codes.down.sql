-- Rollback for drizzle/migrations/0001_link_codes.sql
--
-- Drizzle does not generate down migrations, so each one is written by hand
-- and lives here under the same number. Plan §4, rule 4: every migration must
-- run forward AND backward against a copy of the schema in CI.
--
-- Order is the reverse of the forward migration: restore the column first,
-- then drop the table. Indexes go with the table, so they need no statement of
-- their own.
--
-- NOT RECOVERABLE: rolling this back discards every issued link code. That is
-- acceptable — a code lives 15 minutes, and the worst outcome is a student
-- asking for a new one. It is stated here rather than discovered during the
-- rollback.

ALTER TABLE "parent_child_links" ADD COLUMN IF NOT EXISTS "code_expires_at" timestamp with time zone;--> statement-breakpoint
DROP TABLE IF EXISTS "link_codes";
