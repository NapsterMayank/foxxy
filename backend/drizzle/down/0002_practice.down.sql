-- Rollback of 0002_practice.
--
-- Plan §4 rule 4: every migration runs forward AND backward against a copy of
-- the schema in CI. This one is worth more than most, because 0002 is the first
-- migration in this repository that RENAMES rather than only adds — and a rename
-- that reverses incompletely leaves the table under the new name with the old
-- constraints, or the reverse, and nothing notices until the forward migration
-- is applied a second time and fails on a name it cannot find.
--
-- Reverses in the exact opposite order: the response table is put back first
-- (its session_id FK is what pins `practice_sessions` in place), then the three
-- new tables are dropped.

-- --- practice_responses -> question_responses ------------------------------
COMMENT ON COLUMN practice_responses.session_id IS NULL;--> statement-breakpoint
COMMENT ON COLUMN practice_responses.selected_index IS NULL;--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "practice_responses_session_question_key";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "practice_responses_selected_index_check";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "practice_responses_time_spent_check";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "practice_responses_authored_difficulty_check";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "practice_responses_first_selected_index_check";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "practice_responses_answer_changed_check";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "practice_responses_hint_level_check";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "practice_responses_confidence_check";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "practice_responses_session_id_practice_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "practice_responses_student_user_id_students_user_id_fk";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "practice_responses_question_id_questions_id_fk";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP CONSTRAINT "practice_responses_tenant_id_tenants_id_fk";--> statement-breakpoint
DROP INDEX "practice_responses_tenant_idx";--> statement-breakpoint
DROP INDEX "practice_responses_question_idx";--> statement-breakpoint
DROP INDEX "practice_responses_student_idx";--> statement-breakpoint
DROP INDEX "practice_responses_session_idx";--> statement-breakpoint
ALTER TABLE "practice_responses" DROP COLUMN "session_id";--> statement-breakpoint
ALTER TABLE "practice_responses" RENAME CONSTRAINT "practice_responses_pkey" TO "question_responses_pkey";--> statement-breakpoint
ALTER TABLE "practice_responses" RENAME TO "question_responses";--> statement-breakpoint

ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_selected_index_check" CHECK ("question_responses"."selected_index" >= 0 and "question_responses"."selected_index" < 4);--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_time_spent_check" CHECK ("question_responses"."time_spent_ms" >= 0);--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_authored_difficulty_check" CHECK ("question_responses"."authored_difficulty" in ('easy', 'medium', 'hard'));--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_first_selected_index_check" CHECK ("question_responses"."first_selected_index" is null
          or ("question_responses"."first_selected_index" >= 0
              and "question_responses"."first_selected_index" < 4));--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_answer_changed_check" CHECK ("question_responses"."first_selected_index" is null
          or "question_responses"."answer_changed" is null
          or "question_responses"."answer_changed" = ("question_responses"."first_selected_index" <> "question_responses"."selected_index"));--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_hint_level_check" CHECK ("question_responses"."hint_level_used" >= 0);--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_confidence_check" CHECK ("question_responses"."confidence" is null or "question_responses"."confidence" in ('unsure', 'unsure_ish', 'confident'));--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_student_user_id_students_user_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."students"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_responses_tenant_idx" ON "question_responses" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "question_responses_question_idx" ON "question_responses" USING btree ("question_id","created_at");--> statement-breakpoint
CREATE INDEX "question_responses_student_idx" ON "question_responses" USING btree ("student_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint

-- --- the three new tables --------------------------------------------------
DROP TABLE IF EXISTS "xp_ledger";--> statement-breakpoint
DROP TABLE IF EXISTS "practice_retention";--> statement-breakpoint
DROP TABLE IF EXISTS "practice_sessions";
