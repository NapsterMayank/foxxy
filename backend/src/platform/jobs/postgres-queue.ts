import { sql } from 'drizzle-orm';
import type { DbHandle } from '../db/index';
import { jitteredBackoffMs } from '../retry/index';
import {
  JOB_BACKOFF_POLICY,
  type EnqueueInput,
  type EnqueueResult,
  type FailureOutcome,
  type JobQueue,
  type ClaimedJob,
  type JobStatus,
} from './job.port';

/**
 * The Postgres job queue.
 *
 * ===========================================================================
 * `FOR UPDATE SKIP LOCKED` IS THE WHOLE MECHANISM. Everything else is
 * bookkeeping.
 *
 * The claim is one statement:
 *
 *     UPDATE jobs SET status='running', ... WHERE id = (
 *       SELECT id FROM jobs WHERE <claimable> ORDER BY run_at
 *       FOR UPDATE SKIP LOCKED LIMIT 1
 *     ) RETURNING ...
 *
 * The inner SELECT takes a row lock. `SKIP LOCKED` makes a second worker
 * running the identical statement STEP OVER the locked row and take the next
 * one, rather than blocking on it. So N workers claim N different jobs with no
 * coordination, no broker, and no possibility of two workers holding the same
 * job — the lock is held by the database for the duration of the UPDATE, and by
 * the time it is released the row says `running`.
 *
 * Without `SKIP LOCKED` the same query serialises every worker behind the first
 * one, and the queue processes exactly as fast as a single worker no matter how
 * many are running. Without `FOR UPDATE` at all, two workers read the same
 * `pending` row and both update it — the classic lost-update race, and here it
 * means an email sent twice.
 *
 * ===========================================================================
 * RAW SQL, IN A PLACE WHERE THE REST OF THE CODEBASE USES THE QUERY BUILDER.
 *
 * Deliberate, and it is the one construct Drizzle cannot express: the builder
 * has no `FOR UPDATE SKIP LOCKED` inside an UPDATE's subquery. Writing it any
 * other way — SELECT then UPDATE, or an advisory lock — reintroduces exactly
 * the race the statement exists to close.
 *
 * Every value is a BOUND PARAMETER through `sql` interpolation. There is no
 * string concatenation anywhere in this file.
 *
 * ===========================================================================
 * `now` IS PASSED IN, ALWAYS. There is no `now()` in any statement here.
 *
 * D-019: a comparison with the database clock on one side and the injected
 * clock on the other is a defect that only appears under skew, and the session
 * renewal bug in this codebase was exactly that. Every deadline in this queue —
 * `run_at <= now`, the lock timeout, the backoff — is evaluated against the
 * clock the caller supplies, so a test can move time without sleeping and
 * production has one source of truth.
 */

/**
 * The raw row shape, snake_case, as `db.execute` returns it.
 *
 * It `extends Record<string, unknown>` explicitly, because Drizzle's
 * `execute<T>` constrains `T extends Record<string, unknown>` and an interface
 * has no implicit index signature. The alternative — casting the result — would
 * give up the field-name checking that is the only thing standing between this
 * file and a silent typo in a raw SQL projection.
 */
interface JobRow extends Record<string, unknown> {
  id: string;
  kind: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  /**
   * ==========================================================================
   * ALL THREE TIMESTAMPS ARE `Date | string` — D-267, completing D-233.
   *
   * `db.execute` runs raw SQL through node-postgres, and what comes back for a
   * `timestamptz` depends on the driver's type parsers, not on the annotation
   * written here. D-233 typed `locked_at` honestly and left these two as
   * `Date`, saying so explicitly: they "have never been PROVEN to be one,
   * because nothing ever called a method on them — they are handed straight out
   * and only ever compared".
   *
   * THAT IS AN ARGUMENT FOR WHY IT HAD NOT BLOWN UP YET, NOT FOR WHY IT WAS
   * SAFE. `locked_at` was found the hard way — the integration suite threw
   * `job.lockedAt.toISOString is not a function` on its first run — and the
   * only reason these two did not is that no caller had yet done the obvious
   * thing with a value the type system promised was a `Date`. They are handed
   * out as `ClaimedJob.runAt` / `.createdAt`, both declared `Date`, so the lie
   * is not confined to this file: it is exported. The first caller to write
   * `job.runAt.getTime()` — a scheduler, a metric, a "how late is this job"
   * log line — gets a `TypeError` in a worker, at runtime, with a compiler that
   * had already signed off on it.
   *
   * "Fix the types, or parse them" — both. Typed as the union the driver
   * actually returns, and normalised once in `toRecord`, so the honesty stops
   * at the boundary and every consumer still gets a real `Date`.
   * ==========================================================================
   */
  run_at: Date | string;
  created_at: Date | string;
  locked_by: string;
  /**
   * The field that proved it. See the block above: this one is formatted back
   * into the next statement by the fence, so a string here is a `TypeError` at
   * the one moment that matters — which is why it was typed honestly first and
   * why the other two are now typed the same way rather than waiting for their
   * own incident.
   */
  locked_at: Date | string;
}

/**
 * The driver may hand back a `Date` or an ISO string for a `timestamptz`.
 * Normalised at the row boundary — once, here — so no consumer has to know
 * which one it got. See `JobRow`'s header.
 */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toRecord(row: JobRow): ClaimedJob {
  return {
    id: row.id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    // D-267 — normalised, not asserted. `ClaimedJob` declares both as `Date`,
    // and until now that was a promise this function was not keeping.
    runAt: toDate(row.run_at),
    createdAt: toDate(row.created_at),
    // D-233 — the lease. Returned by the claim's own RETURNING clause, so it is
    // the value the database actually wrote and not the value we asked it to.
    //
    // Normalised through `new Date` because the driver may hand back either a
    // `Date` or an ISO string — see `JobRow.locked_at`. Doing it here means the
    // fence has exactly one shape to format, rather than every completion site
    // having to know which one it got.
    lockedBy: row.locked_by,
    lockedAt: toDate(row.locked_at),
  };
}

export interface PostgresJobQueueOptions {
  /** §3.1 — the `worker` pool. Background work never competes with requests. */
  readonly db: DbHandle;
  /** Injected so a test can assert the exact backoff sequence. */
  readonly random?: () => number;
}

export function createPostgresJobQueue(options: PostgresJobQueueOptions): JobQueue {
  const { db } = options;
  const random = options.random ?? Math.random;

  return {
    /**
     * ON CONFLICT DO NOTHING against the `(kind, idempotency_key)` unique
     * index, then a SELECT for the existing id.
     *
     * Not `DO UPDATE`. A second enqueue must not reset `run_at`, `attempts` or
     * `payload` — a job that has failed three times and is backing off would be
     * dragged back to the front of the queue by a duplicated cron tick, and the
     * backoff would never take effect. The correct response to "this work is
     * already queued" is to leave it exactly as it is. Same reasoning as
     * `createProfile`'s `DO NOTHING` in `learner` (D-053).
     */
    async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
      const runAt = input.runAt ?? new Date(0);
      const inserted = await db.db.execute<{ id: string }>(sql`
        insert into jobs (kind, idempotency_key, payload, run_at, max_attempts)
        values (
          ${input.kind},
          ${input.idempotencyKey},
          ${JSON.stringify(input.payload ?? {})}::jsonb,
          ${runAt.toISOString()}::timestamptz,
          ${input.maxAttempts ?? 5}
        )
        on conflict (kind, idempotency_key) do nothing
        returning id
      `);

      const createdId = inserted.rows[0]?.id;
      if (createdId !== undefined) {
        return { id: createdId, created: true };
      }

      const existing = await db.db.execute<{ id: string }>(sql`
        select id from jobs
        where kind = ${input.kind} and idempotency_key = ${input.idempotencyKey}
      `);
      const existingId = existing.rows[0]?.id;
      if (existingId === undefined) {
        // Unreachable: the insert conflicted, so the row exists. Asserted
        // rather than non-null-asserted so a future change that broke the
        // assumption fails here, named, instead of downstream as an undefined.
        throw new Error('enqueue: conflict reported but no existing job found');
      }
      return { id: existingId, created: false };
    },

    /**
     * `attempts` is incremented ON CLAIM, not on failure.
     *
     * The difference matters for the case the reaper exists to handle. A worker
     * that claims a job and is then killed never calls `fail()`; if `attempts`
     * only advanced there, the job would be reclaimed forever with its counter
     * at zero and would never reach `dead`. A poison job that kills its worker
     * would loop until somebody noticed.
     *
     * Incrementing on claim makes `attempts` mean "how many times this has been
     * STARTED", which is the number `maxAttempts` should be compared against.
     */
    async claim(
      workerId: string,
      kinds: readonly string[],
      now: Date,
    ): Promise<ClaimedJob | null> {
      if (kinds.length === 0) return null;

      const result = await db.db.execute<JobRow>(sql`
        update jobs set
          status = 'running',
          locked_by = ${workerId},
          locked_at = ${now.toISOString()}::timestamptz,
          attempts = attempts + 1,
          updated_at = ${now.toISOString()}::timestamptz
        where id = (
          select id from jobs
          where status in ('pending', 'failed')
            and run_at <= ${now.toISOString()}::timestamptz
            and kind in (${sql.join(
              kinds.map((kind) => sql`${kind}`),
              sql`, `,
            )})
          order by run_at asc, created_at asc
          for update skip locked
          limit 1
        )
        returning id, kind, idempotency_key, payload, attempts, max_attempts, run_at,
                  created_at, locked_by, locked_at
      `);

      const row = result.rows[0];
      return row === undefined ? null : toRecord(row);
    },

    /**
     * FENCED BY THE LEASE — D-233. See `JobQueue.succeed` for the race.
     *
     * The `where` clause is the whole fix: `locked_by` and `locked_at` together
     * identify the claim this caller holds, and `reapStuck` nulls both when it
     * reclaims a row. So a worker whose job outran the 120-second lock timeout
     * matches nothing and its write does not land, instead of overwriting the
     * state of the worker that legitimately owns the job now.
     *
     * `status = 'running'` is in there too, and it is not redundant with the
     * lease: `succeed` and `fail` both null the lock columns, so a duplicate
     * completion from the SAME worker would otherwise be matched by
     * `locked_by is null and locked_at is null` if either ever became nullable
     * in the comparison. Belt and braces on a statement whose failure mode is
     * silent.
     */
    async succeed(job: ClaimedJob, now: Date): Promise<boolean> {
      const result = await db.db.execute<{ id: string }>(sql`
        update jobs set
          status = 'succeeded',
          locked_by = null,
          locked_at = null,
          last_error = null,
          updated_at = ${now.toISOString()}::timestamptz
        where id = ${job.id}
          and status = 'running'
          and locked_by = ${job.lockedBy}
          and locked_at = ${job.lockedAt.toISOString()}::timestamptz
        returning id
      `);

      return result.rows.length > 0;
    },

    /**
     * Transient failure → `failed` with `run_at` pushed out by the jittered
     * backoff. Attempts exhausted → `dead`, and THE ROW IS KEPT.
     *
     * ========================================================================
     * THE COMMENT HERE USED TO PROMISE A `CASE` AND THE CODE DID A
     * SELECT-THEN-UPDATE — D-233.
     *
     * It said, verbatim: "The decision is made in SQL with a CASE rather than by
     * reading `attempts` and writing back, because a read-modify-write here
     * races with the reaper — which is also allowed to change this row's
     * status." Then it did exactly the read-modify-write it had just ruled out,
     * and the UPDATE keyed on `id` alone. Between the SELECT and the UPDATE the
     * reaper could requeue the row and a second worker could claim it, and this
     * statement would then stamp a stale `failed`/`dead` over the new claim —
     * including over a job that had already succeeded.
     *
     * Now it is ONE statement. `dead` versus `failed` is decided by a `CASE`
     * over the row's own `attempts` and `max_attempts` — the values as they are
     * at write time, not as they were at read time — and the whole thing is
     * fenced by the lease. `RETURNING status` reports what the database
     * actually decided, so the outcome this function returns is observed rather
     * than predicted.
     *
     * The backoff DELAY is still computed here, from `job.attempts`. That is
     * safe under the fence: the statement only lands when the lease is intact,
     * and `attempts` cannot have changed while it is — a claim is the only
     * thing that increments it, and a claim would have replaced the lease.
     * Computing the jitter in SQL instead would mean a second implementation of
     * `jitteredBackoffMs`, in a second language, that no test compares to the
     * first.
     */
    async fail(job: ClaimedJob, error: string, now: Date): Promise<FailureOutcome> {
      // `attempts - 1` is the zero-based retry index: `attempts` was already
      // incremented by the claim, so the first failure has attempts === 1 and
      // must produce the FIRST backoff delay, not the second.
      const delayMs = jitteredBackoffMs(job.attempts - 1, JOB_BACKOFF_POLICY, random);
      const nextRunAt = new Date(now.getTime() + delayMs);

      const result = await db.db.execute<{ status: string }>(sql`
        update jobs set
          status = case when attempts >= max_attempts then 'dead' else 'failed' end,
          locked_by = null,
          locked_at = null,
          last_error = ${error.slice(0, 1_000)},
          run_at = case
            when attempts >= max_attempts then ${now.toISOString()}::timestamptz
            else ${nextRunAt.toISOString()}::timestamptz
          end,
          updated_at = ${now.toISOString()}::timestamptz
        where id = ${job.id}
          and status = 'running'
          and locked_by = ${job.lockedBy}
          and locked_at = ${job.lockedAt.toISOString()}::timestamptz
        returning status
      `);

      const status = result.rows[0]?.status;
      if (status === undefined) return 'lease_lost';
      return status === 'dead' ? 'dead' : 'retry';
    },

    /**
     * The claim, undone — D-301. See `JobQueue.release` for why this is not
     * `fail` and why `attempts` goes back down.
     *
     * `run_at` is deliberately NOT touched. The job was already due when it was
     * claimed, so the next worker to poll should be able to take it; rewriting
     * `run_at` to `now` would be a no-op in the ordinary case and would silently
     * move a job that had been scheduled into the future.
     *
     * `last_error` is cleared rather than set. Nothing went wrong, and leaving a
     * stale error from a previous attempt beside a `pending` row is how an
     * operator concludes a healthy job is failing.
     */
    async release(job: ClaimedJob, now: Date): Promise<boolean> {
      const result = await db.db.execute<{ id: string }>(sql`
        update jobs set
          status = 'pending',
          locked_by = null,
          locked_at = null,
          last_error = null,
          attempts = greatest(attempts - 1, 0),
          updated_at = ${now.toISOString()}::timestamptz
        where id = ${job.id}
          and status = 'running'
          and locked_by = ${job.lockedBy}
          and locked_at = ${job.lockedAt.toISOString()}::timestamptz
        returning id
      `);

      return result.rows.length > 0;
    },

    /**
     * Back to `pending`, NOT to `failed`.
     *
     * `failed` means "this job ran and threw", and `run_at` would then be
     * subject to the backoff. A reaped job did not fail — nobody knows whether
     * it ran at all — so it goes back to the front of the queue and is retried
     * immediately. Its `attempts` counter was already incremented by the claim
     * that stranded it, so a job that repeatedly kills its worker still reaches
     * `dead` rather than looping forever.
     */
    async reapStuck(lockTimeoutMs: number, now: Date): Promise<number> {
      const cutoff = new Date(now.getTime() - lockTimeoutMs);
      const result = await db.db.execute<{ id: string }>(sql`
        update jobs set
          status = case when attempts >= max_attempts then 'dead' else 'pending' end,
          locked_by = null,
          locked_at = null,
          last_error = 'reclaimed: worker lock expired',
          run_at = ${now.toISOString()}::timestamptz,
          updated_at = ${now.toISOString()}::timestamptz
        where status = 'running'
          and locked_at is not null
          and locked_at < ${cutoff.toISOString()}::timestamptz
        returning id
      `);
      return result.rows.length;
    },

    async countByStatus(): Promise<Readonly<Record<JobStatus, number>>> {
      const result = await db.db.execute<{ status: JobStatus; count: string }>(sql`
        select status, count(*)::text as count from jobs group by status
      `);
      const counts: Record<JobStatus, number> = {
        pending: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        dead: 0,
      };
      for (const row of result.rows) {
        counts[row.status] = Number(row.count);
      }
      return counts;
    },
  };
}
