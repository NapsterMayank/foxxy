import { describe, expect, it } from 'vitest';
import { FixedClock, type Sleeper } from '../../clock/index';
import { FakeLogger } from '../../logger/index';
import { MemoryMetrics } from '../../metrics/index';
import { PLATFORM_METRICS } from '../../metrics/metrics.port';
import { createJobRunner } from '../job-runner';
import type { FailureOutcome, JobQueue, JobRecord, JobStatus } from '../job.port';

/**
 * The job runner's LOOP behaviour — 04-RESILIENCE-PLAN.md §12 step 3.
 *
 * A fake queue rather than Postgres, deliberately: the SQL is exercised against
 * a real database in `tests/integration/job-queue.test.ts`, and what is under
 * test here is the shutdown sequence, which is about ORDERING and would be
 * obscured by a container.
 *
 * EVERYTHING RUNS ON `FixedClock` AND A FAKE SLEEPER. Nothing sleeps
 * (plan §9.5), so a test that drains a 30-second shutdown window finishes in
 * microseconds.
 */

/**
 * A sleeper that records the requested delay, advances the injected clock by
 * it, and YIELDS A MACROTASK before resolving.
 *
 * NOT `RecordingSleeper`, and the difference is not cosmetic — it is the
 * difference between this file finishing and this file hanging forever.
 *
 * `RecordingSleeper` resolves with `Promise.resolve()`, a MICROtask. A poll
 * loop built on it never yields to the macrotask queue, so `setImmediate`
 * inside a test never fires and the test that was waiting to call `stop()`
 * never gets a turn. The loop spins, one CPU pegged, and vitest times out with
 * no failing assertion to explain it. (Found exactly that way.)
 *
 * Production is unaffected: `createRealSleeper` uses `setTimeout`, which
 * yields. This is a hazard of the FAKE, which is why the fix belongs here
 * rather than in `platform/clock`.
 *
 * Nothing waits on real time: the delay is recorded and the clock is moved,
 * which is what plan §9.5 actually asks for.
 */
class YieldingSleeper implements Sleeper {
  readonly delays: number[] = [];

  constructor(private readonly clock?: FixedClock) {}

  sleep(milliseconds: number): Promise<void> {
    this.delays.push(milliseconds);
    this.clock?.advanceMs(milliseconds);
    return new Promise((resolve) => setImmediate(resolve));
  }
}

/** A queue that hands out a scripted list of jobs and records what happened. */
class FakeQueue implements JobQueue {
  readonly succeeded: string[] = [];
  readonly failed: { readonly id: string; readonly error: string }[] = [];
  readonly claims: string[] = [];
  reapCount = 0;
  private readonly pending: JobRecord[];

  constructor(jobs: readonly JobRecord[]) {
    this.pending = [...jobs];
  }

  enqueue(): Promise<{ id: string; created: boolean }> {
    return Promise.resolve({ id: 'x', created: true });
  }

  claim(workerId: string): Promise<JobRecord | null> {
    const job = this.pending.shift();
    if (job !== undefined) this.claims.push(workerId);
    return Promise.resolve(job ?? null);
  }

  succeed(jobId: string): Promise<void> {
    this.succeeded.push(jobId);
    return Promise.resolve();
  }

  fail(jobId: string, error: string): Promise<FailureOutcome> {
    this.failed.push({ id: jobId, error });
    return Promise.resolve('retry');
  }

  reapStuck(): Promise<number> {
    return Promise.resolve(this.reapCount);
  }

  countByStatus(): Promise<Readonly<Record<JobStatus, number>>> {
    return Promise.resolve({ pending: 0, running: 0, succeeded: 0, failed: 0, dead: 0 });
  }
}

function job(id: string, kind = 'test.job'): JobRecord {
  return {
    id,
    kind,
    idempotencyKey: `${kind}:${id}`,
    payload: {},
    attempts: 1,
    maxAttempts: 5,
    runAt: new Date(0),
    createdAt: new Date(0),
  };
}

function build(
  queue: JobQueue,
  handlers: Record<string, (record: JobRecord) => Promise<void>>,
  overrides: { readonly shutdownTimeoutMs?: number } = {},
) {
  const clock = new FixedClock();
  const sleeper = new YieldingSleeper(clock);
  const logger = new FakeLogger();
  const metrics = new MemoryMetrics({ clock });
  const runner = createJobRunner({
    queue,
    handlers,
    clock,
    sleeper,
    logger,
    metrics,
    workerId: 'worker-1',
    idlePollMs: 50,
    ...overrides,
  });
  return { runner, clock, sleeper, logger, metrics };
}

describe('SIGTERM lets the current job finish', () => {
  it('completes the in-flight job before the loop ends', async () => {
    // §12 step 3, first half: "let the worker finish its current job, up to
    // 30 s". A worker that abandoned mid-job would leave the row claimed, the
    // side effect half-done, and the reaper would rerun it — so the work is
    // done twice for no reason at all.
    const queue = new FakeQueue([job('job-1')]);
    let released: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      released = resolve;
    });
    let finish: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let completed = false;

    const { runner } = build(queue, {
      'test.job': async () => {
        released?.();
        await held;
        completed = true;
      },
    });

    const loop = runner.start();
    await started;

    // SIGTERM arrives while the handler is mid-flight.
    const stopping = runner.stop('SIGTERM');
    expect(completed).toBe(false);

    finish?.();
    await stopping;
    await loop;

    expect(completed).toBe(true);
    expect(queue.succeeded).toEqual(['job-1']);
  });

  it('claims NO new job once stopping, even with work waiting', async () => {
    // §12 step 3, second half, and the one that is easy to miss. A job claimed
    // one millisecond into a shutdown is a job that gets killed thirty seconds
    // later and reclaimed by the reaper — so it runs twice, for nothing.
    const queue = new FakeQueue([job('job-1'), job('job-2'), job('job-3')]);
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let finish: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const { runner } = build(queue, {
      'test.job': async () => {
        firstStarted?.();
        await held;
      },
    });

    const loop = runner.start();
    await started;
    const stopping = runner.stop('SIGTERM');
    finish?.();
    await stopping;
    await loop;

    // Exactly one claim. `job-2` and `job-3` are still queued for the next
    // process, which is what "jobs pause and resume" (§3.2) means concretely.
    expect(queue.claims).toEqual(['worker-1']);
    expect(queue.succeeded).toEqual(['job-1']);
  });

  it('gives up on a job that outlasts the shutdown window, and says so', async () => {
    // A drain that never finishes is worse than one that gives up: the
    // orchestrator's SIGKILL arrives regardless and skips every other cleanup
    // step on the way. The abandoned job is reclaimed by the reaper, which is
    // safe precisely because handlers are required to be idempotent.
    const queue = new FakeQueue([job('job-1')]);
    let started: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const { runner, logger } = build(
      queue,
      {
        'test.job': async () => {
          started?.();
          await held;
        },
      },
      // 1 ms rather than 30 s. The property under test is the timeout branch,
      // not the duration, and a test that waited 30 s to prove a timeout would
      // be a test nobody runs.
      { shutdownTimeoutMs: 1 },
    );

    const loop = runner.start();
    await running;
    await runner.stop('SIGTERM');

    expect(logger.lines.some((line) => line.obj.event === 'worker.drain_timeout')).toBe(true);

    // Let the abandoned handler finish so the test leaves nothing running.
    finish?.();
    await loop;
  });

  it('is idempotent — two signals do not start two drains', async () => {
    // An orchestrator that sends SIGTERM twice, or SIGTERM then SIGINT, is
    // ordinary. Same reasoning as `createShutdownController`.
    const queue = new FakeQueue([]);
    const { runner } = build(queue, { 'test.job': () => Promise.resolve() });

    const loop = runner.start();
    await Promise.all([runner.stop('SIGTERM'), runner.stop('SIGINT')]);
    await loop;

    expect(runner.isStopping()).toBe(true);
  });
});

describe('failures', () => {
  it('records a thrown handler as a failure and keeps looping', async () => {
    const queue = new FakeQueue([job('job-1'), job('job-2')]);
    let seen = 0;
    const { runner, metrics } = build(queue, {
      'test.job': () => {
        seen += 1;
        return seen === 1 ? Promise.reject(new Error('provider down')) : Promise.resolve();
      },
    });

    await runner.runOnce();
    await runner.runOnce();

    expect(queue.failed).toEqual([{ id: 'job-1', error: 'provider down' }]);
    expect(queue.succeeded).toEqual(['job-2']);
    expect(metrics.totalFor(PLATFORM_METRICS.JOB_RETRIED)).toBe(1);
  });

  it('fails a job whose kind has no handler, and logs at ERROR', async () => {
    // A DEPLOYMENT mistake — an old worker against a newer enqueuer — not a
    // transient failure. `error`, because waiting will not fix it.
    //
    // Note that it is claimed at all only because this test registers the kind
    // and then removes it; in production the runner claims ONLY the kinds it
    // has handlers for, which is the first line of defence.
    const queue = new FakeQueue([job('job-1', 'unknown.kind')]);
    const { runner, logger } = build(queue, { 'unknown.kind': () => Promise.resolve() });
    // Replace the registry after construction so the claim still happens.
    const runnerWithoutHandler = createJobRunner({
      queue,
      handlers: { 'unknown.kind': undefined as unknown as () => Promise<void> },
      clock: new FixedClock(),
      sleeper: new YieldingSleeper(),
      logger,
      workerId: 'worker-1',
    });
    void runner;

    await runnerWithoutHandler.runOnce();

    expect(queue.failed[0]?.error).toContain('no handler registered');
    expect(logger.lines.some((line) => line.obj.event === 'job.no_handler')).toBe(true);
  });

  it('survives the QUEUE itself failing, rather than crash-looping', async () => {
    // §3.2: a dead worker means "jobs pause and resume". A crash-loop against
    // an unreachable database is a restart storm aimed at something already
    // struggling, which turns a blip into an outage.
    const brokenQueue: JobQueue = {
      enqueue: () => Promise.reject(new Error('db down')),
      claim: () => Promise.reject(new Error('db down')),
      succeed: () => Promise.reject(new Error('db down')),
      fail: () => Promise.reject(new Error('db down')),
      reapStuck: () => Promise.reject(new Error('db down')),
      countByStatus: () => Promise.reject(new Error('db down')),
    };
    const { runner, logger } = build(brokenQueue, { 'test.job': () => Promise.resolve() });

    const loop = runner.start();
    // Let a couple of iterations happen, then stop. The sleeper resolves
    // immediately, so this costs nothing in wall time.
    await new Promise((resolve) => setImmediate(resolve));
    await runner.stop('test');
    await loop;

    expect(logger.lines.some((line) => line.obj.event === 'job.poll_failed')).toBe(true);
  });
});

describe('the reaper runs on every poll', () => {
  it('counts and logs reclaimed jobs', async () => {
    // The at-least-once edge made concrete: a worker killed mid-job leaves the
    // row claimed forever. Without a reaper that job never runs again and
    // nothing says so.
    const queue = new FakeQueue([]);
    queue.reapCount = 2;
    const { runner, logger, metrics } = build(queue, { 'test.job': () => Promise.resolve() });

    await runner.runOnce();

    expect(metrics.totalFor(PLATFORM_METRICS.JOB_RECLAIMED)).toBe(2);
    expect(logger.lines.some((line) => line.obj.event === 'job.reclaimed')).toBe(true);
  });
});

describe('idle polling', () => {
  it('sleeps only when there was nothing to claim', async () => {
    // Sleeping after every job would cap throughput at one job per interval,
    // which turns a backlog into a backlog that takes hours to clear.
    const queue = new FakeQueue([job('job-1')]);
    const { runner, sleeper } = build(queue, { 'test.job': () => Promise.resolve() });

    await runner.runOnce();
    expect(sleeper.delays).toEqual([]);

    const loop = runner.start();
    await new Promise((resolve) => setImmediate(resolve));
    await runner.stop('test');
    await loop;

    expect(sleeper.delays.every((delay) => delay === 50)).toBe(true);
  });
});
