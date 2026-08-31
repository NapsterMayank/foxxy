-- 0009_visit_correlation — D-401. One question, asked of the database:
-- "what did this student do today, and how many separate visits was it?"
--
-- ===========================================================================
-- THE PROBLEM THIS FIXES.
--
-- Three tables in this schema are called a session and none of them knows the
-- other two exist:
--
--   `sessions`          one row per LOGIN. A cookie lives for weeks, so a
--                       student who opens the app five times in a day still has
--                       ONE row here. Useless for separating those five opens.
--   `chat_sessions`     one row per start-panel submit, written BEFORE the
--                       first message.
--   `practice_sessions` one row per chapter tap, written BEFORE the first
--                       answer.
--
-- So a day of one student is N chat rows plus M practice rows, joined by
-- nothing but `student_user_id` and a timestamp — and a timestamp cannot tell
-- two visits in one afternoon apart. Answering the question above meant two
-- queries and an eyeball.
--
-- Two changes, and deliberately only two:
--
--   1. `visit_id` on both tables — the missing correlation key.
--   2. `v_learner_activity` — the missing single place to look.
--
-- ===========================================================================
-- WHAT `visit_id` IS, AND WHAT IT IS NOT.
--
-- It is a uuid the CLIENT mints once per app launch (sessionStorage, so it
-- survives a reload and dies with the tab) and sends as `X-Visit-Id`. The
-- server reads it through `shared/http/visit-id.ts`, which returns NULL for
-- anything that is not a uuid rather than storing what the caller sent.
--
-- IT IS NOT THE AUTH SESSION ID. That was the obvious first idea and it is
-- wrong: `sessions.id` is constant across exactly the opens this column exists
-- to separate.
--
-- IT AUTHORISES NOTHING. It is client-supplied. No lookup is scoped by it, no
-- access check consults it, and no row is trusted because it carries one. It is
-- a label on data that was already authorised by other means.
--
-- NULLABLE, PERMANENTLY. Absent on every row written before today, on any
-- non-browser caller, and whenever a proxy strips the header. NOT NULL would
-- turn a missing correlation id into a failed practice session, which trades a
-- working product for a tidy column.
--
-- The indexes are PARTIAL for the same reason: every lookup is
-- `visit_id = $1`, which never matches NULL, so indexing the NULLs buys
-- nothing and costs write throughput on the two hottest learner tables.
-- ===========================================================================
ALTER TABLE "practice_sessions" ADD COLUMN "visit_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "visit_id" uuid;--> statement-breakpoint
CREATE INDEX "practice_sessions_visit_idx" ON "practice_sessions" USING btree ("visit_id") WHERE visit_id is not null;--> statement-breakpoint
CREATE INDEX "chat_sessions_visit_idx" ON "chat_sessions" USING btree ("visit_id") WHERE visit_id is not null;--> statement-breakpoint
-- ===========================================================================
-- `v_learner_activity` — HAND-WRITTEN, because drizzle-kit does not emit views.
--
-- Same reason the extensions, the audit trigger and every COMMENT in
-- `0000_baseline.sql` are hand-carried below the generated body. A view is
-- invisible to `db:generate`, so it will never be dropped by a regeneration —
-- but it WILL block a future `DROP COLUMN` on anything it selects. That is a
-- feature: the block is a compile error for the database, arriving at migration
-- time rather than as an empty ops screen months later.
--
-- ===========================================================================
-- IT DOES NOT PRETEND THE TWO LIFECYCLES ARE THE SAME.
--
-- A chat session has no end — there is no `ended_at` and no status, and one is
-- not invented here. What it has is `last_message_at`, NULL until somebody
-- speaks, so its two states are "opened and never used" and "used".
--
-- A practice session ends on submit, so its two states are "still open" and
-- "submitted".
--
-- Forcing those into one shared `completed boolean` would have made the view
-- read cleanly and lie. `outcome` names each in its own vocabulary instead, and
-- a caller that wants "real activity" filters `outcome <> 'empty'`.
--
-- `sessions` IS DELIBERATELY NOT A THIRD BRANCH. It is authentication, not
-- learning; it has no tenant column; and the sweeper deletes its rows on
-- expiry, so a login would vanish from the history of a day it was part of.
--
-- NO ORDER BY. The view is a union, not a report — every caller orders it.
-- ===========================================================================
CREATE VIEW "v_learner_activity" AS
SELECT
  s.student_user_id,
  s.tenant_id,
  s.visit_id,
  'chat'::text            AS kind,
  s.id                    AS ref_id,
  s.chapter_id,
  s.started_at,
  s.last_message_at       AS last_event_at,
  CASE WHEN s.last_message_at IS NULL THEN 'empty' ELSE 'used' END::text AS outcome
FROM chat_sessions s
UNION ALL
SELECT
  p.student_user_id,
  p.tenant_id,
  p.visit_id,
  'practice'::text        AS kind,
  p.id                    AS ref_id,
  p.chapter_id,
  p.started_at,
  p.submitted_at          AS last_event_at,
  CASE WHEN p.submitted_at IS NULL THEN 'open' ELSE 'submitted' END::text AS outcome
FROM practice_sessions p;--> statement-breakpoint
COMMENT ON VIEW v_learner_activity IS 'Every learning activity a student started, chat and practice in one place, keyed by visit_id (D-401). READ-ONLY AND NOT AUTHORISED - it carries no access check of its own, so it is for operations and psql, not for a route. A route reads its own module''s table through that module''s repository. Add `WHERE tenant_id = ...` to every query against it by hand; nothing here does it for you.';--> statement-breakpoint
COMMENT ON COLUMN chat_sessions.visit_id IS 'Which OPEN OF THE APP this conversation belongs to - D-401. A client-minted uuid per app launch, sent as X-Visit-Id, discarded unless it parses as a uuid. NOT the auth session id: sessions.id is one row per LOGIN and survives weeks of opens, so it is constant across exactly the visits this column separates. NULLABLE PERMANENTLY - absent before this migration, absent for non-browser callers, absent when a proxy strips the header. AUTHORISES NOTHING: client-supplied, so no lookup is scoped by it and no access check consults it.';--> statement-breakpoint
COMMENT ON COLUMN practice_sessions.visit_id IS 'Which OPEN OF THE APP this session belongs to - D-401, the same id chat_sessions.visit_id carries. It is the only thing tying a practice session to the conversation the student had beside it: the two tables share no key but the student and the clock, and a clock cannot separate two visits in one afternoon. See chat_sessions.visit_id for the full note.';
