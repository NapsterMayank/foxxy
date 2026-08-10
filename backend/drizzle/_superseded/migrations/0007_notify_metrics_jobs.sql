-- 0007_notify_metrics_jobs — the three tables the platform layer needs before
-- any module can use it: `notifications`, `metrics_events` + `worker_heartbeats`,
-- and `jobs`.
--
-- Hand-written, then checked against the drizzle schema (plan §4, rule 1).
--
-- One migration rather than three because none of these is independently
-- useful: they are the storage behind the notification channel port, the
-- metrics port and the worker process, all of which land together.
--
-- ===========================================================================
-- PART 1 — notifications. The row the `in-app` channel writes.
--
-- 05-ROADMAP.md §8 makes the notification CHANNEL PORT a Phase 0 hook at half a
-- day now against "rewrite every call site" later, because Phase 2 adds
-- WhatsApp. `platform/notify-channel` is that port; this is the only table it
-- owns.
--
-- BOTH LANGUAGES ARE NOT NULL. That is P7 made structural, and it is enforced
-- at TWO layers on purpose:
--
--   AT THE TYPE LEVEL, `BilingualText` in `platform/notify-channel` requires
--   both `en` and `hi`. A single-language message does not compile.
--
--   HERE, all four columns are NOT NULL with a non-empty CHECK. That is what
--   catches the import script, the psql session, and the future service written
--   in a language the type system cannot see.
--
-- Neither layer alone is enough: types do not survive a raw INSERT, and NOT
-- NULL alone does not stop `hi = ''` being written deliberately to get past it
-- — which is why the check is `length(btrim(...)) > 0`.
--
-- The way P7 actually decays is a notification added in a hurry with English
-- only and a `// TODO: hi` that outlives the person who wrote it. It decays
-- INVISIBLY, because an English-only notification renders perfectly for the
-- person who wrote it.

CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"tenant_id" uuid,
	"kind" text NOT NULL,
	"title_en" text NOT NULL,
	"body_en" text NOT NULL,
	"title_hi" text NOT NULL,
	"body_hi" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_kind_check" CHECK (length(btrim("notifications"."kind")) > 0),
	CONSTRAINT "notifications_bilingual_check" CHECK (length(btrim("notifications"."title_en")) > 0 and length(btrim("notifications"."body_en")) > 0 and length(btrim("notifications"."title_hi")) > 0 and length(btrim("notifications"."body_hi")) > 0),
	CONSTRAINT "notifications_data_object_check" CHECK (jsonb_typeof("notifications"."data") = 'object')
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- The only read shape there is: "my notifications, newest first".
CREATE INDEX IF NOT EXISTS "notifications_recipient_created_idx" ON "notifications" USING btree ("recipient_user_id","created_at" DESC);--> statement-breakpoint
-- The unread badge — a count over a small PARTIAL index rather than a scan of
-- every notification the user has ever received.
CREATE INDEX IF NOT EXISTS "notifications_unread_idx" ON "notifications" USING btree ("recipient_user_id") WHERE read_at is null;--> statement-breakpoint

COMMENT ON TABLE "notifications" IS
	'Storage for the in-app notification channel (platform/notify-channel). Both languages are NOT NULL and non-empty: P7 enforced at the database as well as in the type system, because types do not survive a raw INSERT.';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."data" IS
	'Structured payload for the client to act on - identifiers and counts, never prose and never PII. Scrubbed through platform/pii on the way in, the same as audit_log.metadata.';--> statement-breakpoint

-- ===========================================================================
-- PART 2 — metrics_events. 04-RESILIENCE-PLAN.md §5.
--
-- §5: "Every state transition is logged at `warn` and emitted as a metric. A
-- breaker that opens without anyone knowing is a silent outage."
--
-- Half of that was true. Transitions were logged; the metric went to
-- `createNoopBreakerMetrics()`, whose own comment read "observability sink
-- lands with the metrics port". This table is that sink, and until it existed
-- the second half of §5 was decoration.
--
-- WHY POSTGRES AND NOT A TIME-SERIES DATABASE. Because the alternative to a
-- simple table is nothing, and nothing is what has been running.
-- 00-ARCHITECTURE.md §0 approves three external services and a broker is not
-- among them. The volume is small — breaker transitions, rate-limit fallbacks,
-- concurrency rejections and port timeouts are all EXCEPTIONAL events, not
-- per-request counters — so a table is adequate for a long time, and
-- `platform/metrics` is a port, so swapping in Prometheus later is one adapter.
--
-- THE ONE THING THAT WOULD MAKE THIS A BAD IDEA is emitting a row per request.
-- Do not. If a metric ever needs per-request granularity it belongs in a real
-- time-series store, and needing that is the trigger to write the second
-- adapter rather than to widen this table.
--
-- NO PII IN `tags`, same rule and same enforcement as `audit_log.metadata`. A
-- metric dimension is a LOW-CARDINALITY LABEL — 'cache', 'open', 'timeout'.
-- Anything identifying a person is both a privacy problem and a cardinality
-- explosion, and the two failures arrive together.

CREATE TABLE IF NOT EXISTS "metrics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"value" double precision NOT NULL,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metrics_events_kind_check" CHECK ("metrics_events"."kind" in ('counter', 'gauge', 'histogram')),
	CONSTRAINT "metrics_events_name_check" CHECK (length(btrim("metrics_events"."name")) > 0),
	CONSTRAINT "metrics_events_tags_object_check" CHECK (jsonb_typeof("metrics_events"."tags") = 'object')
);
--> statement-breakpoint
-- "This metric, over this window" — the only read shape there is.
CREATE INDEX IF NOT EXISTS "metrics_events_name_recorded_idx" ON "metrics_events" USING btree ("name","recorded_at" DESC);--> statement-breakpoint
-- Retention: delete everything older than N days. Without this the retention
-- job is a sequential scan of the largest table in the database.
CREATE INDEX IF NOT EXISTS "metrics_events_recorded_idx" ON "metrics_events" USING btree ("recorded_at");--> statement-breakpoint

COMMENT ON TABLE "metrics_events" IS
	'The sink for platform/metrics. Deliberately a plain table, not a time-series store: the events are exceptional (breaker transitions, fallbacks, rejections, timeouts), not per-request. If a metric ever needs per-request granularity, write a second adapter - do not start writing a row per request here.';--> statement-breakpoint
COMMENT ON COLUMN "metrics_events"."tags" IS
	'Low-cardinality labels only. Never PII and never an identifier: it is simultaneously a privacy problem and a cardinality explosion. Scrubbed through platform/pii before insert.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- worker_heartbeats — §8, applied to a process with no HTTP surface.
--
-- The API answers `/health/live` because something calls it. The worker has no
-- listener, so its liveness has to be something an outside observer can READ:
-- a row it stamps on every loop. "Is the worker alive?" becomes
-- `select now() - last_beat_at from worker_heartbeats`, which a probe, a
-- dashboard and a human at 2am can all ask.
--
-- One row per worker PROCESS, keyed by an id containing the hostname and the
-- start time, so two replicas do not overwrite each other's beat and a
-- restarted worker leaves the old row visible until it is reaped. A single
-- shared row would make two healthy workers indistinguishable from one healthy
-- worker and one that died an hour ago.
CREATE TABLE IF NOT EXISTS "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_beat_at" timestamp with time zone NOT NULL,
	"jobs_processed" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	CONSTRAINT "worker_heartbeats_status_check" CHECK ("worker_heartbeats"."status" in ('running', 'draining', 'stopped')),
	CONSTRAINT "worker_heartbeats_jobs_processed_check" CHECK ("worker_heartbeats"."jobs_processed" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_heartbeats_last_beat_idx" ON "worker_heartbeats" USING btree ("last_beat_at");--> statement-breakpoint

-- ===========================================================================
-- PART 3 — jobs. The worker's queue. §3.2 and §12.
--
-- WHY POSTGRES AND NOT A QUEUE. `FOR UPDATE SKIP LOCKED` gives correct
-- multi-consumer claiming inside the database we already run, and it does it in
-- the same transaction as the work — which a broker cannot, and which is what
-- makes single-execution reachable at all. The scale at which this stops being
-- adequate is thousands of jobs a second; the actual load is one digest per
-- parent per week.
--
-- AT-LEAST-ONCE DELIVERY IS ASSUMED. IDEMPOTENCY IS THE ANSWER. A worker can
-- claim a job, do the work, and die before recording that it did. No queue
-- anywhere prevents this; the honest response is to make running a job twice
-- harmless rather than to pretend it cannot happen.
--
-- So every job is KEYED: `(kind, idempotency_key)` is UNIQUE. Enqueuing "the
-- weekly digest for parent X for week 2026-W32" twice inserts one row, whether
-- the two calls are a retry, a duplicated cron tick, or two API instances
-- racing. THE KEY MUST BE DERIVED FROM WHAT MAKES THE WORK UNIQUE — never from
-- a timestamp and never from a random value, either of which makes every
-- enqueue a new job and defeats the entire mechanism.
--
-- `status` values, and what each means:
--   pending    claimable once `run_at` has passed
--   running    claimed; `locked_by` and `locked_at` say by whom and since when
--   succeeded  terminal
--   failed     TRANSIENT failure. `run_at` has been pushed out by the backoff
--              and the row is claimable again. NOT terminal
--   dead       `attempts` reached `max_attempts`. Terminal, and the row is KEPT
--              rather than deleted — a job that gave up silently is a job
--              nobody investigates
--
-- A job stuck in `running` because its worker was killed is recovered by the
-- reaper: `locked_at` older than the lock timeout returns it to `pending`. That
-- is the at-least-once edge made concrete, and it is why handlers must be
-- idempotent rather than merely careful.

CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('pending', 'running', 'succeeded', 'failed', 'dead')),
	CONSTRAINT "jobs_kind_check" CHECK (length(btrim("jobs"."kind")) > 0),
	CONSTRAINT "jobs_idempotency_key_check" CHECK (length(btrim("jobs"."idempotency_key")) > 0),
	CONSTRAINT "jobs_attempts_check" CHECK ("jobs"."attempts" >= 0),
	CONSTRAINT "jobs_max_attempts_check" CHECK ("jobs"."max_attempts" >= 1),
	CONSTRAINT "jobs_payload_object_check" CHECK (jsonb_typeof("jobs"."payload") = 'object')
);
--> statement-breakpoint
-- THE constraint. Two enqueues of the same logical work are one row, enforced
-- by Postgres rather than by a check-then-insert that two instances can both
-- pass — the same reasoning as `link_codes_one_active_per_student` (D-021).
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_kind_idempotency_key_unique" ON "jobs" USING btree ("kind","idempotency_key");--> statement-breakpoint
-- The claim query's index, PARTIAL on purpose. The claim reads "claimable jobs,
-- oldest first", which is `status in ('pending','failed') and run_at <= now()`.
-- Succeeded and dead rows accumulate forever and can never be claimed, so
-- indexing them would grow the index without bound to answer a query that can
-- never match them.
CREATE INDEX IF NOT EXISTS "jobs_claimable_idx" ON "jobs" USING btree ("run_at","kind") WHERE status in ('pending', 'failed');--> statement-breakpoint
-- The stuck-job reaper: rows locked longer than the lock timeout.
CREATE INDEX IF NOT EXISTS "jobs_locked_at_idx" ON "jobs" USING btree ("locked_at") WHERE status = 'running';--> statement-breakpoint

COMMENT ON TABLE "jobs" IS
	'The worker queue, claimed with FOR UPDATE SKIP LOCKED. AT-LEAST-ONCE delivery is assumed: a worker can finish the work and die before recording it, so handlers MUST be idempotent. A dead row is kept rather than deleted - a job that gave up silently is a job nobody investigates.';--> statement-breakpoint
COMMENT ON COLUMN "jobs"."idempotency_key" IS
	'Chosen by the caller and UNIQUE per kind. MUST be derived from what makes the work unique (e.g. parent id + ISO week), NEVER from a timestamp or a random value - either makes every enqueue a new job and defeats the mechanism entirely.';--> statement-breakpoint
COMMENT ON COLUMN "jobs"."last_error" IS
	'The failure MESSAGE only. Never a stack trace and never a payload dump: this column is read during incidents and must not become a place PII accumulates.';
