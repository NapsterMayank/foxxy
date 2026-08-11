import type { Clock, Sleeper } from '../clock/index';
import type { Logger } from '../logger/index';
import { PLATFORM_METRICS, createNoopMetrics, type MetricsPort } from '../metrics/index';
import type { ClaimedJob, FailureOutcome, JobHandler, JobQueue } from './job.port';

/**
 * The job runner — the loop the worker process spends its life in.
 *
 * ===========================================================================
 * GRACEFUL SHUTDOWN IS THE HARD PART, AND IT IS §12 STEP 3:
 *
 *   "Let the worker finish its current job, up to 30 s; DO NOT CLAIM NEW ONES."
 *
 * Two halves, and the second is the one that is easy to get wrong.
 *
 * STOP CLAIMING, IMMEDIATELY. The instant a signal arrives the loop must not
 * take another job — not "after this poll interval", not "on the next
 * iteration". A job claimed one millisecond into a shutdown is a job that will
 * be killed thirty seconds later and reclaimed by the stuck-job reaper, which
 * means it runs twice for no reason. `stopping` is the first thing `stop()`
 * sets, and it is checked TWICE around every claim — D-301.
 *
 * TWICE, because once was a lie. The check used to sit immediately before the
 * call and nowhere else, and this comment used to describe that as sufficient.
 * `queue.claim` is a network round trip; a SIGTERM landing inside it is THE
 * COMMON CASE ON A DEPLOY, not an exotic interleaving. The flag flips while the
 * statement is on the wire, the claim comes back with a job, and the loop runs
 * it — a job claimed and executed after shutdown began, which is exactly what
 * the check existed to prevent. So the result is checked as well as the call,
 * and a job claimed into a shutdown is handed straight back with
 * `queue.release` (see `JobQueue.release` for why that is not `fail`).
 *
 * FINISH THE CURRENT ONE, UP TO 30 S. The in-flight job is tracked in
 * `current`, and `stop()` awaits it against a deadline. Exceeding the deadline
 * is logged at `error` and the process exits anyway: a drain that never
 * finishes is worse than one that gives up, because the orchestrator's SIGKILL
 * arrives regardless and skips every other cleanup step on the way.
 *
 * ===========================================================================
 * IDLE POLLING, NOT LISTEN/NOTIFY.
 *
 * `LISTEN`/`NOTIFY` would give lower latency and needs a dedicated connection
 * held open permanently, plus a reconnect path, plus a poll fallback anyway —
 * because a NOTIFY delivered while nothing is listening is simply lost, so a
 * job enqueued during a worker restart would sit there until something else
 * happened.
 *
 * The actual latency requirement is a weekly digest and a nightly sweep. A
 * one-second idle poll is three orders of magnitude better than it needs to be.
 * Revisit if a user ever waits on a job.
 *
 * THE SLEEP GOES THROUGH THE INJECTED `Sleeper`. Plan §9.5 bans `sleep` in a
 * test outright, and a runner that called `setTimeout` directly would make
 * every loop test take real seconds.
 *
 * ===========================================================================
 * A HANDLER THAT THROWS IS A TRANSIENT FAILURE. A MISSING HANDLER IS NOT.
 *
 * A job whose kind has no registered handler is a DEPLOYMENT mistake — an old
 * worker against a new enqueuer. Retrying it changes nothing and it will exhaust
 * its attempts and die, which is the right outcome, but it is logged at `error`
 * rather than `warn` because the fix is to deploy the worker, not to wait.
 */

export interface JobRunnerOptions {
  readonly queue: JobQueue;
  /** Kind → handler. The runner claims only the kinds it can actually run. */
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly logger: Logger;
  readonly metrics?: MetricsPort;
  /** Identifies this process in `jobs.locked_by` and in the heartbeat row. */
  readonly workerId: string;
  /** How long to wait when there was nothing to claim. */
  readonly idlePollMs?: number;
  /** §12 step 3 — how long the current job may take once shutdown begins. */
  readonly shutdownTimeoutMs?: number;
  /** A `running` job untouched for this long is reclaimed. */
  readonly lockTimeoutMs?: number;
  /** Called after each poll, so the worker can beat its heartbeat. */
  readonly onTick?: (processed: number) => Promise<void>;
}

export interface JobRunner {
  /** Runs until `stop()`. Resolves when the loop has ended. */
  start(): Promise<void>;
  /** §12 step 3. Idempotent. */
  stop(reason: string): Promise<void>;
  /** One poll: reap, claim, run. Returns whether a job was processed. */
  runOnce(): Promise<boolean>;
  isStopping(): boolean;
  /** Jobs completed by this process, successfully or not. */
  processed(): number;
}

const DEFAULT_IDLE_POLL_MS = 1_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
/**
 * Two minutes. Comfortably longer than the 30 s shutdown drain, so a worker
 * that is legitimately finishing a long job during a deploy is never reclaimed
 * out from under itself — which would run that job twice for no reason.
 */
const DEFAULT_LOCK_TIMEOUT_MS = 120_000;

/**
 * Waits for `promise`, but not past `ms`. Resolves true if it finished.
 *
 * A REJECTION COUNTS AS FINISHED, AND NEVER PROPAGATES — D-302.
 *
 * `promise.then(() => true)` alone made this function rethrow whatever it was
 * waiting on, which made `stop()` reject, which skipped every step after it in
 * the shutdown sequence. The question this function answers is "is it still
 * running?", and a promise that rejected is not still running. The CALLER logs
 * the outcome; what it must never do is fall over on it, because the one place
 * this is used is the path that has to keep going no matter what.
 */
async function withDeadline(promise: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { queue, handlers, clock, sleeper, logger, workerId } = options;
  const metrics = options.metrics ?? createNoopMetrics();
  const idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const kinds = Object.keys(handlers);

  let stopping = false;
  /**
   * Read through a function, never as a bare `stopping`.
   *
   * TypeScript's control-flow analysis narrows a captured `let` at the top of a
   * loop and does NOT widen it again across an `await` — so `while (!stopping)`
   * makes every later `stopping` inside the body statically `false`, and the
   * shutdown check that matters gets flagged as "always truthy" and would read
   * to a human as dead code. The flag is genuinely mutated, by `stop()`, from
   * outside this loop's control flow. A call defeats the narrowing and keeps
   * the check honest.
   */
  const isStoppingNow = (): boolean => stopping;
  let processedCount = 0;
  /** The in-flight job, so `stop()` has something to await. */
  let current: Promise<void> | undefined;
  /**
   * The in-flight CLAIM, for the same reason — D-301.
   *
   * `stop()` used to read `current` alone, and in the race this whole change is
   * about `current` is still `undefined`: the claim has not returned, so nothing
   * is executing yet. The deadline branch was therefore skipped entirely and
   * control fell through to `await stopped` — an UNBOUNDED wait on the loop,
   * which was itself parked on the very claim that had not come back. The
   * shutdown window was silently not applied and `worker.drain_timeout` was
   * never logged. Tracking the claim as well is what makes the deadline cover
   * the whole of "the loop is busy", not just the part of it that is a handler.
   */
  let claiming: Promise<void> | undefined;
  let stopped: Promise<void> | undefined;
  /** The single in-progress shutdown, so a second signal joins rather than restarts. */
  let stopRun: Promise<void> | undefined;

  /**
   * The job outran its lock timeout and was reclaimed under it — D-233.
   *
   * One helper for both completion paths so the two lines cannot drift into
   * saying different things about the same event.
   */
  function logReclaimedCompletion(
    intended: 'succeeded' | 'failed',
    job: ClaimedJob,
    startedAt: number,
  ): void {
    metrics.counter(PLATFORM_METRICS.JOB_LEASE_LOST, 1, { kind: job.kind, outcome: intended });
    logger.warn(
      {
        event: 'job.lease_lost',
        kind: job.kind,
        jobId: job.id,
        attempts: job.attempts,
        intended,
        durationMs: clock.now().getTime() - startedAt,
        lockTimeoutMs,
      },
      'this job was reclaimed while its handler was still running; the completion was refused ' +
        'so it could not overwrite the state of the worker that owns it now',
    );
  }

  /**
   * The queue write that records a completion, and the reason it is wrapped.
   *
   * ===========================================================================
   * A COMPLETION WRITE THAT THROWS USED TO ABORT THE SHUTDOWN — D-302.
   *
   * `execute`'s `catch` called `queue.fail(...)` outside any try. The realistic
   * co-occurrence is not exotic: a database blip DURING A DEPLOY makes the
   * handler throw AND makes the failure write throw, so `execute` rejected,
   * `stop()` rejected, and every step after `runner.stop()` in the worker's
   * shutdown — including moving the heartbeat row to `stopped` — was skipped.
   * The row then stayed `running`, went stale at 300 s, and paged somebody
   * about a deploy that had in fact gone fine.
   *
   * The job itself is not lost by swallowing this. The row is still `running`
   * with a lease, and the reaper returns it to the queue at the lock timeout —
   * the documented at-least-once edge, which is safe because handlers are
   * required to be idempotent. Losing the SHUTDOWN is the unrecoverable one.
   */
  async function recordCompletion(
    write: () => Promise<void>,
    job: ClaimedJob,
  ): Promise<void> {
    try {
      await write();
    } catch (error) {
      logger.error(
        {
          event: 'job.completion_write_failed',
          kind: job.kind,
          jobId: job.id,
          attempts: job.attempts,
          err: error instanceof Error ? error.message : 'unknown completion failure',
        },
        'the job outcome could not be written to the queue; the row keeps its lease and ' +
          'the reaper will return it at the lock timeout',
      );
    }
  }

  async function execute(job: ClaimedJob): Promise<void> {
    const handler = handlers[job.kind];
    const startedAt = clock.now().getTime();

    if (handler === undefined) {
      // A DEPLOYMENT mistake, not a transient failure: an old worker against a
      // newer enqueuer. `error`, because waiting will not fix it.
      logger.error(
        { event: 'job.no_handler', kind: job.kind, jobId: job.id },
        'no handler registered for this job kind; the worker is behind the enqueuer',
      );
      await recordCompletion(async () => {
        await queue.fail(job, `no handler registered for kind "${job.kind}"`, clock.now());
      }, job);
      return;
    }

    try {
      await handler(job);
      const landed = await queue.succeed(job, clock.now());
      if (!landed) {
        /**
         * THE LEASE WAS LOST WHILE THE HANDLER RAN — D-233.
         *
         * The reaper reclaimed this job past its lock timeout and another
         * worker owns it now, so the completion was refused rather than allowed
         * to overwrite that worker's state. The WORK still happened, possibly
         * twice — which is the documented at-least-once edge and is why
         * handlers are required to be idempotent — but the queue's bookkeeping
         * is not this process's to write any more.
         *
         * `warn`, not `error`: nothing is broken. It does mean the lock timeout
         * is shorter than this kind of job actually takes, which is worth
         * seeing, and `job.reclaimed` alone would not say which job it was.
         */
        logReclaimedCompletion('succeeded', job, startedAt);
        return;
      }
      metrics.counter(PLATFORM_METRICS.JOB_COMPLETED, 1, { kind: job.kind, outcome: 'succeeded' });
      logger.info(
        {
          event: 'job.succeeded',
          kind: job.kind,
          jobId: job.id,
          attempts: job.attempts,
          durationMs: clock.now().getTime() - startedAt,
        },
        'job completed',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown job failure';
      // D-302 — the write is guarded. A database blip during a deploy makes the
      // handler AND this write throw, and an unguarded throw here rejected
      // `stop()` and skipped the rest of the shutdown. See `recordCompletion`.
      let outcome: FailureOutcome | undefined;
      await recordCompletion(async () => {
        outcome = await queue.fail(job, message, clock.now());
      }, job);
      if (outcome === undefined) return;

      if (outcome === 'lease_lost') {
        // Same race as above, on the failure path — and the more dangerous
        // direction: without the fence this stale `failed` would have been
        // written over the state of whoever owns the job now, including over a
        // `succeeded` it had already reached.
        logReclaimedCompletion('failed', job, startedAt);
        return;
      }

      metrics.counter(PLATFORM_METRICS.JOB_COMPLETED, 1, { kind: job.kind, outcome });
      metrics.counter(
        outcome === 'dead' ? PLATFORM_METRICS.JOB_DEAD : PLATFORM_METRICS.JOB_RETRIED,
        1,
        { kind: job.kind },
      );

      // `error` when it is dead, `warn` when it will be retried. A transient
      // failure that recovers on the next attempt is not worth waking anyone;
      // a job that has given up entirely is, because nothing else will report
      // that the work never happened.
      const line = {
        event: outcome === 'dead' ? 'job.dead' : 'job.failed',
        kind: job.kind,
        jobId: job.id,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        // The MESSAGE only. Never the payload — it can carry identifiers — and
        // never the stack, which ends up in an alert body.
        err: message,
      };
      if (outcome === 'dead') {
        logger.error(line, 'job exhausted its attempts and will not run again');
      } else {
        logger.warn(line, 'job failed and will be retried with backoff');
      }
    } finally {
      processedCount += 1;
    }
  }

  async function runOnce(): Promise<boolean> {
    // The reaper runs on every poll rather than on a timer of its own. It is
    // one indexed UPDATE that usually matches nothing, and a separate schedule
    // is a second thing that can stop running without anybody noticing.
    const reclaimed = await queue.reapStuck(lockTimeoutMs, clock.now());
    if (reclaimed > 0) {
      metrics.counter(PLATFORM_METRICS.JOB_RECLAIMED, reclaimed);
      logger.warn(
        { event: 'job.reclaimed', count: reclaimed },
        'jobs were stuck in running past the lock timeout and have been requeued',
      );
    }

    // §12 step 3, the half that is easy to miss: checked HERE, immediately
    // before the claim. A job claimed one millisecond into a shutdown is a job
    // that gets killed and reclaimed, so it runs twice for no reason at all.
    if (isStoppingNow()) return false;

    // AND checked again on the way out of `claimOrRelease`, because the flag can
    // flip while the claim is on the wire — D-301. See the header.
    const attempt = claimOrRelease();
    /**
     * Published so `stop()` has something to await while a claim is in flight.
     *
     * Rejections are absorbed here rather than at the awaiting end: `stop()`
     * asks "is this still running?", and the loop below has its own error
     * handling for the answer. A rejecting `claiming` would have made the
     * shutdown path throw, which is D-302 in a second costume.
     */
    claiming = attempt.then(
      () => undefined,
      () => undefined,
    );
    let job: ClaimedJob | null;
    try {
      job = await attempt;
    } finally {
      claiming = undefined;
    }
    if (job === null) return false;

    current = execute(job);
    try {
      await current;
    } finally {
      current = undefined;
    }
    return true;
  }

  /**
   * Claims, then re-reads the stopping flag — D-301.
   *
   * The window between those two lines is a network round trip, and a SIGTERM
   * inside it is the ordinary case on a deploy rather than a rare interleaving.
   * A job claimed into a shutdown is handed straight back so the next process
   * picks it up immediately, instead of being run (and killed by the drain
   * deadline) or stranded until the 120-second reaper notices.
   */
  async function claimOrRelease(): Promise<ClaimedJob | null> {
    const job = await queue.claim(workerId, kinds, clock.now());
    if (job === null) return null;
    if (!isStoppingNow()) return job;

    // The release is best-effort by construction. If it fails, the row keeps its
    // lease and the reaper returns it at the lock timeout — slower, but never
    // wrong, and never a reason for the shutdown to stop making progress.
    await recordCompletion(async () => {
      const released = await queue.release(job, clock.now());
      logger.warn(
        {
          event: released ? 'job.released' : 'job.release_lease_lost',
          kind: job.kind,
          jobId: job.id,
          attempts: job.attempts,
        },
        released
          ? 'shutdown began while this job was being claimed; it was returned to the queue ' +
              'unrun rather than started'
          : 'shutdown began while this job was being claimed, but the lease had already been ' +
              'reclaimed; the job belongs to another worker now',
      );
    }, job);
    return null;
  }

  async function loop(): Promise<void> {
    while (!isStoppingNow()) {
      let didWork = false;
      try {
        didWork = await runOnce();
      } catch (error) {
        // The QUEUE itself failed — the database is unreachable, most likely.
        // The loop must not die: §3.2 says a dead worker means "jobs pause and
        // resume", and a crash-loop against an unreachable database is a
        // restart storm aimed at something already struggling. Back off to the
        // idle interval and try again.
        logger.error(
          {
            event: 'job.poll_failed',
            err: error instanceof Error ? error.message : 'unknown queue failure',
          },
          'the job queue could not be polled; retrying after the idle interval',
        );
      }

      await options.onTick?.(processedCount);

      // Only sleep when there was nothing to do. Sleeping after every job would
      // cap throughput at one job per interval, which turns a backlog into a
      // backlog that takes hours to clear.
      if (!didWork && !isStoppingNow()) {
        await sleeper.sleep(idlePollMs);
      }
    }
  }

  /**
   * §12 step 3, in full.
   *
   * THE ORDER OF THE LAST TWO STEPS IS THE WHOLE THING, and getting it wrong is
   * subtle enough that it happened here first.
   *
   * The obvious shape is "set the flag, wait for the job with a deadline, then
   * await the loop so we know it has ended". That DEFEATS THE DEADLINE: the
   * loop is itself sitting on `await current`, so awaiting it waits for exactly
   * the job that was just given up on. The timeout logs, and then blocks
   * forever anyway — a shutdown window that reports being exceeded and then
   * honours it regardless.
   *
   * So the loop is awaited ONLY when the drain actually finished. When it did
   * not, this returns immediately and the abandoned job keeps running until the
   * process exits with it. That is not a leak; it is the documented
   * at-least-once edge — the stuck-job reaper returns the row to the queue and
   * the handler runs again, which is safe precisely because handlers are
   * required to be idempotent.
   */
  async function runStop(reason: string): Promise<void> {
    stopping = true;
    logger.warn(
      { event: 'worker.stopping', reason, shutdownTimeoutMs },
      'worker shutdown started; claiming no new jobs',
    );

    /**
     * ONE budget, spanning both waits — D-301.
     *
     * `current ?? claiming` is the fix for the race: when a SIGTERM lands inside
     * a claim there is no `current` yet, and reading only `current` skipped
     * straight past the deadline into an unbounded `await stopped`.
     *
     * And `stopped` is now waited on UNDER THE SAME DEADLINE rather than
     * unbounded. The old shape trusted the loop to end promptly once the drain
     * finished, which is true of the handler and NOT true of everything else in
     * an iteration — `reapStuck`, `onTick`'s heartbeat and scheduler probe are
     * all database calls, and a database that has just gone away is exactly the
     * condition under which a deploy is happening. `shutdownTimeoutMs` is the
     * promise made to the orchestrator; it has to bound the whole of `stop()`,
     * or SIGKILL arrives and skips every remaining cleanup step — which is the
     * outcome the deadline exists to prevent.
     */
    const deadlineAt = Date.now() + shutdownTimeoutMs;
    const remainingMs = (): number => deadlineAt - Date.now();

    const timedOut = (): void => {
      logger.error(
        { event: 'worker.drain_timeout', reason, shutdownTimeoutMs },
        'a job did not finish within the shutdown window; it will be reclaimed and rerun',
      );
    };

    const inFlight = current ?? claiming;
    if (inFlight !== undefined && !(await withDeadline(inFlight, remainingMs()))) {
      timedOut();
      // Deliberately NOT awaiting the loop. See above.
      return;
    }

    if (stopped !== undefined && !(await withDeadline(stopped, remainingMs()))) {
      timedOut();
    }
  }

  return {
    start(): Promise<void> {
      stopped ??= loop();
      return stopped;
    },

    /**
     * Idempotent, for the same reason `createShutdownController` is: an
     * orchestrator that sends SIGTERM twice, or SIGTERM then SIGINT, must not
     * start two drains. A second call returns the FIRST call's promise, so both
     * callers observe the same outcome at the same moment.
     */
    stop(reason: string): Promise<void> {
      stopRun ??= runStop(reason);
      return stopRun;
    },

    runOnce,
    isStopping: (): boolean => stopping,
    processed: (): number => processedCount,
  };
}
