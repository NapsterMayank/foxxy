import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock, type Sleeper } from '@/platform/clock/index';
import { createDb, type DbHandle } from '@/platform/db/index';
import { FakeLogger } from '@/platform/logger/index';
import { MemoryMetrics } from '@/platform/metrics/index';
import {
  createPostgresJobQueue,
  readWorkerLiveness,
  type FailureOutcome,
  type JobHandler,
  type JobQueue,
} from '@/platform/jobs/index';
import { createWorker, type Worker, type WorkerConfig } from '@/worker/worker';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../helpers/postgres';

/**
 * THE WORKER'S SHUTDOWN CHOREOGRAPHY, AGAINST A REAL POSTGRES — §12 steps 3-5.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS AT ALL.
 *
 * `src/worker/worker.ts` sat at 0% coverage while owning the ordering that
 * decides whether a routine deploy is invisible or pages somebody. An earlier
 * audit predicted the consequence in those words — "the shutdown-ordering
 * choreography is exactly what regresses silently" — and then four defects
 * accumulated in it (D-301 through D-305), every one of them reachable by an
 * ordinary SIGTERM during an ordinary deploy.
 *
 * ===========================================================================
 * A REAL DATABASE, NOT A FAKE — and here that is not ceremony.
 *
 * The properties under test are the ones that only exist in Postgres: a claim
 * released back to `pending` with its `attempts` counter wound back, a reclaim
 * under `FOR UPDATE SKIP LOCKED` with two workers competing, and a heartbeat row
 * whose `last_beat_at` comes back through the raw-SQL path that D-305 was about.
 * A fake would pass all of it while proving none of it.
 *
 * NOTHING SLEEPS (§9.5). Every deadline is a `FixedClock` plus an explicit gate.
 */

let postgres: TestPostgres;
let handle: DbHandle;

const KIND = 'test.worker.job';

const CONFIG: WorkerConfig = {
  env: 'test',
  shutdown: { workerTimeoutMs: 30_000 },
};

/** Yields a macrotask so the poll loop cannot spin a core. See job-runner tests. */
class YieldingSleeper implements Sleeper {
  readonly delays: number[] = [];

  sleep(milliseconds: number): Promise<void> {
    this.delays.push(milliseconds);
    return new Promise((resolve) => setImmediate(resolve));
  }
}

/** A latch a test can open once, used to hold a handler or a queue call open. */
class Gate {
  private release: (() => void) | undefined;
  readonly opened: Promise<void>;

  constructor() {
    this.opened = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  open(): void {
    this.release?.();
  }
}

/** Resolves the first time something calls `hit()`. */
class Signal {
  private fire: (() => void) | undefined;
  readonly reached: Promise<void>;

  constructor() {
    this.reached = new Promise<void>((resolve) => {
      this.fire = resolve;
    });
  }

  hit(): void {
    this.fire?.();
  }
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await applyAllMigrations(postgres.client);
  handle = createDb({ url: postgres.url, poolMax: 8, ssl: false });
}, 180_000);

afterAll(async () => {
  await handle.close();
  await postgres.stop();
}, 60_000);

beforeEach(async () => {
  await postgres.client.query('truncate table jobs');
  await postgres.client.query('truncate table worker_heartbeats');
});

interface Built {
  readonly worker: Worker;
  readonly logger: FakeLogger;
  readonly clock: FixedClock;
}

let running: Promise<void>[] = [];

afterEach(async () => {
  // Every loop started by a test is drained here, so a failed assertion cannot
  // leave a poll loop hammering a container the next file is about to use.
  await Promise.allSettled(running);
  running = [];
});

function buildWorker(options: {
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly workerId: string;
  readonly queue?: JobQueue;
  readonly shutdownTimeoutMs?: number;
}): Built {
  const clock = new FixedClock('2026-08-09T09:00:00.000Z');
  const logger = new FakeLogger();
  const worker = createWorker({
    config:
      options.shutdownTimeoutMs === undefined
        ? CONFIG
        : { ...CONFIG, shutdown: { workerTimeoutMs: options.shutdownTimeoutMs } },
    db: handle,
    clock,
    logger,
    metrics: new MemoryMetrics({ clock }),
    sleeper: new YieldingSleeper(),
    handlers: options.handlers,
    workerId: options.workerId,
    idlePollMs: 5,
    ...(options.queue === undefined ? {} : { queue: options.queue }),
  });
  return { worker, logger, clock };
}

async function enqueue(idempotencyKey: string): Promise<void> {
  await createPostgresJobQueue({ db: handle }).enqueue({ kind: KIND, idempotencyKey });
}

interface JobRowSnapshot {
  readonly status: string;
  readonly attempts: number;
  readonly locked_by: string | null;
}

async function jobRow(): Promise<JobRowSnapshot> {
  const result = await postgres.client.query<JobRowSnapshot>(
    'select status, attempts, locked_by from jobs limit 1',
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('expected exactly one job row');
  return row;
}

async function heartbeatStatus(workerId: string): Promise<string | undefined> {
  const result = await postgres.client.query<{ status: string }>(
    'select status from worker_heartbeats where worker_id = $1',
    [workerId],
  );
  return result.rows[0]?.status;
}

function hasEvent(logger: FakeLogger, event: string): boolean {
  return logger.lines.some((line) => line.obj.event === event);
}

/**
 * Waits for a condition by yielding turns, never by sleeping (§9.5).
 *
 * Needed because `worker.start()` does not RESOLVE until the loop ends — it is
 * the loop — so "the worker is up" has to be observed rather than awaited. The
 * observable fact is the first heartbeat: `start()` writes it before entering
 * the loop. Without this, a test that calls `stop()` immediately after `start()`
 * races the boot beat against the stopping write, and the row can end up
 * `running` for a worker that stopped perfectly — a flake that says nothing
 * about the code.
 */
async function until(condition: () => Promise<boolean>, turns = 200): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was never met');
}

/** Starts the loop and returns once the boot heartbeat has landed. */
async function startAndSettle(worker: Worker, workerId: string): Promise<void> {
  running.push(worker.start());
  await until(async () => (await heartbeatStatus(workerId)) !== undefined);
}

describe('SIGTERM mid-job', () => {
  it('finishes the job, then marks the heartbeat row stopped', async () => {
    // §12 step 3 then the step §3.2 calls the worker's equivalent of readiness.
    // The ORDER is the whole thing: the row has to move to `stopped` before the
    // pool closes, or it reads as a worker that vanished rather than one that
    // shut down cleanly.
    await enqueue('mid-job');
    const started = new Signal();
    const finish = new Gate();
    let completed = false;

    const { worker, logger } = buildWorker({
      workerId: 'worker-mid-job',
      handlers: {
        [KIND]: async () => {
          started.hit();
          await finish.opened;
          completed = true;
        },
      },
    });

    running.push(worker.start());
    await started.reached;

    const stopping = worker.stop('SIGTERM');
    expect(completed).toBe(false);
    finish.open();
    await stopping;

    expect(completed).toBe(true);
    expect((await jobRow()).status).toBe('succeeded');
    expect(await heartbeatStatus('worker-mid-job')).toBe('stopped');
    expect(hasEvent(logger, 'job.succeeded')).toBe(true);
  });
});

describe('SIGTERM while idle', () => {
  it('stops without claiming anything and still records the stop', async () => {
    // The commonest deploy of all: nothing in the queue. It has to be as clean
    // as the busy case, and it has to leave the same evidence behind.
    const { worker } = buildWorker({
      workerId: 'worker-idle',
      handlers: { [KIND]: () => Promise.resolve() },
    });

    await startAndSettle(worker, 'worker-idle');
    await worker.stop('SIGTERM');

    expect(await heartbeatStatus('worker-idle')).toBe('stopped');
    expect(worker.runner.processed()).toBe(0);
  });
});

describe('a job that outlasts the drain window', () => {
  it('gives up, says so, and still marks the heartbeat row stopped', async () => {
    // A drain that never finishes is worse than one that gives up: SIGKILL
    // arrives regardless and skips every remaining cleanup step. The abandoned
    // job keeps its lease and the reaper returns it, which is safe precisely
    // because handlers are required to be idempotent.
    //
    // The heartbeat assertion is the D-303 half: the timeout branch used to
    // `return` out of `runStop` and everything after it still had to run.
    await enqueue('slow-job');
    const started = new Signal();
    const finish = new Gate();

    const { worker, logger } = buildWorker({
      workerId: 'worker-slow',
      handlers: {
        [KIND]: async () => {
          started.hit();
          await finish.opened;
        },
      },
      // 1 ms rather than 30 s. The property under test is the timeout BRANCH.
      shutdownTimeoutMs: 1,
    });

    running.push(worker.start());
    await started.reached;
    await worker.stop('SIGTERM');

    expect(hasEvent(logger, 'worker.drain_timeout')).toBe(true);
    expect(await heartbeatStatus('worker-slow')).toBe('stopped');

    finish.open();
  });
});

describe('D-302/D-303 — a completion write that throws during shutdown', () => {
  it('still marks the heartbeat row stopped rather than leaving it running', async () => {
    // THE DEFECT, END TO END. The database blips during a deploy: the handler
    // throws AND the `queue.fail` recording it throws. `runner.stop()` rejected,
    // so `heartbeat.stop()` never ran, the row stayed `running`, went stale at
    // 300 s, and `worker_heartbeat_stale` paged somebody about a deploy that had
    // gone perfectly.
    //
    // The heartbeat here is REAL — same pool, same table — so what is asserted
    // is the row an on-call engineer would actually read.
    await enqueue('failing-job');
    const real = createPostgresJobQueue({ db: handle });
    const brokenQueue: JobQueue = {
      enqueue: (input) => real.enqueue(input),
      claim: (workerId, kinds, now) => real.claim(workerId, kinds, now),
      succeed: (job, now) => real.succeed(job, now),
      fail: (): Promise<FailureOutcome> =>
        Promise.reject(new Error('db down: could not record failure')),
      release: (job, now) => real.release(job, now),
      reapStuck: (lockTimeoutMs, now) => real.reapStuck(lockTimeoutMs, now),
      countByStatus: () => real.countByStatus(),
    };

    const started = new Signal();
    const { worker, logger } = buildWorker({
      workerId: 'worker-broken-write',
      queue: brokenQueue,
      handlers: {
        [KIND]: () => {
          started.hit();
          return Promise.reject(new Error('provider down'));
        },
      },
    });

    running.push(worker.start());
    await started.reached;
    await worker.stop('SIGTERM');

    expect(await heartbeatStatus('worker-broken-write')).toBe('stopped');
    expect(hasEvent(logger, 'job.completion_write_failed')).toBe(true);
    // The row keeps its lease, which is what makes the reaper the recovery path.
    expect((await jobRow()).status).toBe('running');
  });
});

describe('D-301 — SIGTERM arriving inside the claim', () => {
  it('returns the job to pending, unrun, with its attempt given back', async () => {
    // `claim` is a network round trip and a SIGTERM inside it is the ordinary
    // case on a deploy. Against a REAL database this asserts the two things a
    // fake cannot: the row is `pending` with no lease, and `attempts` is back
    // to 0 — because the claim is being undone, not completed. Not winding it
    // back would let a rolling deploy across five restarts walk a job that has
    // never run once all the way to `dead`.
    await enqueue('late-claim');
    const real = createPostgresJobQueue({ db: handle });
    const claimEntered = new Signal();
    const claimGate = new Gate();

    const gatedQueue: JobQueue = {
      enqueue: (input) => real.enqueue(input),
      async claim(workerId, kinds, now) {
        claimEntered.hit();
        await claimGate.opened;
        return real.claim(workerId, kinds, now);
      },
      succeed: (job, now) => real.succeed(job, now),
      fail: (job, error, now) => real.fail(job, error, now),
      release: (job, now) => real.release(job, now),
      reapStuck: (lockTimeoutMs, now) => real.reapStuck(lockTimeoutMs, now),
      countByStatus: () => real.countByStatus(),
    };

    let handlerRuns = 0;
    const { worker, logger } = buildWorker({
      workerId: 'worker-late-claim',
      queue: gatedQueue,
      handlers: {
        [KIND]: () => {
          handlerRuns += 1;
          return Promise.resolve();
        },
      },
    });

    running.push(worker.start());
    await claimEntered.reached;

    const stopping = worker.stop('SIGTERM');
    claimGate.open();
    await stopping;

    expect(handlerRuns).toBe(0);
    expect(hasEvent(logger, 'job.released')).toBe(true);

    const row = await jobRow();
    expect(row.status).toBe('pending');
    expect(row.locked_by).toBeNull();
    expect(row.attempts).toBe(0);
    expect(await heartbeatStatus('worker-late-claim')).toBe('stopped');
  });
});

describe('two workers and one job, under a real reclaim', () => {
  it('refuses the stale worker’s completion and leaves the reclaimer’s state intact', async () => {
    // D-233's fence, exercised through the WORKER rather than the queue: a
    // handler that legitimately outruns the lock timeout is reclaimed under
    // itself, a second worker takes the job, and the first one's completion
    // must not land on a row it no longer owns. `FOR UPDATE SKIP LOCKED` is
    // what makes the second claim possible without the two blocking; both are
    // properties of Postgres and of nothing else.
    await enqueue('contended');
    const queue = createPostgresJobQueue({ db: handle });
    const at = (offsetMs: number): Date => new Date(Date.parse('2026-08-09T09:00:00.000Z') + offsetMs);

    const first = await queue.claim('worker-a', [KIND], at(0));
    expect(first).not.toBeNull();
    if (first === null) return;

    // The lock timeout passes while worker-a is still in its handler.
    const reclaimed = await queue.reapStuck(1_000, at(5_000));
    expect(reclaimed).toBe(1);

    const second = await queue.claim('worker-b', [KIND], at(5_001));
    expect(second).not.toBeNull();
    if (second === null) return;
    expect(second.lockedBy).toBe('worker-b');

    // worker-a finishes and tries to record it. The lease is gone, so nothing
    // lands — otherwise a stale `succeeded` would overwrite worker-b's
    // `running`, and worker-b's later write would then flip a job that had
    // genuinely succeeded back to `failed` and schedule a THIRD run.
    expect(await queue.succeed(first, at(6_000))).toBe(false);
    expect((await jobRow()).status).toBe('running');
    expect((await jobRow()).locked_by).toBe('worker-b');

    // And a release from the stale worker is fenced identically — D-301's new
    // write is not a hole in D-233's fence.
    expect(await queue.release(first, at(6_100))).toBe(false);
    expect((await jobRow()).locked_by).toBe('worker-b');

    expect(await queue.succeed(second, at(7_000))).toBe(true);
    expect((await jobRow()).status).toBe('succeeded');
  });
});

describe('the recurring scheduler, on the real queue', () => {
  it('enqueues today’s occurrence of every job it can actually run', async () => {
    // No `handlers` override here, deliberately: this is the DEFAULT registry
    // the deployed process builds, and the filter that derives the schedule
    // from it is the thing that stops a handler-less entry enqueuing a row a
    // day that can only ever die.
    const clock = new FixedClock('2026-08-09T09:00:00.000Z');
    const logger = new FakeLogger();
    const worker = createWorker({
      config: CONFIG,
      db: handle,
      clock,
      logger,
      metrics: new MemoryMetrics({ clock }),
      sleeper: new YieldingSleeper(),
      workerId: 'worker-scheduler',
      idlePollMs: 5,
    });

    running.push(worker.start());
    await until(async () => {
      const result = await postgres.client.query<{ idempotency_key: string }>(
        'select idempotency_key from jobs',
      );
      return result.rows.length > 0;
    });
    await worker.stop('SIGTERM');

    const keys = await postgres.client.query<{ kind: string; idempotency_key: string }>(
      'select kind, idempotency_key from jobs',
    );
    // Keyed by the UTC date, which is what makes ten replicas ticking every
    // second still produce exactly one row per day.
    expect(keys.rows[0]?.idempotency_key).toBe(`${keys.rows[0]?.kind ?? ''}:2026-08-09`);
    expect(hasEvent(logger, 'worker.scheduled')).toBe(true);
  });

  it('survives the scheduler throwing, rather than taking the loop down with it', async () => {
    // `ensureRecurringJobs` is the only thing on the tick path that can throw,
    // and it runs on EVERY tick. Letting it propagate would turn a transient
    // enqueue failure into a worker that stops processing jobs entirely — the
    // opposite of §3.2's "jobs pause and resume".
    const real = createPostgresJobQueue({ db: handle });
    const brokenEnqueue: JobQueue = {
      enqueue: () => Promise.reject(new Error('db down: could not enqueue')),
      claim: (workerId, kinds, now) => real.claim(workerId, kinds, now),
      succeed: (job, now) => real.succeed(job, now),
      fail: (job, error, now) => real.fail(job, error, now),
      release: (job, now) => real.release(job, now),
      reapStuck: (lockTimeoutMs, now) => real.reapStuck(lockTimeoutMs, now),
      countByStatus: () => real.countByStatus(),
    };

    const clock = new FixedClock('2026-08-09T09:00:00.000Z');
    const logger = new FakeLogger();
    const worker = createWorker({
      config: CONFIG,
      db: handle,
      clock,
      logger,
      metrics: new MemoryMetrics({ clock }),
      sleeper: new YieldingSleeper(),
      queue: brokenEnqueue,
      workerId: 'worker-bad-scheduler',
      idlePollMs: 5,
    });

    running.push(worker.start());
    await until(() => Promise.resolve(hasEvent(logger, 'worker.schedule_failed')));
    await worker.stop('SIGTERM');

    expect(hasEvent(logger, 'worker.schedule_failed')).toBe(true);
    expect(await heartbeatStatus('worker-bad-scheduler')).toBe('stopped');
  });
});

describe('D-305 — readWorkerLiveness against the real driver', () => {
  it('returns a real Date and computes staleness from it', async () => {
    // This function threw `row.last_beat_at.getTime is not a function` on its
    // first contact with a real database: `db.execute` hands back WIRE TEXT for
    // a `timestamptz`, and the row type claimed `Date`. It had zero callers and
    // zero tests, so wiring it into `/health/deps` would have 500'd the health
    // endpoint — the one thing that must not fail while everything else is.
    // Rows are written directly rather than through a worker: `stopped` rows
    // are excluded by the query, so a worker that has shut down leaves nothing
    // to read, and the point here is the ROW DECODING rather than the loop.
    await postgres.client.query(
      `insert into worker_heartbeats (worker_id, started_at, last_beat_at, jobs_processed, status)
       values ('worker-live', $1, $1, 7, 'running')`,
      ['2026-08-09T09:00:00.000Z'],
    );

    const fresh = await readWorkerLiveness(handle, new Date('2026-08-09T09:00:30.000Z'), 60_000);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.workerId).toBe('worker-live');
    expect(fresh[0]?.lastBeatAt).toBeInstanceOf(Date);
    expect(fresh[0]?.lastBeatAt.toISOString()).toBe('2026-08-09T09:00:00.000Z');
    expect(fresh[0]?.jobsProcessed).toBe(7);
    expect(fresh[0]?.stale).toBe(false);

    const later = await readWorkerLiveness(handle, new Date('2026-08-09T09:10:00.000Z'), 60_000);
    expect(later[0]?.stale).toBe(true);
  });
});
