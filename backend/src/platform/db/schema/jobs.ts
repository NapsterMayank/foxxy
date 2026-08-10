import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * jobs — the worker's queue. 04-RESILIENCE-PLAN.md §3.2 and §12.
 *
 * ===========================================================================
 * WHY POSTGRES AND NOT A QUEUE.
 *
 * 00-ARCHITECTURE.md §0 approves exactly three external services plus a
 * regulated fourth. A message broker is not among them, and adding one to
 * deliver a weekly digest would be the most expensive line in the deployment.
 *
 * `FOR UPDATE SKIP LOCKED` gives correct multi-consumer claiming inside the
 * database we already run, and it does it inside the same transaction as the
 * work — which a broker cannot, and which is what makes "exactly once" reachable
 * here at all. The scale at which this stops being adequate is thousands of
 * jobs a second; the actual load is one digest per parent per week.
 *
 * ===========================================================================
 * AT-LEAST-ONCE DELIVERY IS ASSUMED. IDEMPOTENCY IS THE ANSWER.
 *
 * A worker can claim a job, complete the work, and die before recording that it
 * did. No queue anywhere prevents this; the honest response is to make running
 * a job twice harmless rather than to pretend it cannot happen.
 *
 * So every job is KEYED: `(kind, idempotency_key)` is UNIQUE. Enqueuing "the
 * weekly digest for parent X for week 2026-W32" twice inserts one row, whether
 * the two calls are a retry, a duplicated cron tick, or two API instances
 * racing. The key is chosen by the CALLER and must be derived from what makes
 * the work unique — never from a timestamp or a random value, which would make
 * every enqueue a new job and defeat the whole mechanism.
 *
 * ===========================================================================
 * `status` AND WHAT EACH VALUE MEANS.
 *
 *   pending    claimable when `run_at` has passed
 *   running    claimed; `locked_by` and `locked_at` say by whom and since when
 *   succeeded  terminal
 *   failed     transient failure; `run_at` has been pushed out by the backoff
 *              and it is claimable again. NOT terminal
 *   dead       `attempts` reached `max_attempts`. Terminal, and the row is kept
 *              as evidence rather than deleted — a job that gave up silently is
 *              a job nobody investigates
 *
 * A job stuck in `running` because its worker was killed is recovered by the
 * reaper: `locked_at` older than the lock timeout returns it to `pending`. That
 * is the at-least-once edge, and it is why handlers must be idempotent.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    /** Caller-chosen. Must be derived from the work, never from a clock. */
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('pending'),
    /** Earliest time this may be claimed. Backoff pushes it forward. */
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    /** The last failure's MESSAGE only — never a stack, never a payload dump. */
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * THE constraint. Two enqueues of the same logical work are one row,
     * enforced by Postgres rather than by a check-then-insert that two
     * instances can both pass.
     */
    uniqueIndex('jobs_kind_idempotency_key_unique').on(table.kind, table.idempotencyKey),
    check(
      'jobs_status_check',
      sql`${table.status} in ('pending', 'running', 'succeeded', 'failed', 'dead')`,
    ),
    check('jobs_kind_check', sql`length(btrim(${table.kind})) > 0`),
    check('jobs_idempotency_key_check', sql`length(btrim(${table.idempotencyKey})) > 0`),
    check('jobs_attempts_check', sql`${table.attempts} >= 0`),
    check('jobs_max_attempts_check', sql`${table.maxAttempts} >= 1`),
    check('jobs_payload_object_check', sql`jsonb_typeof(${table.payload}) = 'object'`),
    /**
     * THE claim query's index, and it is PARTIAL on purpose.
     *
     * The claim reads "claimable jobs, oldest first" — which is
     * `status in ('pending','failed') and run_at <= now()`. Succeeded and dead
     * rows accumulate forever and are never claimed, so indexing them would
     * grow the index without bound to answer a query that can never match them.
     */
    index('jobs_claimable_idx')
      .on(table.runAt, table.kind)
      .where(sql`status in ('pending', 'failed')`),
    /** The stuck-job reaper: rows locked longer than the lock timeout. */
    index('jobs_locked_at_idx')
      .on(table.lockedAt)
      .where(sql`status = 'running'`),
  ],
);

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
