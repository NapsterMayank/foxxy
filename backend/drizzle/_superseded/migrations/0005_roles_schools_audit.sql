-- 0005_roles_schools_audit — the widened `users.role` CHECK, the
-- `schools`/`classes`/`class_enrolments` stub, and the append-only `audit_log`.
--
-- Hand-written, then checked against the drizzle schema (plan §4, rule 1).
--
-- 05-ROADMAP.md §8 prices these three together: "3 d now against ~8 d plus a
-- live-data migration later". They are one migration because they are one
-- decision — the shape of the school pilot the client actually specified.
--
-- ===========================================================================
-- PART 1 — THE ROLE CHECK WIDENS FROM TWO VALUES TO TEN.
--
-- NOTHING ABOUT WHAT ANYONE CAN DO CHANGES. This alters what the COLUMN will
-- accept, and nothing else. There is no teacher module, no principal module, no
-- role granting anywhere, and `platform/authz` has an explicit branch that
-- denies every role except `student` and `parent` — so a row inserted with
-- `role = 'teacher'` today can read nothing at all.
--
-- SIGNUP STILL ACCEPTS EXACTLY TWO ROLES. That is enforced by `roleSchema` in
-- `shared/contracts/identity.contract.ts`, which is built from `SIGNUP_ROLES`
-- and NOT from `PLATFORM_ROLES`. They are separate constants in
-- `shared/constants/roles.ts` on purpose, and a test drives all eight new roles
-- at POST /auth/signup and asserts a 400 for each. That test is the whole
-- defence: the day somebody "simplifies" the contract to point at
-- `PLATFORM_ROLES`, it compiles, it inserts, and the internet has a
-- `super_admin` dropdown. Only the test notices.
--
-- WHY NOW RATHER THAN WITH THE FIRST TEACHER. Widening a CHECK constraint takes
-- an ACCESS EXCLUSIVE lock and, without the NOT VALID dance, a full validation
-- scan. On a table of a few dozen development accounts that is imperceptible.
-- On the users table of a live school pilot it is a write-blocking operation
-- during which nobody can sign up or log in — scheduled, announced, and
-- rehearsed. The same statement, eighteen months apart, is free or is a
-- maintenance window.
--
-- The list is not a privilege ordering. There is no ordering here, and any code
-- that infers one from the order of these literals is wrong.

ALTER TABLE "users" DROP CONSTRAINT "users_role_check";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" in ('student', 'parent', 'teacher', 'principal', 'content_author', 'academic_reviewer', 'implementation_manager', 'support_agent', 'school_success', 'super_admin'));--> statement-breakpoint
COMMENT ON COLUMN "users"."role" IS
	'One of PLATFORM_ROLES (shared/constants/roles.ts). The CHECK is wide so that adding a teacher in Phase 1 or a content author in Phase 4 is an INSERT rather than a locking migration on a live table. SELF-SERVICE SIGNUP ACCEPTS ONLY student AND parent - enforced by roleSchema, built from SIGNUP_ROLES, and pinned by a test. Do not point roleSchema at PLATFORM_ROLES.';--> statement-breakpoint

-- ===========================================================================
-- PART 2 — schools · classes · class_enrolments. STUBS.
--
-- Schema only. No module, no service, no routes, and none should be added until
-- Phase 1. Nothing in the running system reads or writes any of these three.
--
-- The eight days §8 quotes are not the cost of typing three CREATE TABLEs.
-- They are the cost of repointing `students`, every teacher query and every
-- authorisation check at a school that did not exist when they were written, on
-- a database containing real children's data. What lands now is the part that
-- is expensive to change later: the FOREIGN KEY DIRECTION and the COLUMN TYPES.
--
-- A stub's one real risk is that it looks finished. These are not finished:
-- there is no way to create a school and no way to enrol a student.

CREATE TABLE IF NOT EXISTS "schools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"board" text DEFAULT 'CBSE' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schools_name_check" CHECK (length(btrim("schools"."name")) > 0)
);
--> statement-breakpoint
-- NOT NULL here, unlike the retrofitted `tenant_id` columns in 0004. No school
-- row has ever existed, so there is nothing to stay compatible with and no
-- reason to accept the weaker constraint.
ALTER TABLE "schools" ADD CONSTRAINT "schools_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schools_tenant_idx" ON "schools" USING btree ("tenant_id");--> statement-breakpoint

-- GRADE IS TEXT here too, with the same CHECK as `students.grade`.
--
-- It would have been easy to leave the constraint off a stub "until it is
-- used". Plan §3's failure mode is exactly why not: an integer grade does not
-- error, it silently matches nothing. A stub with a looser rule than the table
-- it will eventually join against is a stub that imports bad data on its first
-- day of real use, and the symptom is an empty class list rather than an error.
--
-- `academic_year` is a text label ('2026-27') rather than a date range: it is
-- what a school CALLS the year, and the real boundaries differ by board and by
-- state.
CREATE TABLE IF NOT EXISTS "classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"grade" text NOT NULL,
	"section" text NOT NULL,
	"academic_year" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classes_grade_check" CHECK ("classes"."grade" in ('6', '7', '8', '9', '10', '11', '12')),
	CONSTRAINT "classes_section_check" CHECK (length(btrim("classes"."section")) > 0),
	CONSTRAINT "classes_academic_year_check" CHECK ("classes"."academic_year" ~ '^[0-9]{4}-[0-9]{2}$')
);
--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- One 8-A per school per year. Without this a re-import creates a second 8-A
-- and every enrolment afterwards is split across two classes — which reads as
-- "half the class stopped practising" on a teacher screen.
CREATE UNIQUE INDEX IF NOT EXISTS "classes_school_grade_section_year_unique" ON "classes" USING btree ("school_id","grade","section","academic_year");--> statement-breakpoint

-- Composite primary key: a student is either in a class or is not, so there is
-- nothing to distinguish two rows and no surrogate id worth the write cost.
--
-- IT POINTS AT `users`, NOT AT `students`. A child enrolled by a school roster
-- import has no `students` row until they finish onboarding, and the roster is
-- exactly the flow that creates accounts ahead of profiles. Pointing at
-- `students` would make a roster unimportable until every child had logged in,
-- which is backwards.
CREATE TABLE IF NOT EXISTS "class_enrolments" (
	"class_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "class_enrolments_pkey" PRIMARY KEY("class_id","student_user_id")
);
--> statement-breakpoint
ALTER TABLE "class_enrolments" ADD CONSTRAINT "class_enrolments_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_enrolments" ADD CONSTRAINT "class_enrolments_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The unindexed-FK cascade scan, same reasoning as `chapter_mastery_chapter_idx`
-- in 0002: without it, deleting a user sequentially scans this whole table.
CREATE INDEX IF NOT EXISTS "class_enrolments_student_idx" ON "class_enrolments" USING btree ("student_user_id");--> statement-breakpoint

-- ===========================================================================
-- PART 3 — audit_log. APPEND-ONLY, ENFORCED BY A TRIGGER.
--
-- `question_responses` is append-only by CONVENTION, and its header explains
-- why that was right there: one writer, and a trigger would have had to exempt
-- an FK cascade. Neither holds here. Every module will eventually write to this
-- table, so "one writer" is false on day one — and an audit log's entire value
-- is that it says what happened even when the person reading it would prefer it
-- said something else. A log the application can UPDATE is a log that a bug, or
-- a person with a database connection, can quietly correct.
--
-- `actor_user_id` HAS NO FOREIGN KEY, and that is load-bearing rather than an
-- omission. ON DELETE CASCADE would delete a user's audit trail on account
-- deletion — the one thing an audit log must never do — and it would do it with
-- a DELETE, which the trigger below refuses, so account deletion would simply
-- fail. ON DELETE SET NULL fails identically: it is an UPDATE. ANY referential
-- action turns "delete my account" into "the audit trigger raised". So the
-- column is a bare uuid and the trail outlives the actor.
--
-- `tenant_id` keeps its foreign key: RESTRICT never writes to this table.
--
-- NO PII. `metadata` HOLDS IDENTIFIERS AND COUNTS. This is not a style
-- preference. The table records actions taken against MINORS' accounts, it is
-- the artefact handed to a school or a regulator, and it is the one table that
-- is never deleted — which makes it the worst possible place to keep an email
-- address. The rule is enforced in `platform/audit`, which scrubs every payload
-- through `platform/pii` before the insert: PII-shaped KEYS are dropped and
-- PII-shaped VALUES are redacted. A test drives an email address and a phone
-- number through `record()` and asserts neither reaches the row.

CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_role" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"tenant_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_check" CHECK (length(btrim("audit_log"."action")) > 0),
	CONSTRAINT "audit_log_resource_type_check" CHECK (length(btrim("audit_log"."resource_type")) > 0),
	CONSTRAINT "audit_log_metadata_object_check" CHECK (jsonb_typeof("audit_log"."metadata") = 'object')
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- "What happened in this tenant, newest first" — the compliance read.
CREATE INDEX IF NOT EXISTS "audit_log_tenant_created_idx" ON "audit_log" USING btree ("tenant_id","created_at" DESC);--> statement-breakpoint
-- "What did this person do" — the support and investigation read.
CREATE INDEX IF NOT EXISTS "audit_log_actor_created_idx" ON "audit_log" USING btree ("actor_user_id","created_at" DESC);--> statement-breakpoint
-- "What happened to this thing" — the per-resource history read.
CREATE INDEX IF NOT EXISTS "audit_log_resource_idx" ON "audit_log" USING btree ("resource_type","resource_id");--> statement-breakpoint

-- The immutability trigger.
--
-- SECURITY INVOKER (the default) and no search_path games: it does nothing but
-- raise, so there is nothing for a hostile search_path to redirect. It raises
-- with SQLSTATE 2F004 (`reading_sql_data_not_permitted` is the nearest standard
-- code for "this operation is forbidden here") rather than a bare exception, so
-- a caller can distinguish it from a constraint violation.
--
-- TRUNCATE IS DELIBERATELY NOT BLOCKED. Row-level triggers do not fire on
-- TRUNCATE, and adding a statement-level trigger for it was considered and
-- rejected: TRUNCATE requires table OWNERSHIP, which the application role does
-- not hold in a real deployment, so it is already a DBA-only operation. It is
-- also the only mechanism left for retention and for resetting a test database,
-- now that DELETE is refused. Blocking it would leave this table with no legal
-- way to ever shrink.
CREATE OR REPLACE FUNCTION "audit_log_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
		USING ERRCODE = '2F004',
		      HINT = 'Correct a mistaken audit entry by appending a compensating one. Retention is TRUNCATE, which is a DBA operation.';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_log_no_update" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "audit_log_no_update" BEFORE UPDATE ON "audit_log"
	FOR EACH ROW EXECUTE FUNCTION "audit_log_reject_mutation"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_log_no_delete" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "audit_log_no_delete" BEFORE DELETE ON "audit_log"
	FOR EACH ROW EXECUTE FUNCTION "audit_log_reject_mutation"();--> statement-breakpoint

COMMENT ON TABLE "audit_log" IS
	'Append-only record of privileged actions. UPDATE and DELETE are refused by the audit_log_reject_mutation trigger; TRUNCATE is left available deliberately because it needs table ownership and is the only retention mechanism. NEVER CONTAINS PII - metadata is identifiers and counts, scrubbed through platform/pii by platform/audit before insert.';--> statement-breakpoint
COMMENT ON COLUMN "audit_log"."actor_user_id" IS
	'Deliberately NOT a foreign key. Any referential action (CASCADE deletes the trail, SET NULL is an UPDATE) collides with the append-only trigger and would make user deletion fail. Null for system actions - the worker has no user.';--> statement-breakpoint
COMMENT ON COLUMN "audit_log"."actor_role" IS
	'The role AT THE TIME of the action. Denormalised so that a later role change cannot rewrite history.';--> statement-breakpoint
COMMENT ON COLUMN "audit_log"."metadata" IS
	'Identifiers and counts ONLY. No email, no phone, no name, no free text from a user. Scrubbed by platform/audit before insert; a test drives an email and a phone number through record() and asserts neither lands here.';
