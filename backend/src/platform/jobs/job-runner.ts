import type { Clock, Sleeper } from '../clock/index';
import type { Logger } from '../logger/index';
import { PLATFORM_METRICS, createNoopMetrics, type MetricsPort } from '../metrics/index';
import type { JobHandler, JobQueue, JobRecord } from './job.port';

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
 * means it runs twice for no reason. `stopping` is checked immediately before
 * every claim and is the first thing `stop()` sets.
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

/** Waits for `promise`, but not past `ms`. Resolves true if it finished. */
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
    return await Promise.race([promise.then(() => true), deadline]);
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
  let stopped: Promise<void> | undefined;
  /** The single in-progress shutdown, so a second signal joins rather than restarts. */
  let stopRun: Promise<void> | undefined;

  async function execute(job: JobRecord): Promise<void> {
    const handler = handlers[job.kind];
    const startedAt = clock.now().getTime();

    if (handler === undefined) {
      // A DEPLOYMENT mistake, not a transient failure: an old worker against a
      // newer enqueuer. `error`, because waiting will not fix it.
      logger.error(
        { event: 'job.no_handler', kind: job.kind, jobId: job.id },
        'no handler registered for this job kind; the worker is behind the enqueuer',
      );
      await queue.fail(job.id, `no handler registered for kind "${job.kind}"`, clock.now());
      return;
    }

    try {
      await handler(job);
      await queue.succeed(job.id, clock.now());
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
      const outcome = await queue.fail(job.id, message, clock.now());

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

    const job = await queue.claim(workerId, kinds, clock.now());
    if (job === null) return false;

    current = execute(job);
    try {
      await current;
    } finally {
      current = undefined;
    }
    return true;
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

    const inFlight = current;
    if (inFlight !== undefined) {
      const finished = await withDeadline(inFlight, shutdownTimeoutMs);
      if (!finished) {
        logger.error(
          { event: 'worker.drain_timeout', reason, shutdownTimeoutMs },
          'a job did not finish within the shutdown window; it will be reclaimed and rerun',
        );
        // Deliberately NOT awaiting the loop. See above.
        return;
      }
    }

    await stopped;
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
