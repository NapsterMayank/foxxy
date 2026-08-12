-- 0004_tenancy — the `tenants` table, one seeded default tenant, and a
-- nullable `tenant_id` on every table that carries student data.
--
-- Hand-written, then checked against the drizzle schema (plan §4, rule 1).
--
-- ===========================================================================
-- WHY THIS IS THE SHARPEST ITEM ON 05-ROADMAP.md §8.
--
-- The roadmap, §7: "`tenant_id` is the one item on this roadmap that is
-- genuinely expensive to retrofit. Adding it to every table after real student
-- data exists means a migration across every row, every query and every
-- authorisation check, WITH NO SAFE INTERMEDIATE STATE."
--
-- The last clause is the expensive one. A retrofit is four steps — add the
-- column, backfill it, tighten it, repoint every query and every authorisation
-- decision — and between the first and the last, the system runs with SOME
-- reads tenant-scoped and some not. That window is where one school sees
-- another school's children. It cannot be closed with a feature flag, because
-- it spans a schema change, and it cannot be shortened much, because the
-- backfill is a full table rewrite on the largest tables in the product.
--
-- Today there are no rows to backfill and no queries to repoint. The whole
-- thing is this file plus one branch in `platform/authz`.
--
-- ===========================================================================
-- NULLABLE, WITH A DEFAULT — the one compromise, made deliberately.
--
-- Every `tenant_id` added below is NULLABLE and DEFAULTs to the seeded tenant.
-- Postgres 11 and later fills existing rows from a non-volatile default without
-- rewriting the table, so this is a metadata-only change on every table.
--
-- NOT NULL would be stronger and is the eventual target. It is not done here
-- because it would require every insert path in three modules to supply a
-- tenant ON THE SAME DAY — which is the "change everything at once" this hook
-- exists to avoid. The column is the fact; the enforcement is elsewhere.
--
-- ===========================================================================
-- THE ENFORCEMENT IS NOT IN THIS FILE. IT IS IN `platform/authz`.
--
-- A nullable column enforces nothing on its own, and it would be a mistake to
-- read this migration as having delivered tenant isolation. What delivers it is
-- `assertCanAccess`: when both the actor and the resource carry a tenant and
-- the two differ, access is DENIED BEFORE ANY ALLOW RULE IS CONSIDERED —
-- including the rules that would otherwise permit it. A parent reading their
-- own approved child in another tenant is refused.
--
-- That ordering is the property worth testing, and it is tested:
-- `platform/authz/__tests__/can-access.test.ts`, "cross-tenant access".
--
-- ===========================================================================
-- ON DELETE RESTRICT, EVERYWHERE, and never CASCADE.
--
-- A CASCADE from `tenants` would mean that deleting one row deletes every
-- student, every mastery record and every logged response belonging to a
-- school. That is a plausible typo with an unrecoverable outcome. RESTRICT
-- makes "delete this tenant" fail loudly while anything still references it,
-- which is the correct answer: offboarding a school is an export followed by a
-- deliberate, ordered deletion, not one statement.

CREATE TABLE IF NOT EXISTS "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_check" CHECK ("tenants"."slug" ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
	CONSTRAINT "tenants_name_check" CHECK (length(btrim("tenants"."name")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_slug_unique" ON "tenants" USING btree ("slug");--> statement-breakpoint

-- ===========================================================================
-- THE ONE TENANT THAT EXISTS.
--
-- A FIXED id rather than a generated one, written identically here, in
-- `schema/tenants.ts` as `DEFAULT_TENANT_ID`, and in the tests. Three copies of
-- a literal is normally a smell; here it is the point. The alternative is a
-- runtime "find the default tenant, or create it", which turns a broken
-- database into a silently self-healing one — and a system that invents a
-- tenant when it cannot find the right one is a system that will one day file a
-- school's children under a tenant it made up.
--
-- ON CONFLICT DO NOTHING so the migration is safe to re-apply.
INSERT INTO "tenants" ("id", "slug", "name")
VALUES ('11111111-1111-4111-8111-111111111111', 'default', 'Default tenant')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- ===========================================================================
-- `users` — the ACTOR's tenant.
--
-- Listed first and separately from the student tables because it serves a
-- different purpose. The others record which tenant a piece of data belongs to;
-- this one records which tenant the person acting belongs to. `assertCanAccess`
-- compares the two, so without this column the guard could only ever see one
-- side of the comparison and would have nothing to enforce.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_tenant_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint

-- ===========================================================================
-- `parent_child_links` — the only cross-user data path in the product (§6.8).
--
-- It carries its own tenant rather than inheriting the student's, because this
-- is the one row whose whole function is to let one account read another's. A
-- link that spans two tenants is exactly the thing Phase 5 must be able to
-- refuse, and a fact that is only derivable by joining two other tables is a
-- fact no constraint can ever be written against.
ALTER TABLE "parent_child_links" ADD COLUMN IF NOT EXISTS "tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111';--> statement-breakpoint
ALTER TABLE "parent_child_links" ADD CONSTRAINT "parent_child_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parent_child_links_tenant_idx" ON "parent_child_links" USING btree ("tenant_id");--> statement-breakpoint

-- ===========================================================================
-- `students` — the single most important of the six.
--
-- Everything a school could ever see about a child hangs off this row. The
-- index is "every student in this tenant", which is the first query every
-- Phase 1 teacher screen and every Phase 4 principal dashboard runs. It answers
-- nothing today; building it today costs milliseconds, and building it in
-- eighteen months costs an index build on the largest table in the product.
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111';--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "students_tenant_idx" ON "students" USING btree ("tenant_id");--> statement-breakpoint

-- ===========================================================================
-- `student_subjects`, `chapter_mastery`, `question_responses` — DENORMALISED.
--
-- All three could reach their tenant by joining `students`. They carry it
-- directly because the reads that will use it are AGGREGATES ACROSS A TENANT —
-- "improvement by cohort", "four-week retention", "which misconception does
-- this class share" — and a join to `students` on every one of those is the
-- join the column exists to remove.
--
-- The cost of denormalising is that the copy can disagree with the source. That
-- is a real risk and it is accepted knowingly: the alternative is a tenant
-- filter that is one forgotten JOIN away from returning another school's rows,
-- and a missing filter is a data leak while a stale copy is a reporting bug.
ALTER TABLE "student_subjects" ADD COLUMN IF NOT EXISTS "tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111';--> statement-breakpoint
ALTER TABLE "student_subjects" ADD CONSTRAINT "student_subjects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "student_subjects_tenant_idx" ON "student_subjects" USING btree ("tenant_id");--> statement-breakpoint

ALTER TABLE "chapter_mastery" ADD COLUMN IF NOT EXISTS "tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111';--> statement-breakpoint
ALTER TABLE "chapter_mastery" ADD CONSTRAINT "chapter_mastery_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chapter_mastery_tenant_idx" ON "chapter_mastery" USING btree ("tenant_id");--> statement-breakpoint

ALTER TABLE "question_responses" ADD COLUMN IF NOT EXISTS "tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111';--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_responses_tenant_idx" ON "question_responses" USING btree ("tenant_id");--> statement-breakpoint

-- ===========================================================================
-- CONTENT IS DELIBERATELY NOT TENANTED.
--
-- `chapters`, `questions` and `rag_chunks` get no `tenant_id`. The NCERT corpus
-- is CBSE curriculum: it is the same for every school, and giving it a tenant
-- would either duplicate 16,000 chunks per customer or leave a column that is
-- always the default and always ignored — a filter everybody has to remember
-- and nobody needs.
--
-- Phase 5's "tenant-scoped content — a school's own questions alongside the
-- shared bank" is a SEPARATE table (`school_questions` in the previous
-- codebase), not a column here. Shared and school-authored content have
-- different review workflows and different lifetimes; one table with a nullable
-- tenant would blur them.
--
-- `platform/authz` matches this: the `content` resource kind carries no tenant
-- and the cross-tenant rule does not apply to it.
COMMENT ON COLUMN "users"."tenant_id" IS
	'Which tenant this ACCOUNT belongs to. Nullable with a default while the product is single-tenant (05-ROADMAP.md section 8). This is the ACTOR side of the tenant comparison in platform/authz - assertCanAccess denies when it differs from the resource tenant, before any allow rule is considered.';--> statement-breakpoint
COMMENT ON COLUMN "students"."tenant_id" IS
	'Which tenant this student belongs to. Nullable with a default while the product is single-tenant. Enforcement lives in platform/authz, NOT in this column.';--> statement-breakpoint
COMMENT ON COLUMN "question_responses"."tenant_id" IS
	'Denormalised from students.tenant_id so cohort-level aggregates do not join. A stale copy is a reporting bug; a forgotten join would be a data leak.';
