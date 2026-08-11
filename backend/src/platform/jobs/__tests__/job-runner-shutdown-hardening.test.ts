import { describe, expect, it } from 'vitest';
import { FixedClock, type Sleeper } from '../../clock/index';
import { FakeLogger } from '../../logger/index';
import { MemoryMetrics } from '../../metrics/index';
import { createJobRunner, type JobRunner } from '../job-runner';
import type { ClaimedJob, FailureOutcome, JobHandler, JobQueue, JobStatus } from '../job.port';

/**
 * THE SHUTDOWN CHOREOGRAPHY, UNDER THE INTERLEAVINGS A DEPLOY ACTUALLY
 * PRODUCES — D-301, D-302.
 *
 * `job-runner.test.ts` covers the shutdown sequence when every step behaves.
 * This file covers the two cases where one does not, both of which were live
 * defects and both of which are ORDINARY on a deploy rather than exotic:
 *
 *   1. SIGTERM arriving WHILE `queue.claim` is on the wire. The old check sat
 *      before the call and nowhere else, so the flag flipped mid-round-trip and
 *      the runner executed a job it had been told not to take — and, worse,
 *      `stop()` could not see the claim at all, so the drain deadline was
 *      skipped and the shutdown hung.
 *   2. A completion write throwing at the same moment the handler does — one
 *      database blip causes both — which rejected `stop()` and skipped every
 *      step after it.
 *
 * NOTHING HERE SLEEPS (§9.5). Interleavings are forced with explicit gates and
 * "did this settle" is measured in event-loop turns, not milliseconds.
 */

/** See `job-runner.test.ts` — a microtask-only sleeper would spin forever. */
class YieldingSleeper implements Sleeper {
  readonly delays: number[] = [];

  constructor(private readonly clock?: FixedClock) {}

  sleep(milliseconds: number): Promise<void> {
    this.delays.push(milliseconds);
    this.clock?.advanceMs(milliseconds);
    return new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Did this promise settle, or is it still pending?
 *
 * Measured in EVENT-LOOP TURNS rather than in a duration. `stop()` hanging was
 * the actual production symptom — the process sat there until SIGKILL — and
 * "still pending after N turns" is what turns that into a named assertion. An
 * `await` on a promise that never resolves would instead give a bare 15-second
 * vitest timeout with nothing to say about why.
 *
 * A turn yields through `setTimeout(0)` rather than `setImmediate`, so the
 * timers phase runs and a deadline that IS due can fire. That is not a sleep in
 * the §9.5 sense — no duration is being waited out and nothing here encodes how
 * long anything takes; it is the loop giving the runtime a turn and asking
 * again. It returns the moment the promise settles.
 */
async function settlement(promise: Promise<unknown>, turns = 80): Promise<'settled' | 'pending'> {
  let state: 'settled' | 'pending' = 'pending';
  /**
   * Read through a function, never as a bare `state` — the same reason
   * `job-runner.ts` reads its stopping flag through `isStoppingNow`. The
   * variable is mutated from a callback, outside this function's control flow,
   * and TypeScript's narrowing would otherwise decide the comparison below is
   * statically false and the loop is dead code.
   */
  const read = (): 'settled' | 'pending' => state;
  const settle = (): void => {
    state = 'settled';
  };
  void promise.then(settle, settle);

  for (let turn = 0; turn < turns; turn += 1) {
    if (read() === 'settled') return 'settled';
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return read();
}

/**
 * A queue whose `claim` is held open by the test, so a signal can be delivered
 * at the exact instant the claim is in flight.
 *
 * That instant is the whole defect. A `claim` that resolves before `stop()` is
 * called, or after the loop has already exited, exercises nothing.
 */
class GatedQueue implements JobQueue {
  readonly succeeded: string[] = [];
  readonly failed: { readonly id: string; readonly error: string }[] = [];
  readonly released: string[] = [];
  /** Resolves as soon as `claim` has been entered and is waiting on the gate. */
  readonly claimEntered: Promise<void>;
  /** Set true when `fail` should reject, i.e. the database has gone away. */
  failThrows = false;
  /** Set true to make `release` reject, i.e. the same blip on the release path. */
  releaseThrows = false;

  private openGate: (() => void) | undefined;
  private readonly gate: Promise<void>;
  private entered: (() => void) | undefined;
  private readonly pending: ClaimedJob[];

  constructor(jobs: readonly ClaimedJob[]) {
    this.pending = [...jobs];
    this.gate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
    this.claimEntered = new Promise<void>((resolve) => {
      this.entered = resolve;
    });
  }

  /** Lets the held claim return. */
  open(): void {
    this.openGate?.();
  }

  enqueue(): Promise<{ id: string; created: boolean }> {
    return Promise.resolve({ id: 'x', created: true });
  }

  async claim(): Promise<ClaimedJob | null> {
    this.entered?.();
    await this.gate;
    return this.pending.shift() ?? null;
  }

  succeed(job: ClaimedJob): Promise<boolean> {
    this.succeeded.push(job.id);
    return Promise.resolve(true);
  }

  fail(job: ClaimedJob, error: string): Promise<FailureOutcome> {
    if (this.failThrows) return Promise.reject(new Error('db down: could not record failure'));
    this.failed.push({ id: job.id, error });
    return Promise.resolve('retry');
  }

  /**
   * Records the release only after yielding a macrotask.
   *
   * A real release is a round trip, and the delay is what makes "did `stop()`
   * WAIT for it" an observable fact rather than a coincidence of how many
   * microtasks happened to be queued.
   */
  async release(job: ClaimedJob): Promise<boolean> {
    if (this.releaseThrows) throw new Error('db down: could not release');
    await new Promise((resolve) => setImmediate(resolve));
    this.released.push(job.id);
    return true;
  }

  reapStuck(): Promise<number> {
    return Promise.resolve(0);
  }

  countByStatus(): Promise<Readonly<Record<JobStatus, number>>> {
    return Promise.resolve({ pending: 0, running: 0, succeeded: 0, failed: 0, dead: 0 });
  }
}

function job(id: string, kind = 'test.job'): ClaimedJob {
  return {
    id,
    kind,
    idempotencyKey: `${kind}:${id}`,
    payload: {},
    attempts: 1,
    maxAttempts: 5,
    runAt: new Date(0),
    createdAt: new Date(0),
    lockedBy: 'worker-1',
    lockedAt: new Date(0),
  };
}

interface Harness {
  readonly runner: JobRunner;
  readonly logger: FakeLogger;
}

function build(
  queue: JobQueue,
  handlers: Readonly<Record<string, JobHandler>>,
  overrides: { readonly shutdownTimeoutMs?: number } = {},
): Harness {
  const clock = new FixedClock();
  const logger = new FakeLogger();
  const runner = createJobRunner({
    queue,
    handlers,
    clock,
    sleeper: new YieldingSleeper(clock),
    logger,
    metrics: new MemoryMetrics({ clock }),
    workerId: 'worker-1',
    idlePollMs: 50,
    ...overrides,
  });
  return { runner, logger };
}

function hasEvent(logger: FakeLogger, event: string): boolean {
  return logger.lines.some((line) => line.obj.event === event);
}

describe('D-301 — a SIGTERM that lands INSIDE the claim', () => {
  it('does not run a job whose claim resolved after stopping was set', async () => {
    // The check used to sit before the CALL and nowhere else. `queue.claim` is
    // a network round trip, so the flag flips while the statement is on the
    // wire and the claim comes back holding a job — which the loop then ran.
    // That job is killed by the drain deadline and reclaimed, so it runs twice
    // for no reason: exactly what §12 step 3 forbids.
    const queue = new GatedQueue([job('job-1')]);
    let handlerRuns = 0;

    const { runner } = build(queue, {
      'test.job': () => {
        handlerRuns += 1;
        return Promise.resolve();
      },
    });

    const loop = runner.start();
    await queue.claimEntered;

    // The signal arrives with the claim still in flight.
    const stopping = runner.stop('SIGTERM');
    queue.open();

    await stopping;
    await loop;

    expect(handlerRuns).toBe(0);
    expect(queue.succeeded).toEqual([]);
  });

  it('hands the late-claimed job straight back to the queue, unrun', async () => {
    // Dropping it would leave the row `running` behind a lease nobody holds,
    // invisible until the 120-second reaper — a two-minute delay on work that
    // was never started. `fail` would be a lie AND would add the backoff on
    // top. So: released, and said so at `warn`.
    const queue = new GatedQueue([job('job-1')]);
    const { runner, logger } = build(queue, { 'test.job': () => Promise.resolve() });

    const loop = runner.start();
    await queue.claimEntered;
    const stopping = runner.stop('SIGTERM');
    queue.open();
    await stopping;
    await loop;

    expect(queue.released).toEqual(['job-1']);
    expect(queue.failed).toEqual([]);
    expect(hasEvent(logger, 'job.released')).toBe(true);
  });

  it('still resolves stop() when the release write itself throws', async () => {
    // The same database blip that caused the deploy can break the release. The
    // row then keeps its lease and the reaper returns it at the lock timeout —
    // slower, never wrong, and never a reason for the shutdown to stall.
    const queue = new GatedQueue([job('job-1')]);
    queue.releaseThrows = true;
    const { runner, logger } = build(queue, { 'test.job': () => Promise.resolve() });

    const loop = runner.start();
    await queue.claimEntered;
    const stopping = runner.stop('SIGTERM');
    queue.open();

    expect(await settlement(stopping)).toBe('settled');
    await loop;
    expect(hasEvent(logger, 'job.completion_write_failed')).toBe(true);
  });

  it('waits for an in-flight claim even when the loop was never started', async () => {
    // `stop()` used to await `current` — the executing JOB — and then the loop
    // promise. In this race neither exists: `current` is undefined because
    // nothing is executing yet, and `runOnce()` used directly has no loop
    // promise at all. `stop()` therefore resolved while a claim was still on
    // the wire, and the caller — `worker-main.ts` — went straight on to close
    // the pools underneath it.
    //
    // Tracking the CLAIM as in-flight is what closes that: `stop()` does not
    // resolve until the late-claimed job has been dealt with.
    const queue = new GatedQueue([job('job-1')]);
    const { runner } = build(queue, { 'test.job': () => Promise.resolve() });

    const poll = runner.runOnce();
    await queue.claimEntered;

    const stopping = runner.stop('SIGTERM');
    queue.open();
    await stopping;

    expect(queue.released).toEqual(['job-1']);
    expect(await poll).toBe(false);
  });

  it('applies the drain deadline to a claim in flight, instead of hanging forever', async () => {
    // THE HANG. `runStop` read `current` alone, and in this race `current` is
    // still `undefined` — nothing is executing, the claim has not returned. So
    // the `withDeadline` branch was skipped entirely and control fell through
    // to an unbounded `await stopped`, on a loop parked on the very claim that
    // had not come back. `stop()` never resolved, `worker.drain_timeout` was
    // never logged, and `worker-main.ts` — which awaits `worker.stop()` inside
    // the signal handler — never reached `container.shutdown()` or `exit(0)`.
    // The process hung until SIGKILL: the outcome the deadline exists to
    // prevent, reached through the deadline's own blind spot.
    const queue = new GatedQueue([job('job-1')]);
    const { runner, logger } = build(queue, { 'test.job': () => Promise.resolve() }, {
      shutdownTimeoutMs: 5,
    });

    const loop = runner.start();
    await queue.claimEntered;

    const stopping = runner.stop('SIGTERM');
    // The claim is NEVER opened before the assertion: the deadline has to fire
    // on its own, which is the whole point.
    expect(await settlement(stopping)).toBe('settled');
    expect(hasEvent(logger, 'worker.drain_timeout')).toBe(true);

    // Leave nothing running.
    queue.open();
    await loop;
  });
});

describe('D-302 — a completion write that throws does not abort the shutdown', () => {
  it('resolves stop() when the failure write throws alongside the handler', async () => {
    // The realistic co-occurrence: the database is unreachable, so the handler
    // throws AND the `queue.fail` that records it throws. `execute` rejected,
    // `withDeadline` propagated, and `runner.stop()` REJECTED — which in
    // `worker.ts` skipped `heartbeat.stop()` entirely, leaving the row
    // `running` until it went stale and paged somebody about a clean deploy.
    const queue = new GatedQueue([job('job-1')]);
    queue.failThrows = true;
    let handlerEntered: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      handlerEntered = resolve;
    });

    const { runner, logger } = build(queue, {
      'test.job': () => {
        handlerEntered?.();
        return Promise.reject(new Error('provider down'));
      },
    });

    const loop = runner.start();
    queue.open();
    await running;

    const stopping = runner.stop('SIGTERM');
    expect(await settlement(stopping)).toBe('settled');
    await loop;

    // Swallowed, but never silently: the row keeps its lease and the reaper
    // returns it, and the log says so.
    expect(hasEvent(logger, 'job.completion_write_failed')).toBe(true);
  });

  it('keeps looping after a completion write fails, rather than dying', async () => {
    // §3.2 — a worker that fell over on a transient write failure would turn a
    // database blip into "jobs stop until somebody notices", which is the exact
    // outcome the loop's own error handling exists to prevent.
    const queue = new GatedQueue([job('job-1'), job('job-2')]);
    queue.failThrows = true;
    const { runner } = build(queue, {
      'test.job': () => Promise.reject(new Error('provider down')),
    });
    queue.open();

    await runner.runOnce();
    await runner.runOnce();

    expect(runner.processed()).toBe(2);
    expect(runner.isStopping()).toBe(false);
  });
});
