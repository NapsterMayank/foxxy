-- Rollback for drizzle/migrations/0007_notify_metrics_jobs.sql
--
-- Four independent tables, no foreign keys between them, so the order here is
-- cosmetic rather than load-bearing — the reverse of the forward file, for
-- readability. `notifications` references `users` and `tenants`, both of which
-- belong to earlier migrations and are untouched.
--
-- Dropping a table takes its indexes, CHECKs, foreign keys and COMMENTs with
-- it. None needs a statement of its own.
--
-- WHAT ROLLING THIS BACK LOSES, in descending order of how much it matters:
--
--   `jobs`              EVERY QUEUED AND EVERY FAILED JOB. This is the one to
--                       think about. A `dead` row is the record of work that
--                       gave up, kept deliberately so somebody investigates;
--                       dropping the table is the silent version of the failure
--                       the `dead` status exists to prevent. Dump it first.
--   `notifications`     Every unread in-app message. Not regenerable — the
--                       events that produced them have passed.
--   `metrics_events`    Observability history. Losing it makes an incident
--                       harder to reconstruct but breaks nothing.
--   `worker_heartbeats` Nothing. It is rewritten on the next loop.
--
-- Free while the worker has never run, which is the same window in which the
-- forward migration is free.

DROP TABLE IF EXISTS "jobs";--> statement-breakpoint
DROP TABLE IF EXISTS "worker_heartbeats";--> statement-breakpoint
DROP TABLE IF EXISTS "metrics_events";--> statement-breakpoint
DROP TABLE IF EXISTS "notifications";
