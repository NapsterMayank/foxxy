import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * metrics_events · worker_heartbeats — 04-RESILIENCE-PLAN.md §5 and §12.
 *
 * ===========================================================================
 * WHY metrics_events EXISTS.
 *
 * §5: "Every state transition is logged at `warn` and emitted as a metric. A
 * breaker that opens without anyone knowing is a silent outage."
 *
 * Half of that was true and half was decoration. Transitions were logged, and
 * `createNoopBreakerMetrics()` sent the metric NOWHERE — its own comment said
 * "observability sink lands with the metrics port". This table is that sink.
 *
 * ===========================================================================
 * WHY POSTGRES AND NOT A TIME-SERIES DATABASE.
 *
 * Because the alternative to a simple table is nothing, and nothing is what has
 * been running. The volume is small — breaker transitions, fallback
 * activations, rejections and timeouts are all EXCEPTIONAL events, not
 * per-request counters — so a table is adequate for a long time, and the port
 * (`platform/metrics`) means swapping in Prometheus or a hosted sink later is
 * one adapter.
 *
 * The one thing that would make this a bad idea is emitting a row per request.
 * Do not. If a metric ever needs per-request granularity it belongs in a real
 * time-series store, and that is the trigger to build the second adapter.
 *
 * ===========================================================================
 * NO PII IN `tags`. Same rule and the same enforcement as `audit_log`:
 * `platform/metrics` scrubs every tag set through `platform/pii` before it is
 * written. A metric dimension is a LOW-CARDINALITY LABEL — 'cache', 'open',
 * 'timeout' — and anything identifying a person is both a privacy problem and
 * a cardinality explosion.
 */
export const metricsEvents = pgTable(
  'metrics_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Dotted and stable: `breaker.transition`, `port.timeout`. */
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    /**
     * `double precision`, not `numeric`. Unlike `chapter_mastery.mastery_score`
     * — which is compared against thresholds and shown to a parent, so exact
     * decimal representation matters — a metric is aggregated and plotted.
     * Nothing branches on its exact value.
     */
    value: doublePrecision('value').notNull(),
    tags: jsonb('tags').notNull().default(sql`'{}'::jsonb`),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('metrics_events_kind_check', sql`${table.kind} in ('counter', 'gauge', 'histogram')`),
    check('metrics_events_name_check', sql`length(btrim(${table.name})) > 0`),
    check('metrics_events_tags_object_check', sql`jsonb_typeof(${table.tags}) = 'object'`),
    /** "This metric, over this window" — the only read shape there is. */
    index('metrics_events_name_recorded_idx').on(table.name, table.recordedAt.desc()),
    /** Retention: delete everything older than N days. */
    index('metrics_events_recorded_idx').on(table.recordedAt),
  ],
);

/**
 * worker_heartbeats — §8, applied to a process that has no HTTP surface.
 *
 * The API answers `/health/live` because something calls it. The worker has no
 * listener, so its liveness has to be something an outside observer can READ:
 * a row it stamps on every loop. "Is the worker alive?" becomes
 * `select now() - last_beat_at from worker_heartbeats`, which a readiness probe,
 * a dashboard, or a human at 2am can all ask.
 *
 * One row per worker process, keyed by an id that includes the hostname and
 * the start time, so two replicas do not overwrite each other's beat and a
 * restarted worker leaves the corpse of the old row visible until it is reaped.
 */
export const workerHeartbeats = pgTable(
  'worker_heartbeats',
  {
    workerId: text('worker_id').primaryKey(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    lastBeatAt: timestamp('last_beat_at', { withTimezone: true }).notNull(),
    /** Cumulative, since this process started. Resets on restart, by design. */
    jobsProcessed: bigint('jobs_processed', { mode: 'number' }).notNull().default(0),
    status: text('status').notNull().default('running'),
  },
  (table) => [
    check(
      'worker_heartbeats_status_check',
      sql`${table.status} in ('running', 'draining', 'stopped')`,
    ),
    check('worker_heartbeats_jobs_processed_check', sql`${table.jobsProcessed} >= 0`),
    /** "Which workers have beaten recently" — the liveness read. */
    index('worker_heartbeats_last_beat_idx').on(table.lastBeatAt),
  ],
);

export type MetricsEventRow = typeof metricsEvents.$inferSelect;
export type NewMetricsEventRow = typeof metricsEvents.$inferInsert;
export type WorkerHeartbeatRow = typeof workerHeartbeats.$inferSelect;
export type NewWorkerHeartbeatRow = typeof workerHeartbeats.$inferInsert;
