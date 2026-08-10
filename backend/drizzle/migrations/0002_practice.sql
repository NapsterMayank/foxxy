-- 0002_practice — the `practice` module's schema (plan §8.6, build step 11).
--
-- Three new tables, plus the D-057 merge: `question_responses` is RENAMED to
-- `practice_responses` and gains the `session_id` the merge exists for.
--
-- ===========================================================================
-- WHY A RENAME AND NOT A DROP-AND-CREATE.
--
-- The table is empty today, because nothing has ever written to it — it landed
-- three build steps early as the third one-way door in PROGRESS.md §8. A drop
-- would therefore be harmless TODAY and catastrophic on the first deployment
-- where it is not, and a migration whose safety depends on a table still being
-- empty is one nobody can re-read and trust. RENAME preserves whatever is
-- there, including the COMMENT ON COLUMN text migration 0006 attached to the
-- five evidence columns, which a recreate would have silently dropped.
--
-- `session_id` is added NOT NULL with no default, which requires the table to
-- be empty. The DO block below turns "it was not" from a confusing constraint
-- violation into a named error that says what to do about it.
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "question_responses" LIMIT 1) THEN
    RAISE EXCEPTION
      'question_responses is not empty. 0002 adds session_id NOT NULL with no default; '
      'backfill session_id from practice_sessions before applying this migration.';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "practice_retention" (
	"student_user_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"interval_days" integer NOT NULL,
	"ease_factor" numeric(4, 2) NOT NULL,
	"repetitions" integer NOT NULL,
	"last_reviewed_at" timestamp with time zone NOT NULL,
	"tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_retention_pkey" PRIMARY KEY("student_user_id","chapter_id"),
	CONSTRAINT "practice_retention_interval_check" CHECK ("practice_retention"."interval_days" >= 0),
	CONSTRAINT "practice_retention_ease_check" CHECK ("practice_retention"."ease_factor" >= 1.3),
	CONSTRAINT "practice_retention_repetitions_check" CHECK ("practice_retention"."repetitions" >= 0)
);
--> statement-breakpoint
CREATE TABLE "practice_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_user_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"question_ids" uuid[] NOT NULL,
	"option_order" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"score_percent" integer,
	"xp_earned" integer,
	"is_valid" boolean,
	"invalid_reason" text,
	"tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_sessions_question_ids_check" CHECK (cardinality("practice_sessions"."question_ids") > 0),
	CONSTRAINT "practice_sessions_score_percent_check" CHECK ("practice_sessions"."score_percent" is null
          or ("practice_sessions"."score_percent" >= 0 and "practice_sessions"."score_percent" <= 100)),
	CONSTRAINT "practice_sessions_xp_check" CHECK ("practice_sessions"."xp_earned" is null or "practice_sessions"."xp_earned" >= 0),
	CONSTRAINT "practice_sessions_submitted_complete_check" CHECK ("practice_sessions"."submitted_at" is null
          or ("practice_sessions"."score_percent" is not null
              and "practice_sessions"."xp_earned" is not null
              and "practice_sessions"."is_valid" is not null)),
	CONSTRAINT "practice_sessions_invalid_reason_check" CHECK (("practice_sessions"."is_valid" is not false or "practice_sessions"."invalid_reason" is not null)
          and ("practice_sessions"."is_valid" is not true or "practice_sessions"."invalid_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "xp_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xp_ledger_source_key" UNIQUE("source","source_id"),
	CONSTRAINT "xp_ledger_amount_check" CHECK ("xp_ledger"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "question_responses" RENAME TO "practice_responses";--> statement-breakpoint
-- Hand-added: drizzle-kit renames the table and every constraint it TRACKS, but
-- an inline single-column PRIMARY KEY has no name in the schema definition, so
-- its implicit `question_responses_pkey` is not among them. Left alone it is a
-- constraint named after a table that no longer exists — invisible to
-- `db:generate` (which cannot see a name it never recorded) and therefore
-- permanent. Caught by reading the catalogue in the migration test.
ALTER TABLE "practice_responses" RENAME CONSTRAINT "question_responses_pkey" TO "practice_responses_pkey";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "question_responses_selected_index_check";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "question_responses_time_spent_check";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "question_responses_authored_difficulty_check";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "question_responses_first_selected_index_check";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "question_responses_answer_changed_check";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "question_responses_hint_level_check";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "question_responses_confidence_check";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "question_responses_student_user_id_students_user_id_fk";
--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "question_responses_question_id_questions_id_fk";
--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "question_responses_tenant_id_tenants_id_fk";
--> statement-breakpoint
DROP INDEX "question_responses_tenant_idx";--> statement-breakpoint
DROP INDEX "question_responses_question_idx";--> statement-breakpoint
DROP INDEX "question_responses_student_idx";--> statement-breakpoint
ALTER TABLE "practice_responses" ADD COLUMN "session_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "practice_retention" ADD CONSTRAINT "practice_retention_student_user_id_students_user_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."students"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_retention" ADD CONSTRAINT "practice_retention_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_retention" ADD CONSTRAINT "practice_retention_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_student_user_id_students_user_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."students"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_ledger" ADD CONSTRAINT "xp_ledger_student_user_id_students_user_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."students"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_ledger" ADD CONSTRAINT "xp_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "practice_retention_due_idx" ON "practice_retention" USING btree ("student_user_id","due_at");--> statement-breakpoint
CREATE INDEX "practice_retention_tenant_idx" ON "practice_retention" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "practice_sessions_tenant_idx" ON "practice_sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "practice_sessions_student_idx" ON "practice_sessions" USING btree ("student_user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "practice_sessions_chapter_idx" ON "practice_sessions" USING btree ("chapter_id");--> statement-breakpoint
CREATE INDEX "xp_ledger_student_idx" ON "xp_ledger" USING btree ("student_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "xp_ledger_tenant_idx" ON "xp_ledger" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "practice_responses" ADD CONSTRAINT "practice_responses_session_id_practice_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."practice_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_responses" ADD CONSTRAINT "practice_responses_student_user_id_students_user_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."students"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_responses" ADD CONSTRAINT "practice_responses_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_responses" ADD CONSTRAINT "practice_responses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "practice_responses_tenant_idx" ON "practice_responses" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "practice_responses_question_idx" ON "practice_responses" USING btree ("question_id","created_at");--> statement-breakpoint
CREATE INDEX "practice_responses_student_idx" ON "practice_responses" USING btree ("student_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "practice_responses_session_idx" ON "practice_responses" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "practice_responses" ADD CONSTRAINT "practice_responses_session_question_key" UNIQUE("session_id","question_id");--> statement-breakpoint
ALTER TABLE "practice_responses" ADD CONSTRAINT "practice_responses_selected_index_check" CHECK ("practice_responses"."selected_index" >= 0 and "practice_responses"."selected_index" < 4);--> statement-breakpoint
ALTER TABLE "practice_responses" ADD CONSTRAINT "practice_responses_time_spent_check" CHECK ("practice_responses"."time_spent_ms" >= 0);--> statement-breakpoint
ALTER TABLE "practice_responses" ADD CONSTRAINT "practice_responses_authored_difficulty_check" CHECK ("practice_responses"."authored_difficulty" in ('easy', 'medium', 'hard'));--> statement-breakpoint
ALTER TABLE "practice_responses" ADD CONSTRAINT "practice_responses_first_selected_index_check" CHECK ("practice_responses"."first_selected_index" is null
          or ("practice_responses"."first_selected_index" >= 0
              and "practice_responses"."first_selected_index" < 4));--> statement-breakpoint
ALTER TABLE "practice_responses" ADD CONSTRAINT "practice_responses_answer_changed_check" CHECK ("practice_responses"."first_selected_index" is null
          or "practice_responses"."answer_changed" is null
          or "practice_responses"."answer_changed" = ("practice_responses"."first_selected_index" <> "practice_responses"."selected_index"));--> statement-breakpoint
ALTER TABLE "practice_responses" ADD CONSTRAINT "practice_responses_hint_level_check" CHECK ("practice_responses"."hint_level_used" >= 0);--> statement-breakpoint
ALTER TABLE "practice_responses" ADD CONSTRAINT "practice_responses_confidence_check" CHECK ("practice_responses"."confidence" is null or "practice_responses"."confidence" in ('unsure', 'unsure_ish', 'confident'));--> statement-breakpoint
COMMENT ON COLUMN practice_responses.session_id IS 'The practice session this answer belongs to - D-057, the column the question_responses/practice_responses merge exists for. (session_id, question_id) is UNIQUE, which is what makes a second submission of the same session impossible at the storage layer rather than only at the service layer.';--> statement-breakpoint
COMMENT ON COLUMN practice_responses.selected_index IS 'The ORIGINAL (canonical) option index, NEVER the shuffled presentation index - D-058. Practice shuffles options per session for presentation only and translates the selection back through practice_sessions.option_order before writing. Misconception codes are keyed by original option index (D-048), so storing a shuffled index here would silently mislabel every misconception, and the data would look entirely plausible.';--> statement-breakpoint
COMMENT ON COLUMN practice_sessions.option_order IS 'The per-session shuffle map: { questionId: [originalIndex, ...] } indexed by PRESENTATION position. Retained for the life of the session because it is the only thing that can translate a student selection back to the canonical index (D-058). Losing it makes every response in the session unreadable.';--> statement-breakpoint
COMMENT ON COLUMN practice_sessions.answers IS 'The in-flight answer accumulator that submitAnswer appends to, canonical indices only. Deliberately NOT practice_responses: §8.6 requires responses, session score, XP ledger and mastery to land in ONE transaction, so nothing may reach practice_responses before that transaction opens. Submission materialises this column into rows.';--> statement-breakpoint
COMMENT ON COLUMN practice_sessions.is_valid IS 'FALSE when an anti-cheat rule failed (§8.6: minimum 3s average per question; not every answer the same index above 3 questions; response count equals question count). An invalid session is still SCORED - at zero - and still recorded, because deleting it would erase the evidence. invalid_reason names which rule, enforced present by a CHECK.';--> statement-breakpoint
COMMENT ON COLUMN xp_ledger.amount IS 'XP awarded, always >= 0. ZERO IS A REAL ENTRY: an invalid attempt earns a zero row rather than no row, because "this session awarded nothing" and "this session was never submitted" must not look the same. A student total is a SUM over this table and never a counter column - counters drift and cannot be reconciled.';--> statement-breakpoint
COMMENT ON COLUMN xp_ledger.source_id IS 'The id of the thing that earned the XP - a practice_sessions.id today. UNIQUE with source, which is the entire idempotency mechanism: one session can award XP exactly once, enforced by the database rather than by the submission path remembering to check.';--> statement-breakpoint
COMMENT ON COLUMN practice_retention.due_at IS 'When this chapter is next due for practice. Computed by the pure SM-2 domain function on the INJECTED clock, never on now(). Today''s Mission reads this column first: a due review outranks every other candidate, and its reason string is derived from this date rather than written by hand.';
