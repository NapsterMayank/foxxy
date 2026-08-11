import { createRealSleeper, type Clock, type Sleeper } from '@/platform/clock/index';
import type { Config } from '@/platform/config/index';
import type { DbHandle } from '@/platform/db/index';
import {
  buildWorkerId,
  createHeartbeat,
  createJobRunner,
  createPostgresJobQueue,
  type JobHandler,
  type JobQueue,
  type JobRunner,
} from '@/platform/jobs/index';
import type { Logger } from '@/platform/logger/index';
import type { MetricsPort } from '@/platform/metrics/index';
import { NOTIFY_DIGEST_SCAN_JOB, type NotifyModule } from '@/modules/notify/index';
import {
  EXPIRED_SESSION_SWEEPER,
  createExpiredSessionSweeper,
} from './jobs/expired-session-sweeper';
import { buildNotifyHandlers } from './jobs/notify-jobs';
import { ensureRecurringJobs, type RecurringJob } from './scheduler';

/**
 * The worker — 04-RESILIENCE-PLAN.md §3.2.
 *
 * ===========================================================================
 * "SAME CODEBASE, DIFFERENT ENTRY POINTS, INDEPENDENT FAILURE AND INDEPENDENT
 * SCALING." §3.2 already listed this process as "already in place". It was not:
 * there was one entry point, `src/main.ts`, and no job existed to run in a
 * second one.
 *
 * Same codebase means the same `platform/`, the same config validation, the
 * same logger, the same clock. What differs is that this process serves no HTTP
 * and holds no request state — so if it dies, §3.2's promise holds: "jobs pause
 * and resume. USERS SEE NOTHING."
 *
 * ===========================================================================
 * IT RUNS ON THE `worker` POOL. SIX CONNECTIONS. NEVER `core`, NEVER `auth`.
 *
 * §3.1: "Separate process; digests must never compete with live traffic."
 *
 * This is the one thing about this file that must not be casually changed. The
 * sweeper DELETEs from `sessions`, which is the table login reads, and the
 * digest will eventually run expensive aggregate queries. On `core` those would
 * queue behind — and ahead of — real user requests. On `worker` they are capped
 * at six connections no matter how badly they behave, and the worst outcome of
 * a runaway job is that jobs are slow.
 *
 * ===========================================================================
 * THE SHUTDOWN SEQUENCE IS §12 STEPS 3-5, IN ORDER:
 *
 *   3. finish the current job, up to 30 s, claim no new ones  → `runner.stop()`
 *   4. close the database pool                                → `closeResources`
 *   5. exit 0
 *
 * Step 1 (readiness 503) and step 2 (drain HTTP) have no analogue: there is no
 * listener and no load balancer pointed at this process. Its equivalent is the
 * heartbeat row moving to `stopped`, which is done BEFORE the pool closes —
 * after, and the write would fail on a closed pool and the row would read as a
 * worker that vanished rather than one that shut down cleanly.
 */

/**
 * The recurring work this process COULD own.
 *
 * ===========================================================================
 * IT IS FILTERED BY WHICH HANDLERS ARE ACTUALLY REGISTERED, and that filter is
 * the thing to preserve.
 *
 * A recurring entry with no handler enqueues a row every day that the runner
 * refuses with "no handler registered", retries five times and marks `dead`.
 * That is a job that never runs, reported as five errors a day, forever — noise
 * that trains whoever reads the logs to ignore exactly the message that means
 * "the worker is behind the enqueuer".
 *
 * The weekly digest scan is the live case: it is registered only when the
 * `parent` module has wired its content seam, so until then it is neither
 * scheduled nor handled, rather than scheduled and failing.
 */
export const RECURRING_JOBS: readonly RecurringJob[] = [
  { kind: EXPIRED_SESSION_SWEEPER, cadence: 'daily' },
  /**
   * WEEKLY, keyed by the week's Monday in UTC — the same mechanism as the daily
   * sweep, with a coarser period. It enqueues one digest job per due parent and
   * builds no content itself; see `notify.scanWeeklyDigests`.
   *
   * `run_at` is left at its default, so the scan runs whenever the worker first
   * ticks in a new week. The 09:00 Asia/Kolkata DELIVERY time that §4 of the
   * roadmap cares about is handled by quiet hours on the delivery job, not by
   * the scan — the scan wakes nobody.
   */
  { kind: NOTIFY_DIGEST_SCAN_JOB, cadence: 'weekly' },
];

/** The recurring entries whose handler this process actually has. */
export function scheduledJobsFor(
  handlers: Readonly<Record<string, JobHandler>>,
  jobs: readonly RecurringJob[] = RECURRING_JOBS,
): readonly RecurringJob[] {
  return jobs.filter((job) => handlers[job.kind] !== undefined);
}

/**
 * The slice of `Config` this process actually reads — D-306.
 *
 * A narrow structural type rather than the whole `Config`, for the same reason
 * `notify.service.ts` declares "the narrow slice of `JobQueue` this module
 * needs". The full object is ~30 frozen sub-objects with boot-time validation
 * behind it, and demanding all of it here made `createWorker` reachable only
 * from a process that had already parsed the environment — which is why
 * `worker.ts` sat at 0% coverage while owning the shutdown choreography.
 *
 * The real `Config` satisfies this structurally, so `worker-main.ts` passes it
 * unchanged and nothing at the composition root moves.
 */
export interface WorkerConfig {
  readonly env: Config['env'];
  readonly shutdown: { readonly workerTimeoutMs: number };
}

export interface WorkerDeps {
  readonly config: WorkerConfig;
  /** MUST be the `worker` pool. See the header. */
  readonly db: DbHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: MetricsPort;
  /** Injected so a loop test never waits on a real timer (plan §9.5). */
  readonly sleeper?: Sleeper;
  /**
   * The `notify` module, wired on the `worker` pool by
   * `buildModules(container, { forWorker: true })`.
   *
   * Optional so that a test wanting one deterministic job does not have to
   * construct a dispatcher, a channel map and a queue to get it. When absent,
   * remote notification delivery is simply not handled by this process — which
   * is visible in the `kinds` list logged at startup.
   */
  readonly notify?: NotifyModule;
  /** Overridden by tests that want one deterministic job and nothing else. */
  readonly handlers?: Readonly<Record<string, JobHandler>>;
  /**
   * Overridden by tests that need the QUEUE to misbehave — D-306.
   *
   * Specifically: a completion write that throws. That is the co-occurrence
   * D-302/D-303 are about — a database blip during a deploy — and it is not
   * reproducible against a healthy container, so the seam has to exist for the
   * ordering guarantee below to be a checked claim rather than a comment.
   *
   * Defaults to the real Postgres queue on `db`. Nothing in production passes it.
   */
  readonly queue?: JobQueue;
  readonly workerId?: string;
  readonly idlePollMs?: number;
}

export interface Worker {
  readonly workerId: string;
  readonly queue: JobQueue;
  readonly runner: JobRunner;
  /** Runs until `stop()`. */
  start(): Promise<void>;
  /** §12 steps 3-4. Does NOT exit the process — `main` owns that. */
  stop(reason: string): Promise<void>;
}

/**
 * Builds the worker's handler registry.
 *
 * Separate from `createWorker` so a test can see exactly which kinds are
 * registered without starting anything, and so that the answer to "what does
 * the worker actually do" is one greppable function rather than a constructor
 * argument.
 */
export function buildHandlers(deps: {
  readonly db: DbHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly notify?: NotifyModule;
}): Readonly<Record<string, JobHandler>> {
  return {
    [EXPIRED_SESSION_SWEEPER]: createExpiredSessionSweeper(deps),
    /**
     * Notification delivery, and — ONLY when `parent` has wired its content
     * seam — the weekly digest scan and its per-parent delivery.
     *
     * The digest handlers are gated rather than stubbed, which is the same rule
     * this comment used to state as a plan: "a registered handler that does
     * nothing would let a job succeed without doing the work, which is worse
     * than the 'no handler registered' error the runner raises". Nothing about
     * that changed; what changed is that the SCHEDULING half now exists and can
     * be tested, while the content half is still absent and still loud.
     *
     * The retention scheduler still lands with `practice`.
     */
    ...(deps.notify === undefined ? {} : buildNotifyHandlers(deps.notify, deps.logger)),
  };
}

export function createWorker(deps: WorkerDeps): Worker {
  const { config, db, clock, logger, metrics } = deps;
  const sleeper = deps.sleeper ?? createRealSleeper();
  const startedAt = clock.now();
  const workerId = deps.workerId ?? buildWorkerId(startedAt, process.pid);

  const queue = deps.queue ?? createPostgresJobQueue({ db });
  const handlers =
    deps.handlers ??
    buildHandlers({
      db,
      clock,
      logger,
      ...(deps.notify === undefined ? {} : { notify: deps.notify }),
    });
  // Derived from the handlers, never from the constant: an entry with no
  // handler would enqueue a job a day that can only ever die. See the note on
  // `RECURRING_JOBS`.
  const scheduled = scheduledJobsFor(handlers);
  const heartbeat = createHeartbeat({ db, clock, logger, workerId });

  const runner = createJobRunner({
    queue,
    handlers,
    clock,
    sleeper,
    logger,
    metrics,
    workerId,
    // §12 step 3 — "up to 30 s", read from the same config the API's drain
    // timeout comes from rather than hardcoded, so an operator tuning one
    // deployment's shutdown window can see both numbers in one place.
    shutdownTimeoutMs: config.shutdown.workerTimeoutMs,
    ...(deps.idlePollMs === undefined ? {} : { idlePollMs: deps.idlePollMs }),
    onTick: async (processed: number): Promise<void> => {
      // Both of these run every tick and both are cheap by construction: the
      // scheduler is an index probe that matches, and the heartbeat is a
      // single-row upsert. Neither may throw — `ensureRecurringJobs` is the
      // only one that can, so it is guarded here rather than being allowed to
      // take down the loop.
      try {
        const created = await ensureRecurringJobs(queue, scheduled, clock.now());
        for (const kind of created) {
          logger.info({ event: 'worker.scheduled', kind }, 'recurring job enqueued for today');
        }
      } catch (error) {
        logger.error(
          {
            event: 'worker.schedule_failed',
            err: error instanceof Error ? error.message : 'unknown scheduling failure',
          },
          'could not ensure recurring jobs; will retry on the next tick',
        );
      }
      await heartbeat.beat(processed);
    },
  });

  return {
    workerId,
    queue,
    runner,

    async start(): Promise<void> {
      await heartbeat.beat(0);
      logger.info(
        {
          workerId,
          kinds: Object.keys(handlers),
          pool: 'worker',
          env: config.env,
        },
        'worker started',
      );
      await runner.start();
    },

    async stop(reason: string): Promise<void> {
      /**
       * §12 step 3: finish the current job, claim no new ones.
       *
       * ======================================================================
       * GUARDED, BECAUSE THE STEP AFTER IT IS THE ONE THAT DECIDES WHETHER A
       * CLEAN DEPLOY PAGES SOMEBODY — D-303.
       *
       * These two awaits used to be bare and sequential, and the comment below
       * already stated the consequence of the second one not running. It did not
       * run: a completion write that threw — a database blip during a deploy,
       * which is the same blip that makes the deploy happen — rejected
       * `runner.stop()`, so `heartbeat.stop()` was never reached and the row
       * stayed `running`. Five minutes later `worker_heartbeat_stale` fired on a
       * worker that had shut down perfectly.
       *
       * `runner.stop()` is now hardened not to reject (D-301, D-302) and this is
       * belt and braces on top of it. That is deliberate: the ordering promise
       * below must hold for reasons this file can enforce locally, rather than
       * depending on a property of another module that a future change could
       * quietly remove.
       */
      try {
        await runner.stop(reason);
      } catch (error) {
        logger.error(
          {
            workerId,
            reason,
            err: error instanceof Error ? error.message : 'unknown drain failure',
          },
          'the job drain failed; continuing the shutdown so the heartbeat row still ' +
            'reads as stopped rather than vanished',
        );
      }
      // BEFORE the pool closes. After it, this write fails and the row reads as
      // a worker that vanished rather than one that stopped cleanly — which is
      // the difference between "deploy went fine" and "page somebody".
      //
      // `heartbeat.stop` swallows its own failures by construction (see
      // `createHeartbeat`), so nothing after this can be skipped by it either.
      await heartbeat.stop(runner.processed());
      logger.warn({ workerId, reason, processed: runner.processed() }, 'worker stopped');
    },
  };
}
