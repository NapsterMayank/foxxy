-- Rollback for drizzle/migrations/0008_adaptive_practice.sql
--
-- Drizzle does not generate down migrations, so each one is written by hand and
-- lives here under the same number.
--
-- ===========================================================================
-- WHAT THIS DESTROYS, STATED PLAINLY.
--
-- `practice_sessions.target_question_count` and `practice_responses.time_target_ms`
-- are both dropped. Nothing downstream reads either column yet (Task 3 is
-- schema-only), so there is no derived state to reconcile — the columns simply
-- stop existing, and every value they held goes with them.
-- ===========================================================================
--
-- ORDER. Constraints go before the columns they constrain, on both tables —
-- a column cannot be dropped while a CHECK still names it.
ALTER TABLE practice_responses
  DROP CONSTRAINT IF EXISTS practice_responses_time_target_ms_check;

ALTER TABLE practice_responses
  DROP COLUMN IF EXISTS time_target_ms;

ALTER TABLE practice_sessions
  DROP CONSTRAINT IF EXISTS practice_sessions_target_question_count_check;

ALTER TABLE practice_sessions
  DROP COLUMN IF EXISTS target_question_count;
