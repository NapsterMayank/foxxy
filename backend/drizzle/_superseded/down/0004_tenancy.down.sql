-- Rollback for drizzle/migrations/0004_tenancy.sql
--
-- Drizzle does not generate down migrations, so each one is written by hand and
-- lives here under the same number. Plan §4, rule 4: every migration must run
-- forward AND backward against a copy of the schema in CI.
--
-- Order is the reverse of the forward migration, and it has to be: every
-- `tenant_id` column carries a foreign key to `tenants`, so the columns go
-- first and the table they reference goes last. Dropping `tenants` while any
-- of them still exists is refused by those constraints — which is precisely
-- what ON DELETE RESTRICT is for, applied at DDL time.
--
-- Dropping a column drops its index and its foreign key with it; neither needs
-- a statement of its own.
--
-- WHAT ROLLING THIS BACK LOSES, stated plainly: every row's tenant assignment.
-- While the product is single-tenant that is exactly one distinct value and
-- re-applying the forward migration restores it from the default. THE MOMENT A
-- SECOND TENANT EXISTS, THAT STOPS BEING TRUE — re-applying would file every
-- row under the default tenant, silently, with no error and no way to tell
-- which rows were wrong. If this rollback is ever considered against an
-- environment with more than one tenant, dump the (id, tenant_id) pairs of all
-- six tables first, and treat re-application as a data migration rather than as
-- running a file.

ALTER TABLE "question_responses" DROP COLUMN IF EXISTS "tenant_id";--> statement-breakpoint
ALTER TABLE "chapter_mastery" DROP COLUMN IF EXISTS "tenant_id";--> statement-breakpoint
ALTER TABLE "student_subjects" DROP COLUMN IF EXISTS "tenant_id";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN IF EXISTS "tenant_id";--> statement-breakpoint
ALTER TABLE "parent_child_links" DROP COLUMN IF EXISTS "tenant_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "tenant_id";--> statement-breakpoint
DROP TABLE IF EXISTS "tenants";
