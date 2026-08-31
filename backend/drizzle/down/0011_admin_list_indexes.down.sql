-- Rollback for drizzle/migrations/0011_admin_list_indexes.sql
--
-- Drops five indexes and nothing else. No data moves and no shape changes, so
-- this rollback is genuinely reversible — re-running the forward migration
-- rebuilds them identically.
--
-- WHAT IT COSTS: the admin lists go back to a sequential scan and a sort on
-- every page. Correct, and slower in proportion to how much the panel has been
-- used, since `audit_log` grows by one row per admin read.
DROP INDEX IF EXISTS "chat_sessions_started_id_idx";

DROP INDEX IF EXISTS "practice_sessions_started_id_idx";

DROP INDEX IF EXISTS "subscriptions_created_id_idx";

DROP INDEX IF EXISTS "audit_log_created_id_idx";

DROP INDEX IF EXISTS "users_created_id_idx";
