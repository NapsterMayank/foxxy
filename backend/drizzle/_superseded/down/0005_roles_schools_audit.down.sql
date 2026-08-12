-- Rollback for drizzle/migrations/0005_roles_schools_audit.sql
--
-- Reverses all three parts, children before parents:
--
--   class_enrolments -> classes, users
--   classes          -> schools
--   schools          -> tenants   (migration 0004 — untouched)
--   audit_log        -> tenants   (plus two triggers and their function)
--
-- Dropping a table drops its indexes, its CHECKs, its foreign keys AND its
-- triggers; only the trigger FUNCTION is independent of the table and needs a
-- statement of its own.
--
-- ===========================================================================
-- THE ROLE CHECK NARROWS BACK TO TWO VALUES, AND THAT CAN FAIL. On purpose.
--
-- Restoring `in ('student','parent')` VALIDATES THE EXISTING ROWS. If any
-- account has been created with one of the eight widened roles, the ALTER
-- aborts and the rollback stops — with the wider constraint still in place,
-- because a failed ALTER TABLE rolls back cleanly.
--
-- That is the correct outcome and it is worth being explicit about why:
-- narrowing the constraint while a `teacher` row exists would either have to
-- delete that account or leave the table permanently violating its own CHECK.
-- Both are worse than a rollback that refuses. If this is ever hit, the
-- question to answer first is why a role that has no module was granted at all.
--
-- Free while only students and parents exist, which is the same window in which
-- the forward migration is free.

DROP TABLE IF EXISTS "class_enrolments";--> statement-breakpoint
DROP TABLE IF EXISTS "classes";--> statement-breakpoint
DROP TABLE IF EXISTS "schools";--> statement-breakpoint
DROP TABLE IF EXISTS "audit_log";--> statement-breakpoint
DROP FUNCTION IF EXISTS "audit_log_reject_mutation"();--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_role_check";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" in ('student', 'parent'));--> statement-breakpoint
COMMENT ON COLUMN "users"."role" IS NULL;
