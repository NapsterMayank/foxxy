import type { JobQueue } from '@/platform/jobs/index';

/**
 * Recurring work, expressed entirely through the idempotency key.
 *
 * ===========================================================================
 * THERE IS NO CRON, NO TIMER AND NO SCHEDULER STATE. That is the design.
 *
 * The naive approach is a timer inside the worker: "every 24 hours, enqueue the
 * sweep". It has three failure modes and all three are quiet.
 *
 *   - Two worker replicas run two timers and enqueue two jobs a day.
 *   - A worker restarted at 23:58 restarts its timer, so the sweep that was due
 *     at midnight happens tomorrow instead. Nothing reports the skip.
 *   - A worker down for a day never notices that a day was missed.
 *
 * Instead, every tick simply asserts that TODAY'S job exists. The idempotency
 * key is `<kind>:<UTC date>`, `(kind, idempotency_key)` is UNIQUE, and enqueue
 * is `ON CONFLICT DO NOTHING`. So:
 *
 *   - Ten replicas ticking every second still produce exactly one row per day.
 *   - A worker that starts at 23:58 enqueues today's job if it is missing, and
 *     tomorrow's the moment the date rolls over.
 *   - A worker down for a day comes up and immediately enqueues today's. It
 *     does NOT backfill yesterday's, and that is correct for this class of work:
 *     a sweep is idempotent and catches up by itself, so running yesterday's
 *     sweep today would delete exactly the same rows as today's.
 *
 * The queue's UNIQUE index is doing all the work that a scheduler would
 * otherwise do with state of its own. That is the whole reason `idempotency_key`
 * is caller-chosen rather than generated.
 *
 * ===========================================================================
 * THE LIMIT, STATED SO NOBODY DISCOVERS IT LATER.
 *
 * This expresses DAILY-OR-COARSER schedules and nothing else. "Every fifteen
 * minutes" would need the key to include the quarter-hour, which works, but
 * "the first Monday of the month" or "09:00 in Asia/Kolkata" does not fall out
 * of it — and 09:00 IST specifically will matter for the parent digest, because
 * the client's users are in one timezone and a digest that arrives at 04:30 is
 * a digest nobody reads.
 *
 * When that lands, the honest options are a `run_at` computed in the target
 * timezone (still keyed by local date, so still this mechanism) or a real cron
 * expression. Do NOT reach for the timer.
 */

/**
 * A recurring job, identified by kind and by how often it repeats.
 *
 * `weekly` was added with the parent digest and is the SAME MECHANISM, not a
 * new one: it changes the idempotency key from "today's UTC date" to "this
 * week's Monday", so the unique index goes on doing all the work. It stays
 * within the limit the header describes — daily-or-coarser, keyed by a UTC
 * calendar boundary. "09:00 in Asia/Kolkata" still does not fall out of it, and
 * is handled downstream by quiet hours and the job's `run_at` rather than here.
 */
export interface RecurringJob {
  readonly kind: string;
  /** `daily` or `weekly`. See the header before adding a third. */
  readonly cadence: 'daily' | 'weekly';
  readonly maxAttempts?: number;
}

/** `YYYY-MM-DD`, in UTC. */
export function utcDateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `YYYY-MM-DD` of the MONDAY of the week containing `now`, in UTC.
 *
 * `getUTCDay()` returns 0 for Sunday, so Sunday is six days after its Monday
 * rather than one day before the next. Getting that wrong makes one week eight
 * days long and the next six — and the symptom is a digest that arrives twice
 * one week and not at all the next.
 *
 * The same arithmetic exists in `modules/notify/domain/digest-week.ts`, which
 * is where the digest's own (parent, week) keys are built. It is duplicated
 * rather than imported because this file is the WORKER's scheduler and must not
 * depend on any module to express a cadence; a test pins the two against each
 * other so they cannot drift.
 */
export function utcWeekKey(now: Date): string {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  return new Date(midnight - daysSinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The key for one occurrence.
 *
 * UTC, deliberately, and it is worth being explicit because the product is
 * single-timezone: a key derived from local time changes meaning when the
 * server's timezone does, and "the sweep ran twice on the day we moved region"
 * is a bug nobody would connect to a key format.
 */
export function occurrenceKey(job: RecurringJob, now: Date): string {
  const period = job.cadence === 'weekly' ? utcWeekKey(now) : utcDateKey(now);
  return `${job.kind}:${period}`;
}

/**
 * Ensures today's occurrence of every recurring job exists.
 *
 * Cheap enough to call on every tick: it is one INSERT ... ON CONFLICT DO
 * NOTHING per job kind, which after the first call each day is an index probe
 * that matches and does nothing.
 *
 * Returns the kinds it actually created, so the caller can log the transition
 * rather than logging on every tick.
 */
export async function ensureRecurringJobs(
  queue: JobQueue,
  jobs: readonly RecurringJob[],
  now: Date,
): Promise<readonly string[]> {
  const created: string[] = [];
  for (const job of jobs) {
    const result = await queue.enqueue({
      kind: job.kind,
      idempotencyKey: occurrenceKey(job, now),
      // `runAt` is left at its default so today's occurrence is claimable
      // immediately. Delaying it to a specific hour is the timezone problem in
      // the header, and this job does not care what time it runs.
      ...(job.maxAttempts === undefined ? {} : { maxAttempts: job.maxAttempts }),
    });
    if (result.created) created.push(job.kind);
  }
  return created;
}
