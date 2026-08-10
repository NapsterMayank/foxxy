-- Rollback for drizzle/migrations/0006_evidence_capture.sql
--
-- Dropping a column drops its CHECK constraints and its COMMENT with it, so
-- five statements are the whole of it.
--
-- ===========================================================================
-- READ THIS BEFORE RUNNING IT AGAINST ANYTHING WITH DATA.
--
-- This rollback is FREE while `question_responses` is empty and DESTRUCTIVE the
-- moment it is not — and destructive in the one way that cannot be undone.
--
-- Every other rollback in `drizzle/down/` either restores a constraint or drops
-- a table whose contents can be regenerated. These five columns hold the only
-- record that will ever exist of what a particular student did on a particular
-- afternoon: which answer they tried first, whether they wavered, how much help
-- they took, and how sure they were. Re-applying 0006 recreates the columns,
-- empty. Nothing recreates the observations.
--
-- 05-ROADMAP.md §8 rates the cost of never capturing this as "Unrecoverable".
-- The cost of capturing it and then dropping it is identical.
--
-- If this is ever run against an environment with real traffic, dump
-- `question_responses` first — the whole table, not these columns, because a
-- dump of five columns without the row they belong to is not evidence of
-- anything.

ALTER TABLE "question_responses" DROP COLUMN IF EXISTS "explanation_format_used";--> statement-breakpoint
ALTER TABLE "question_responses" DROP COLUMN IF EXISTS "confidence";--> statement-breakpoint
ALTER TABLE "question_responses" DROP COLUMN IF EXISTS "hint_level_used";--> statement-breakpoint
ALTER TABLE "question_responses" DROP COLUMN IF EXISTS "answer_changed";--> statement-breakpoint
ALTER TABLE "question_responses" DROP COLUMN IF EXISTS "first_selected_index";
