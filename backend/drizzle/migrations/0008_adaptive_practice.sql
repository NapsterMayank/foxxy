-- Adaptive practice difficulty — see docs/superpowers/specs/2026-08-19-adaptive-practice-difficulty-design.md

-- HOW LONG THE SESSION IS MEANT TO BE.
--
-- `question_ids` used to answer this, because every question was drawn up
-- front. Questions are now appended as they are served, so its length means
-- "how far the student has got" — a different number from the one scoring and
-- the anti-cheat count rule need.
ALTER TABLE practice_sessions
  ADD COLUMN target_question_count integer NOT NULL DEFAULT 6;

ALTER TABLE practice_sessions
  ADD CONSTRAINT practice_sessions_target_question_count_check
  CHECK (target_question_count >= 1 AND target_question_count <= 20);

-- THE TARGET THAT WAS IN FORCE WHEN THIS QUESTION WAS SERVED.
--
-- Frozen exactly like `authored_difficulty`. Without it, retuning the targets
-- silently rewrites what "fast" meant for every answer ever recorded, and last
-- term's report changes because somebody edited a constant this term.
--
-- The default backfills the rows that already exist and is then dropped: a
-- default target on a NEW answer would be a target nobody chose.
ALTER TABLE practice_responses
  ADD COLUMN time_target_ms integer NOT NULL DEFAULT 45000;

ALTER TABLE practice_responses
  ALTER COLUMN time_target_ms DROP DEFAULT;

ALTER TABLE practice_responses
  ADD CONSTRAINT practice_responses_time_target_ms_check
  CHECK (time_target_ms > 0);
