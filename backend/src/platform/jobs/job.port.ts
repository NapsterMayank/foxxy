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

/**
 * A job PLUS THE LEASE THE CLAIM HOLDS ON IT — D-233.
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE TYPE RATHER THAN TWO MORE FIELDS ON `JobRecord`.
 *
 * `(lockedBy, lockedAt)` only exists for a job that is currently claimed, and
 * only the completion methods have any use for it. A HANDLER does not: it
 * receives the work, not the bookkeeping, and `JobHandler` stays
 * `(job: JobRecord)` so that nothing in a module has to know this concept
 * exists.
 *
 * Splitting it also makes the fence structural. `succeed` and `fail` take a
 * `ClaimedJob`, and the ONLY way to obtain one is `claim` — so there is no way
 * to complete a job without holding the lease the database handed you. A
 * `jobId: string` parameter, which is what these took before, could be
 * satisfied by any id from anywhere.
 */
export interface ClaimedJob extends JobRecord {
  /** `jobs.locked_by` as the claim wrote it. This worker's id. */
  readonly lockedBy: string;
  /** `jobs.locked_at` as the claim wrote it. Together these ARE the lease. */
  readonly lockedAt: Date;
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

/**
 * What `fail()` decided to do next.
 *
 * `lease_lost` is D-233: the row had already been reclaimed by the reaper and
 * handed to another worker, so THIS worker's failure was not recorded and must
 * not be. It is a third outcome rather than an exception because it is an
 * expected, benign race — the documented at-least-once edge — and a throw would
 * make the runner's `catch` treat a successfully-avoided double-write as a job
 * failure.
 */
export type FailureOutcome = 'retry' | 'dead' | 'lease_lost';

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
  claim(workerId: string, kinds: readonly string[], now: Date): Promise<ClaimedJob | null>;
  /**
   * Marks the job succeeded, FENCED BY THE LEASE THE CALLER STILL HOLDS — D-233.
   *
   * ==========================================================================
   * THE RACE THIS CLOSES, AND WHY IT COULD CORRUPT THE FINAL STATE.
   *
   * A handler may legitimately outrun the 120-second lock timeout. When it
   * does, `reapStuck` returns the row to `pending`, a second worker claims it,
   * and now TWO workers believe they own the job. Both eventually complete.
   *
   * These methods used to update BY JOB ID ALONE. So the slow worker's write
   * landed on a row it no longer owned:
   *
   *   - a `succeed` from the stale worker overwrote the second worker's
   *     `running`, and the second worker's later `fail` then wrote `failed`
   *     over a job that had genuinely succeeded, scheduling a THIRD run;
   *   - or the stale worker's `fail` overwrote a genuine `succeeded`, so the
   *     final state of a job that worked says it did not.
   *
   * At-least-once delivery is a documented, accepted property of this queue.
   * A final state that flips to the WRONG value is not, and no amount of
   * handler idempotency fixes it, because the corruption is in the queue's own
   * bookkeeping rather than in the side effect.
   *
   * Taking the whole `JobRecord` rather than an id is what makes the fence
   * unforgettable: there is no way to call this without the lease in hand.
   *
   * @returns false when the lease was lost — the write did not land, and the
   *          job now belongs to whoever reclaimed it.
   */
  succeed(job: ClaimedJob, now: Date): Promise<boolean>;
  /** Records a failure and schedules the retry, or gives up. Same fence. */
  fail(job: ClaimedJob, error: string, now: Date): Promise<FailureOutcome>;
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
