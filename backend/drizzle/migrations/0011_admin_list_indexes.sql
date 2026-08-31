-- 0011_admin_list_indexes — D-403. The indexes the admin panel reads through.
--
-- ===========================================================================
-- WHAT WAS WRONG, MEASURED RATHER THAN SUSPECTED.
--
-- Every admin list orders by `(created_at DESC, id DESC)` — the keyset shape
-- borrowed from the notifications list. No index existed for it on any of the
-- four tables involved, so `EXPLAIN` on the development database returned the
-- same plan every time:
--
--     Seq Scan on users              ->  Sort  (created_at DESC, id DESC)
--     Seq Scan on audit_log          ->  Sort  (created_at DESC, id DESC)
--     Seq Scan on practice_sessions  ->  Sort  (created_at DESC, id DESC)
--
-- That is a whole-table read and a sort to return fifty rows, and it is invisible
-- today because the development database holds fourteen users.
--
-- `audit_log` IS THE ONE THAT MATTERS. It is the fastest-growing table in the
-- product BECAUSE OF THIS FEATURE — every admin read appends a row (D-402) —
-- and the admin panel is its only reader. A screen that gets slower the more it
-- is used, whose slowness is caused by its own use, is the one to fix first.
--
-- ===========================================================================
-- WHY NOT REUSE THE INDEXES THAT ALREADY EXIST.
--
-- `audit_log` has three: `(tenant_id, created_at)`, `(actor_user_id,
-- created_at)` and `(resource_type, resource_id)`. All three lead with a column
-- the admin list does not filter on — it reads ACROSS tenants and actors by
-- design — so none of them can serve the ordering. An index is only usable from
-- its leading column inwards, and "leading column the admin query never
-- mentions" describes all three.
--
-- ===========================================================================
-- DEPLOYMENT NOTE, because these are `CREATE INDEX` on live tables.
--
-- Written WITHOUT `CONCURRENTLY` because the migration runner wraps each file
-- in a transaction and `CONCURRENTLY` cannot run inside one. On the current
-- data (thousands of rows) the lock is milliseconds. Before this runs against a
-- table of real size, build these by hand with `CREATE INDEX CONCURRENTLY` and
-- let the migration find them already present — `IF NOT EXISTS` makes that a
-- no-op rather than a conflict. That is the standing rule in section 6.6 and
-- this is the first migration in the repository it actually applies to.
-- ===========================================================================
CREATE INDEX IF NOT EXISTS "users_created_id_idx"
  ON "users" ("created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_created_id_idx"
  ON "audit_log" ("created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_created_id_idx"
  ON "subscriptions" ("created_at" DESC, "id" DESC);
--> statement-breakpoint
-- ===========================================================================
-- THE SESSION LISTS ORDER BY `started_at`, NOT `created_at`.
--
-- `practice_sessions` already carried `(student_user_id, started_at DESC)`, and
-- the admin list was ordering by `created_at` — two timestamps, one index, and
-- the wrong one named. The query moved to `started_at` (which is also the more
-- honest column: it is written from the injected clock at the moment the
-- session begins, where `created_at` is a row-insert default) and these two
-- indexes serve the UNFILTERED case that the student-scoped index cannot.
-- ===========================================================================
CREATE INDEX IF NOT EXISTS "practice_sessions_started_id_idx"
  ON "practice_sessions" ("started_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_sessions_started_id_idx"
  ON "chat_sessions" ("started_at" DESC, "id" DESC);
--> statement-breakpoint
COMMENT ON INDEX "audit_log_created_id_idx" IS 'The admin audit list (D-403). The three older indexes on this table all lead with a column that list does not filter on - it reads across tenants and actors deliberately - so none of them could serve its ordering. This table grows fastest because of the admin panel itself, which is also its only reader.';
