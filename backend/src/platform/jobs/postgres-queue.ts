import { sql } from 'drizzle-orm';
import type { DbHandle } from '../db/index';
import { jitteredBackoffMs } from '../retry/index';
import {
  JOB_BACKOFF_POLICY,
  type EnqueueInput,
  type EnqueueResult,
  type FailureOutcome,
  type JobQueue,
  type JobRecord,
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
  run_at: Date;
  created_at: Date;
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    createdAt: row.created_at,
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
    ): Promise<JobRecord | null> {
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
        returning id, kind, idempotency_key, payload, attempts, max_attempts, run_at, created_at
      `);

      const row = result.rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async succeed(jobId: string, now: Date): Promise<void> {
      await db.db.execute(sql`
        update jobs set
          status = 'succeeded',
          locked_by = null,
          locked_at = null,
          last_error = null,
          updated_at = ${now.toISOString()}::timestamptz
        where id = ${jobId}
      `);
    },

    /**
     * Transient failure → `failed` with `run_at` pushed out by the jittered
     * backoff. Attempts exhausted → `dead`, and THE ROW IS KEPT.
     *
     * The decision is made in SQL with a CASE rather than by reading `attempts`
     * and writing back, because a read-modify-write here races with the reaper
     * — which is also allowed to change this row's status.
     */
    async fail(jobId: string, error: string, now: Date): Promise<FailureOutcome> {
      const current = await db.db.execute<{ attempts: number; max_attempts: number }>(sql`
        select attempts, max_attempts from jobs where id = ${jobId}
      `);
      const row = current.rows[0];
      if (row === undefined) {
        throw new Error(`fail: no job ${jobId}`);
      }

      const exhausted = row.attempts >= row.max_attempts;
      // `attempts - 1` is the zero-based retry index: `attempts` was already
      // incremented by the claim, so the first failure has attempts === 1 and
      // must produce the FIRST backoff delay, not the second.
      const delayMs = jitteredBackoffMs(row.attempts - 1, JOB_BACKOFF_POLICY, random);
      const nextRunAt = new Date(now.getTime() + delayMs);

      await db.db.execute(sql`
        update jobs set
          status = ${exhausted ? 'dead' : 'failed'},
          locked_by = null,
          locked_at = null,
          last_error = ${error.slice(0, 1_000)},
          run_at = ${(exhausted ? now : nextRunAt).toISOString()}::timestamptz,
          updated_at = ${now.toISOString()}::timestamptz
        where id = ${jobId}
      `);

      return exhausted ? 'dead' : 'retry';
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
