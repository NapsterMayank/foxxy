-- Rollback for drizzle/migrations/0001_pedagogy.sql
--
-- Drizzle does not generate down migrations, so each one is written by hand and
-- lives here under the same number. Plan §4, rule 4: every migration must run
-- forward AND backward against a copy of the schema in CI.
--
-- ===========================================================================
-- THIS ROLLBACK DESTROYS CONTENT THAT NO LONGER HAS A SOURCE.
--
-- 0001 is where the 639 chapter concepts, 176 prerequisite edges and 57
-- misconception patterns live, and the database they were extracted from was
-- read for the last time on 10 August 2026 (D-095); its password is being
-- rotated (D-096). `.corpus-extract/` is gitignored and local to one machine.
--
-- So this file is legitimate against a database that has just had 0001 applied
-- — which in practice means a test — and running it against a populated one
-- means re-importing from an extract that must still exist. It is written,
-- exercised and asserted anyway, for the reason the baseline's rollback header
-- gives: a forward migration nobody has ever reversed is one whose object list
-- has quietly drifted from the schema.
--
-- Order: no table here is referenced by any other, so the only ordering
-- constraint is that each drop takes its own indexes and foreign keys with it,
-- which DROP TABLE does. `if exists` throughout, so a partial forward run
-- rolls back cleanly.

drop table if exists misconception_patterns;
--> statement-breakpoint
drop table if exists concept_graph;
--> statement-breakpoint
drop table if exists chapter_concepts;
