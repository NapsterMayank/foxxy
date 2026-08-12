-- Rollback for drizzle/migrations/0002_learner_content.sql
--
-- Drizzle does not generate down migrations, so each one is written by hand
-- and lives here under the same number. Plan §4, rule 4: every migration must
-- run forward AND backward against a copy of the schema in CI.
--
-- Order is children before parents, following the foreign keys:
--
--   question_responses  -> students, questions
--   chapter_mastery     -> students, chapters
--   student_subjects    -> students
--   rag_chunks          -> chapters
--   questions           -> chapters
--   students            -> users        (identity, migration 0000 — untouched)
--   chapters            -> (nothing)
--
-- `question_responses` goes first specifically because its question FK is
-- ON DELETE RESTRICT rather than CASCADE. Dropping `questions` while responses
-- exist is refused by that constraint, which is exactly what it is for.
--
-- Indexes, CHECK constraints and column COMMENTs all belong to their tables
-- and go with them; none needs a statement of its own.
--
-- Extensions are deliberately NOT dropped. `vector` was enabled by migration
-- 0000 and is shared; dropping an extension another migration depends on turns
-- a rollback into an outage.
--
-- NOT RECOVERABLE, and worth saying out loud rather than discovering:
-- rolling this back discards the corpus and, more importantly, every row of
-- `question_responses`. That table is the third one-way door in PROGRESS.md
-- §8 — the response log cannot be reconstructed after the fact, because the
-- authored difficulty at the time of serving exists nowhere else. If this
-- rollback is ever run against an environment with real traffic, dump
-- `question_responses` first.

DROP TABLE IF EXISTS "question_responses";--> statement-breakpoint
DROP TABLE IF EXISTS "chapter_mastery";--> statement-breakpoint
DROP TABLE IF EXISTS "student_subjects";--> statement-breakpoint
DROP TABLE IF EXISTS "rag_chunks";--> statement-breakpoint
DROP TABLE IF EXISTS "questions";--> statement-breakpoint
DROP TABLE IF EXISTS "students";--> statement-breakpoint
DROP TABLE IF EXISTS "chapters";
