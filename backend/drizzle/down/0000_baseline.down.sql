-- Rollback for drizzle/migrations/0000_baseline.sql
--
-- Drizzle does not generate down migrations, so each one is written by hand and
-- lives here under the same number. Plan §4, rule 4: every migration must run
-- forward AND backward against a copy of the schema in CI.
--
-- ===========================================================================
-- THIS ONE ROLLS BACK THE ENTIRE SCHEMA, AND THAT IS THE POINT.
--
-- The baseline creates every table the product has. Its rollback therefore
-- empties the database, which is a far larger operation than any of the nine
-- superseded down migrations it replaces — those could each be run against a
-- populated database and lose only their own slice. This one cannot: rolling
-- the baseline back is only ever legitimate against a database that has just
-- had it applied, which in practice means a test.
--
-- It is kept, run, and asserted anyway (`baseline-collapse.test.ts` applies it
-- and re-applies the baseline on top), because a forward migration nobody has
-- ever reversed is a forward migration whose object list has quietly drifted
-- from the schema. That drift is what this file exists to catch — a table
-- created by the baseline and missing from here leaves a stray table behind,
-- and the re-apply then fails on "already exists".
--
-- ===========================================================================
-- Order: children before parents, because of the foreign keys. `tenants` is
-- last of the tables because six of them reference it ON DELETE RESTRICT.
--
-- Dropping a table takes its indexes, CHECK constraints, foreign keys, triggers
-- and COMMENTs with it, so none of those needs a statement of its own — except
-- the trigger FUNCTION, which is a schema-level object and outlives the table.
--
-- EXTENSIONS ARE DELIBERATELY NOT DROPPED. `vector` and `citext` may be shared
-- with anything else in the database, and dropping an extension out from under
-- another object turns a rollback into an outage. Creating them is idempotent
-- (`IF NOT EXISTS`), so leaving them costs a re-apply nothing.

DROP TABLE IF EXISTS "question_responses";--> statement-breakpoint
DROP TABLE IF EXISTS "chapter_mastery";--> statement-breakpoint
DROP TABLE IF EXISTS "student_subjects";--> statement-breakpoint
DROP TABLE IF EXISTS "questions";--> statement-breakpoint
DROP TABLE IF EXISTS "rag_chunks";--> statement-breakpoint
DROP TABLE IF EXISTS "chapters";--> statement-breakpoint
DROP TABLE IF EXISTS "students";--> statement-breakpoint
DROP TABLE IF EXISTS "class_enrolments";--> statement-breakpoint
DROP TABLE IF EXISTS "classes";--> statement-breakpoint
DROP TABLE IF EXISTS "schools";--> statement-breakpoint
DROP TABLE IF EXISTS "jobs";--> statement-breakpoint
DROP TABLE IF EXISTS "worker_heartbeats";--> statement-breakpoint
DROP TABLE IF EXISTS "metrics_events";--> statement-breakpoint
DROP TABLE IF EXISTS "notifications";--> statement-breakpoint
DROP TABLE IF EXISTS "audit_log";--> statement-breakpoint
DROP TABLE IF EXISTS "link_codes";--> statement-breakpoint
DROP TABLE IF EXISTS "parent_child_links";--> statement-breakpoint
DROP TABLE IF EXISTS "password_reset_tokens";--> statement-breakpoint
DROP TABLE IF EXISTS "email_verification_tokens";--> statement-breakpoint
DROP TABLE IF EXISTS "sessions";--> statement-breakpoint
DROP TABLE IF EXISTS "users";--> statement-breakpoint
DROP TABLE IF EXISTS "tenants";--> statement-breakpoint
-- The trigger function is not owned by any table and survives the DROP TABLE
-- that removed its two triggers. Leaving it behind would make the re-apply's
-- CREATE OR REPLACE a no-op rather than a creation, which is exactly the kind
-- of "the rollback nearly worked" state this file exists to avoid.
DROP FUNCTION IF EXISTS "audit_log_reject_mutation"();
