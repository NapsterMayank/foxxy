-- Rollback for drizzle/migrations/0009_visit_correlation.sql
--
-- Drizzle does not generate down migrations, so each one is written by hand and
-- lives here under the same number.
--
-- ===========================================================================
-- WHAT THIS DESTROYS, STATED PLAINLY.
--
-- Every `visit_id` ever recorded. It is a correlation label rather than
-- evidence — no score, no mastery and no XP is derived from it — so nothing
-- downstream needs reconciling. But it is also UNRECOVERABLE: the id was minted
-- in a browser tab that has long since closed, so re-running the up migration
-- gives back the column and never the values. Rows written before the rollback
-- stay NULL for ever.
--
-- The view goes with it. Nothing in the application reads `v_learner_activity`
-- — it exists for operations and psql — so dropping it breaks no code path.
-- ===========================================================================
--
-- ORDER. The VIEW FIRST, and this is the one line that matters here: a view
-- that selects `visit_id` holds a dependency on it, so `DROP COLUMN` fails
-- while the view stands. Postgres would name the view in the error, but a
-- rollback that needs a second attempt to succeed is a rollback nobody trusts
-- at the moment they are running it.
DROP VIEW IF EXISTS v_learner_activity;

DROP INDEX IF EXISTS chat_sessions_visit_idx;

DROP INDEX IF EXISTS practice_sessions_visit_idx;

ALTER TABLE chat_sessions
  DROP COLUMN IF EXISTS visit_id;

ALTER TABLE practice_sessions
  DROP COLUMN IF EXISTS visit_id;
