-- 0003_parent — the `parent` module's schema (plan §8.7, build step 12).
--
-- ONE new table, `weekly_digests`. Nothing existing is altered, nothing is
-- dropped, and no column changes type — so this migration is safe to apply to a
-- populated database and its rollback loses only derived data.
--
-- ===========================================================================
-- THE UNIQUE CONSTRAINT IS THE FEATURE.
--
-- `weekly_digests_week_key` on (parent_user_id, student_user_id, week_start) is
-- what makes §8.7's "digest generation is idempotent for a given week" a
-- property of the DATABASE rather than of a service remembering to check first.
-- notify's job key covers a duplicated enqueue and its `hasDigestFor` covers a
-- duplicated worker run; neither covers a parent tapping refresh twice. This
-- does, for every caller at once.
--
-- Keyed per (parent, CHILD, week), not per (parent, week): a parent with two
-- children receives two digests in a week and they are different facts.
-- ===========================================================================
--
-- `misconception_code` IS NULLABLE ON PURPOSE. `questions.distractor_misconceptions`
-- is NULL on all 2,741 imported questions (D-077), so almost every real digest
-- this year carries NULL here. NULL means "nothing was observed" — a statement
-- the product makes out loud rather than a field waiting to be filled in. A
-- NOT NULL column with a 'none' sentinel would make the D-077 gap unqueryable.
--
-- TWO ACTION COLUMNS, NOT THE ONE PLAN §4 LISTS. P7 requires both languages for
-- anything a user reads, and the plan's own summary_en/summary_hi pair sets the
-- precedent. One column would have left the most useful line in the digest —
-- the concrete action — in English only.
--
-- `tenant_id` IS NOT NULL WITH A DEFAULT, matching every other student-owned
-- table after migration 0008/the baseline collapse (D-073). The service does
-- not lean on the default: it stamps the tenant that `assertCanAccess` just
-- passed on, so "filed under the tenant that was checked" is true by
-- construction.
CREATE TABLE "weekly_digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_user_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"summary_en" text NOT NULL,
	"summary_hi" text NOT NULL,
	"misconception_code" text,
	"suggested_action_en" text NOT NULL,
	"suggested_action_hi" text NOT NULL,
	"sessions_count" integer DEFAULT 0 NOT NULL,
	"questions_answered" integer DEFAULT 0 NOT NULL,
	"days_practised" integer DEFAULT 0 NOT NULL,
	"chapter_id" uuid,
	"tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111' NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_digests_week_key" UNIQUE("parent_user_id","student_user_id","week_start"),
	CONSTRAINT "weekly_digests_summary_en_check" CHECK (length(btrim("weekly_digests"."summary_en")) > 0),
	CONSTRAINT "weekly_digests_summary_hi_check" CHECK (length(btrim("weekly_digests"."summary_hi")) > 0),
	CONSTRAINT "weekly_digests_action_en_check" CHECK (length(btrim("weekly_digests"."suggested_action_en")) > 0),
	CONSTRAINT "weekly_digests_action_hi_check" CHECK (length(btrim("weekly_digests"."suggested_action_hi")) > 0),
	CONSTRAINT "weekly_digests_sessions_check" CHECK ("weekly_digests"."sessions_count" >= 0),
	CONSTRAINT "weekly_digests_questions_check" CHECK ("weekly_digests"."questions_answered" >= 0),
	CONSTRAINT "weekly_digests_days_check" CHECK ("weekly_digests"."days_practised" >= 0 and "weekly_digests"."days_practised" <= 7)
);
--> statement-breakpoint
ALTER TABLE "weekly_digests" ADD CONSTRAINT "weekly_digests_parent_user_id_users_id_fk" FOREIGN KEY ("parent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_digests" ADD CONSTRAINT "weekly_digests_student_user_id_students_user_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."students"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_digests" ADD CONSTRAINT "weekly_digests_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_digests" ADD CONSTRAINT "weekly_digests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "weekly_digests_parent_idx" ON "weekly_digests" USING btree ("parent_user_id","week_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "weekly_digests_student_idx" ON "weekly_digests" USING btree ("student_user_id","week_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "weekly_digests_tenant_idx" ON "weekly_digests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "weekly_digests_chapter_idx" ON "weekly_digests" USING btree ("chapter_id");