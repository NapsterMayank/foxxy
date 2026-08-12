-- Rollback for drizzle/migrations/0000_identity.sql
--
-- Drizzle does not generate down migrations, so each one is written by hand
-- and lives here under the same number. Plan §4, rule 4: every migration must
-- run forward AND backward against a copy of the schema in CI.
--
-- Order matters: children before parents, because of the FK cascades.
-- Extensions are deliberately NOT dropped — `vector` is shared with the corpus
-- tables, and dropping an extension another migration depends on turns a
-- rollback into an outage.

DROP TABLE IF EXISTS "parent_child_links";
DROP TABLE IF EXISTS "password_reset_tokens";
DROP TABLE IF EXISTS "email_verification_tokens";
DROP TABLE IF EXISTS "sessions";
DROP TABLE IF EXISTS "users";
