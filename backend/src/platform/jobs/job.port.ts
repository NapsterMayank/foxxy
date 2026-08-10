import type { BackoffPolicy } from '../retry/index';

/**
 * platform/jobs — the background job queue.
 *
 * 04-RESILIENCE-PLAN.md §3.2 lists `worker` as one of two processes and says
 * that if it dies "jobs pause and resume. USERS SEE NOTHING". That property is
 * the entire reason for the separation, and it only holds if a job's state
 * lives in the database rather than in the process.
 *
 * ===========================================================================
 * THREE PROPERTIES, AND EVERY ONE OF THEM IS A CONSTRAINT ON CALLERS.
 *
 * 1. AT-LEAST-ONCE DELIVERY IS ASSUMED, NOT AVOIDED.
 *
 *    A worker can claim a job, complete the work, and be killed before it can
 *    record that it did. No queue in existence prevents this — it is a
 *    two-phase commit between the queue and the side effect, and the side
 *    effect is usually an email. Systems that advertise exactly-once are
 *    providing at-least-once plus deduplication, which is what this does too,
 *    with the deduplication made the caller's explicit responsibility rather
 *    than hidden.
 *
 *    THEREFORE: EVERY HANDLER MUST BE IDEMPOTENT. Running it twice must be
 *    harmless. This is not advice.
 *
 * 2. JOBS ARE KEYED.
 *
 *    `(kind, idempotencyKey)` is UNIQUE in the database. Enqueuing the same
 *    logical work twice inserts one row, whether the second call is a retry, a
 *    duplicated cron tick, or two API instances racing.
 *
 *    THE KEY MUST BE DERIVED FROM WHAT MAKES THE WORK UNIQUE — a parent id plus
 *    an ISO week, a session id. NEVER a timestamp and never a random value:
 *    either makes every enqueue a new row and silently removes the only
 *    protection this design offers.
 *
 * 3. A FAILED JOB RETRIES WITH BACKOFF, THEN DIES VISIBLY.
 *
 *    Transient failure pushes `run_at` forward by an exponentially backed-off,
 *    JITTERED delay (§4: "synchronised retries are a self-inflicted denial of
 *    service" — and a queue is where a thundering herd is most likely, because
 *    a hundred jobs failed against the same dependency at the same instant).
 *
 *    At `maxAttempts` the job becomes `dead` and the ROW IS KEPT. Deleting it
 *    would make a job that gave up indistinguishable from a job that was never
 *    enqueued, which is the silent failure the status exists to prevent.
 */

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead';

export interface JobRecord {
  readonly id: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** How many times this job has been CLAIMED, including the current claim. */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAt: Date;
  readonly createdAt: Date;
}

export interface EnqueueInput {
  readonly kind: string;
  /** Derived from the work. Never a timestamp, never random. See the header. */
  readonly idempotencyKey: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Earliest time it may run. Defaults to now — i.e. immediately claimable. */
  readonly runAt?: Date;
  readonly maxAttempts?: number;
}

export interface EnqueueResult {
  readonly id: string;
  /**
   * False when a job with this `(kind, idempotencyKey)` already existed.
   *
   * Returned rather than thrown: a duplicate enqueue is the EXPECTED outcome of
   * a retried request, not an error. A caller that wants to know can look; most
   * should not care, which is the point of keying them.
   */
  readonly created: boolean;
}

/** What `fail()` decided to do next. */
export type FailureOutcome = 'retry' | 'dead';

export interface JobQueue {
  enqueue(input: EnqueueInput): Promise<EnqueueResult>;
  /**
   * Atomically claims the oldest claimable job and marks it `running`.
   *
   * Returns null when there is nothing to do. Uses `FOR UPDATE SKIP LOCKED`, so
   * concurrent workers never receive the same row and never block each other.
   *
   * `kinds` restricts the claim — a worker that only knows how to run some
   * kinds must not claim the others, or it will fail them repeatedly until they
   * are dead.
   */
  claim(workerId: string, kinds: readonly string[], now: Date): Promise<JobRecord | null>;
  succeed(jobId: string, now: Date): Promise<void>;
  /** Records a failure and schedules the retry, or gives up. */
  fail(jobId: string, error: string, now: Date): Promise<FailureOutcome>;
  /**
   * Returns jobs stuck in `running` past the lock timeout to the queue.
   *
   * THIS IS THE AT-LEAST-ONCE EDGE, made concrete. A worker killed mid-job
   * leaves a row claimed forever; without a reaper that job never runs again
   * and nothing says so. With one, it runs a second time — which is safe
   * precisely because handlers are required to be idempotent.
   */
  reapStuck(lockTimeoutMs: number, now: Date): Promise<number>;
  /** Counts per status. For the heartbeat and for `/health/deps`. */
  countByStatus(): Promise<Readonly<Record<JobStatus, number>>>;
}

/**
 * A handler runs one job. Throwing means "transient failure, retry"; returning
 * means success.
 *
 * There is deliberately NO way to say "permanent failure, do not retry". A
 * handler that knows its input is unprocessable should record that fact and
 * RETURN — the job did its work, and the work was to determine that. Offering a
 * `dropThisJob` escape hatch produces handlers that swallow real failures to
 * avoid the retry noise.
 */
export type JobHandler = (job: JobRecord) => Promise<void>;

/**
 * Retry backoff for jobs — SECONDS, not the milliseconds `platform/retry` uses.
 *
 * The scale difference is the point. In-request retry is measured in
 * milliseconds because a user is waiting. A background job has nobody waiting,
 * so the correct first retry is far enough away for a blip to have passed:
 * 30 s, 1 m, 2 m, 4 m, capped at 15 m. Five attempts spans roughly 22 minutes,
 * which outlives an ordinary provider incident without holding a row for a day.
 *
 * Equal jitter, inherited from `platform/retry`: a queue is where a thundering
 * herd is most likely, because everything that failed against one dependency
 * failed at the same instant.
 */
export const JOB_BACKOFF_POLICY: BackoffPolicy = {
  baseMs: 30_000,
  maxMs: 900_000,
  jitterRatio: 0.5,
};
