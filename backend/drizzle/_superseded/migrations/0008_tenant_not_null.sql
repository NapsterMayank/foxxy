-- 0008_tenant_not_null — backfill every student-owned `tenant_id` and make the
-- column NOT NULL. Decision D-073.
--
-- Hand-written, then checked against the drizzle schema (plan §4, rule 1). The
-- backfill cannot be generated: drizzle-kit emits `SET NOT NULL` and nothing
-- else, which on a table holding a single NULL row fails at deploy time rather
-- than at review time.
--
-- ===========================================================================
-- WHY THIS EXISTS AT ALL, GIVEN 0004 ALREADY ADDED THE COLUMN.
--
-- 0004 added `tenant_id` NULLABLE with a default and put the enforcement in
-- `platform/authz`, where the rule was "deny when BOTH sides carry a tenant and
-- they differ". D-073 records why that is not an acceptable resting state:
--
--   `tenant_id` was added early, ahead of need, for exactly one reason — to
--   avoid a migration across every table, query and authorisation check once
--   real student data exists. A NULLABLE column with a LENIENT guard does not
--   avoid that migration. IT DEFERS IT, and it does so while reading as
--   complete. That is the worst of both: the cost is still owed, and the
--   tracker says it is paid.
--
-- The cost of doing it now is this file, on empty tables. The cost of doing it
-- later is the same file on live student rows, with a rewrite, a lock, and a
-- window in which some reads are tenant-scoped and some are not.
--
-- ===========================================================================
-- THE DEFAULT STAYS, AND IT IS NOT A LICENCE TO OMIT THE VALUE.
--
-- Every column below keeps the `DEFAULT '1111…'` that 0004 gave it. Two
-- reasons, and neither is "so inserts can skip it":
--
--   1. It is what makes `SET NOT NULL` a metadata-only change here and on any
--      future column addition — Postgres 11+ fills from a non-volatile default
--      without rewriting the table.
--   2. It keeps a hand-written INSERT in a psql session working, which is what
--      a DBA doing a repair at 2am actually needs.
--
-- APPLICATION INSERTS SUPPLY THE TENANT EXPLICITLY, FROM THE AUTHENTICATED
-- ACTOR, and never from client input. That is enforced in the modules and
-- proven by tests, not by this file — a default cannot tell the difference
-- between "not supplied" and "supplied and happens to be the default", so it
-- can never be the thing that enforces the rule. If it ever became the only
-- mechanism, every row would silently be filed under the default tenant, which
-- is exactly the failure this whole hook exists to prevent.
--
-- ===========================================================================
-- THE BACKFILL IS A NO-OP TODAY AND IS WRITTEN ANYWAY.
--
-- Every existing row already carries the default, because 0004's column default
-- applied to them. The UPDATEs below therefore touch nothing. They are here
-- because a migration that is correct only when it happens to run against a
-- database in one particular state is a migration that fails the first time it
-- meets a different one — a row inserted by a script that named the column
-- explicitly as NULL, say. `where tenant_id is null` makes each one idempotent
-- and free.

UPDATE "users" SET "tenant_id" = '11111111-1111-4111-8111-111111111111' WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "parent_child_links" SET "tenant_id" = '11111111-1111-4111-8111-111111111111' WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "students" SET "tenant_id" = '11111111-1111-4111-8111-111111111111' WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "student_subjects" SET "tenant_id" = '11111111-1111-4111-8111-111111111111' WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "chapter_mastery" SET "tenant_id" = '11111111-1111-4111-8111-111111111111' WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "question_responses" SET "tenant_id" = '11111111-1111-4111-8111-111111111111' WHERE "tenant_id" IS NULL;--> statement-breakpoint

-- `SET NOT NULL` is idempotent: applying it to a column that already has the
-- constraint is accepted and does nothing.
ALTER TABLE "users" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "parent_child_links" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "students" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "student_subjects" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chapter_mastery" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "question_responses" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint

-- ===========================================================================
-- INDEXES: ALREADY PRESENT, DELIBERATELY NOT DUPLICATED.
--
-- 0004 created a single-column btree on `tenant_id` for all six tables, which
-- is what the "everything in this tenant" reads need. No composite index is
-- added here: the only composite worth having is one that serves a query that
-- exists, and every tenant-filtered query in the product today is either that
-- single-column scan or a primary-key lookup whose leading column is already
-- the student. Adding `(tenant_id, user_id)` now would cost every write to
-- answer nothing.
--
-- `audit_log` and `notifications` also carry a nullable `tenant_id` (0005,
-- 0007) and are DELIBERATELY LEFT ALONE. Neither is student-owned data reached
-- through `assertCanAccess`, and neither has a writer that knows a tenant yet:
-- `audit_log` records system actions whose actor is null by design (D-063), and
-- the in-app notification channel is handed a recipient and nothing else. They
-- are tracked as an open item rather than tightened here, because a NOT NULL
-- column whose only writer relies on the column default is theatre of exactly
-- the kind D-073 exists to reject.

COMMENT ON COLUMN "users"."tenant_id" IS
	'Which tenant this ACCOUNT belongs to. NOT NULL since migration 0008 (D-073). This is the ACTOR side of the tenant comparison in platform/authz - assertCanAccess denies when it differs from the resource tenant, AND when either side is missing, before any allow rule is considered.';--> statement-breakpoint
COMMENT ON COLUMN "students"."tenant_id" IS
	'Which tenant this student belongs to. NOT NULL since migration 0008. Written from the authenticated actor on every insert path, never from client input.';--> statement-breakpoint
COMMENT ON COLUMN "parent_child_links"."tenant_id" IS
	'The tenant a parent-child link belongs to. NOT NULL since migration 0008. A link is the only cross-user data path in the product, so the identity module refuses to create one whose parent and student are in different tenants - the row can therefore only ever hold one tenant, and it is both parties.';--> statement-breakpoint
COMMENT ON COLUMN "question_responses"."tenant_id" IS
	'Denormalised from students.tenant_id so cohort-level aggregates do not join. NOT NULL since migration 0008. A stale copy is a reporting bug; a forgotten join would be a data leak.';
