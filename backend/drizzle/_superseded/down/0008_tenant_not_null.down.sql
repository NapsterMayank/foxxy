-- Rollback for drizzle/migrations/0008_tenant_not_null.sql
--
-- Drizzle does not generate down migrations, so each one is written by hand and
-- lives here under the same number. Plan §4, rule 4: every migration must run
-- forward AND backward against a copy of the schema in CI.
--
-- Order does not matter here — the six statements are independent, none of them
-- touches a constraint another depends on, and `DROP NOT NULL` on a column that
-- is already nullable is accepted and does nothing. Listed in the reverse of
-- the forward order anyway, so the two files read as mirrors.
--
-- WHAT ROLLING THIS BACK LOSES: nothing in the data. The column, the default,
-- the foreign key and the index all survive; only the NOT NULL constraint is
-- dropped, and every row keeps the tenant it had.
--
-- WHAT IT LOSES IN ENFORCEMENT, WHICH IS THE PART THAT MATTERS. The application
-- does NOT relax with it. `platform/authz` denies a missing tenant on either
-- side regardless of what the column permits, and `Actor.tenantId` is a
-- required type. So a database rolled back to here and left there does not
-- quietly return to the lenient behaviour of 0004 — it accepts rows the
-- application will subsequently refuse to serve, which is a loud failure on the
-- next read rather than a silent one. That is the intended asymmetry: a
-- rollback of the SCHEMA must never be a rollback of the BOUNDARY.

ALTER TABLE "question_responses" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chapter_mastery" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "student_subjects" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "students" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "parent_child_links" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "tenant_id" DROP NOT NULL;
