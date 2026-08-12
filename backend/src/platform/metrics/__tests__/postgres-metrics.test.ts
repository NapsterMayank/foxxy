import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../clock/index';
import type { DbHandle } from '../../db/index';
import { FakeLogger } from '../../logger/index';
import { PLATFORM_METRICS } from '../metrics.port';
import type { MetricEvent } from '../metrics.port';
import { createPostgresMetricsSink, isImmediateFlushMetric } from '../postgres-metrics';

/**
 * =============================================================================
 * WHEN A BUFFERED OBSERVATION ACTUALLY REACHES THE TABLE — D-232.
 *
 * WHAT WAS WRONG. The sink flushed on TWO events: 100 observations, or
 * shutdown. Nothing else. So on a low-traffic process — which every process is
 * at 3am, and which the worker is most of the time — observations sat in memory
 * indefinitely.
 *
 * That is not a reporting delay. Take the single event this subsystem exists
 * for: a circuit breaker opens. §5 says plainly that "a breaker that opens
 * without anyone knowing is a silent outage". The transition emits ONE counter.
 * It lands at position 7 of 100 and stays there — because the dependency is now
 * down, so the traffic that would have filled the buffer has stopped. THE
 * FAILURE SUPPRESSES THE OBSERVATIONS THAT WOULD HAVE FLUSHED THE RECORD OF IT.
 * The alert evaluator polls `metrics_events` and sees nothing. If the process
 * is then killed rather than shut down cleanly, the observation is lost
 * outright and the incident has no trace at all.
 *
 * NOTHING HERE SLEEPS. The interval timer is injected (plan §9.5), so "five
 * seconds elapsed" is a function call.
 * =============================================================================
 */

/** Captures the rows a flush would insert. No database, no container. */
class RecordingDb {
  readonly batches: { name: string }[][] = [];
  failNext = false;

  readonly handle: DbHandle;

  constructor() {
    const insert = (): { values: (rows: { name: string }[]) => Promise<void> } => ({
      values: (rows: { name: string }[]): Promise<void> => {
        if (this.failNext) {
          this.failNext = false;
          return Promise.reject(new Error('relation "metrics_events" does not exist'));
        }
        this.batches.push(rows);
        return Promise.resolve();
      },
    });
    // Only `db.insert(...).values(...)` is reached by the sink. The rest of
    // `DbHandle` is described rather than built, because building a real pool
    // here would make this a database test of a buffering policy.
    this.handle = { db: { insert } } as unknown as DbHandle;
  }

  /** Every metric name written so far, across all batches, in order. */
  written(): string[] {
    return this.batches.flat().map((row) => row.name);
  }
}

/** A controllable `setInterval`. Firing it is what "five seconds passed" means. */
class FakeTimer {
  private callback: (() => void) | undefined;
  private requestedMs: number | undefined;
  cleared = 0;
  started = 0;

  readonly setInterval = (callback: () => void, ms: number): { unref?: () => void } => {
    this.callback = callback;
    this.requestedMs = ms;
    this.started += 1;
    return { unref: (): void => undefined };
  };

  readonly clearInterval = (): void => {
    this.callback = undefined;
    this.cleared += 1;
  };

  get armed(): boolean {
    return this.callback !== undefined;
  }

  get intervalMs(): number | undefined {
    return this.requestedMs;
  }

  fire(): void {
    this.callback?.();
  }
}

function build(options: { readonly bufferSize?: number; readonly flushIntervalMs?: number } = {}) {
  const clock = new FixedClock('2026-08-09T09:00:00.000Z');
  const db = new RecordingDb();
  const timer = new FakeTimer();
  const sink = createPostgresMetricsSink({
    db: db.handle,
    clock,
    logger: new FakeLogger(),
    bufferSize: options.bufferSize ?? 100,
    ...(options.flushIntervalMs === undefined ? {} : { flushIntervalMs: options.flushIntervalMs }),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });
  return { sink, db, timer, clock };
}

function event(name: string, at = new Date('2026-08-09T09:00:00.000Z')): MetricEvent {
  return { name, kind: 'counter', value: 1, tags: {}, at };
}

describe('the count trigger still works', () => {
  it('writes one multi-row batch when the buffer fills', async () => {
    // A burst of fire-and-forget inserts is a burst of connection checkouts
    // against a pool that is already under whatever pressure produced the
    // burst. Coalescing is the whole design and must survive the new triggers.
    const { sink, db } = build({ bufferSize: 4 });

    for (let i = 0; i < 4; i += 1) sink.record(event(`app.ordinary.${String(i)}`));
    await sink.flush();

    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(4);
  });
});

/**
 * =============================================================================
 * THE SEVERITY TRIGGER. This is the named test the defect exists for.
 * =============================================================================
 */
describe('a severity-bearing observation is written immediately', () => {
  it('ONE breaker-open reaches the table WITHOUT 99 companions', async () => {
    // The literal statement of the defect. Before D-232 this observation sat in
    // memory until 99 more arrived — from a dependency that had just stopped
    // answering.
    //
    // NO `flush()` CALL. An earlier version of this test ended with
    // `await sink.flush()` and the mutation SURVIVED it: an explicit flush
    // drains the buffer whatever the trigger policy is, so the assertion was
    // measuring `flush` rather than `record`. Only one microtask turn is
    // awaited, which is what `record`'s own un-awaited `void flush()` needs to
    // settle — and nothing else could have written the row.
    const { sink, db } = build({ bufferSize: 100 });

    sink.record(event(PLATFORM_METRICS.BREAKER_TRANSITION));
    await Promise.resolve();

    expect(db.written()).toEqual([PLATFORM_METRICS.BREAKER_TRANSITION]);
    expect(sink.pending()).toBe(0);
  });

  it('does not wait for the interval either', async () => {
    // Even five seconds is too long for the one signal alerting is built on,
    // and a process that is about to be SIGKILLed does not get five seconds.
    const { sink, db, timer } = build();

    sink.record(event(PLATFORM_METRICS.BREAKER_TRANSITION));
    await Promise.resolve();
    await sink.flush();

    expect(db.written()).toContain(PLATFORM_METRICS.BREAKER_TRANSITION);
    expect(timer.armed).toBe(false);
  });

  it.each([
    ['a breaker changing state', PLATFORM_METRICS.BREAKER_TRANSITION],
    ['a job giving up entirely', PLATFORM_METRICS.JOB_DEAD],
    ['a degradation path being taken', PLATFORM_METRICS.DEGRADATION_ACTIVATED],
    ['PII reaching a permanent record', PLATFORM_METRICS.PII_SCRUBBED],
    ['authentication falling back to memory', 'identity.rate_limit.in_process_fallback'],
    ['the global throttle falling back', 'app.authenticated_rate_limit.in_process_fallback'],
    ['a rate-limit counter being evicted', 'rate_limit.counter_evicted'],
  ])('flushes immediately for %s', async (_label, name) => {
    // Every one of these describes a system already in trouble, which is what
    // makes the count trigger useless for them.
    // Again with no `flush()` — see the first test in this block.
    const { sink, db } = build();

    sink.record(event(name));
    await Promise.resolve();

    expect(db.written()).toContain(name);
    expect(isImmediateFlushMetric(name)).toBe(true);
  });

  it('does NOT flush immediately for an ordinary observation', () => {
    // The control. A rule that flushed everything immediately would also pass
    // every test above and would restore the per-observation insert storm the
    // buffer exists to prevent.
    const { sink, db } = build();

    sink.record(event(PLATFORM_METRICS.JOB_COMPLETED));

    expect(db.batches).toEqual([]);
    expect(sink.pending()).toBe(1);
    expect(isImmediateFlushMetric(PLATFORM_METRICS.JOB_COMPLETED)).toBe(false);
  });

  it('carries the ordinary observations buffered alongside it', async () => {
    // The flush drains the whole buffer, so a breaker opening also rescues
    // whatever context was sitting behind it — which is the part of an incident
    // timeline that explains the transition.
    const { sink, db } = build();

    sink.record(event('app.request.count'));
    sink.record(event('app.request.count'));
    sink.record(event(PLATFORM_METRICS.BREAKER_TRANSITION));
    await sink.flush();

    expect(db.written()).toEqual([
      'app.request.count',
      'app.request.count',
      PLATFORM_METRICS.BREAKER_TRANSITION,
    ]);
  });
});

/**
 * =============================================================================
 * THE INTERVAL TRIGGER. It bounds the AGE of an observation, which is the
 * property alerting depends on and the one a count can never provide.
 * =============================================================================
 */
describe('the interval trigger', () => {
  it('writes buffered observations when the interval fires', async () => {
    const { sink, db, timer } = build({ flushIntervalMs: 5_000 });

    sink.record(event('app.quiet.process'));
    expect(db.batches).toEqual([]);

    timer.fire();
    await sink.flush();

    expect(db.written()).toEqual(['app.quiet.process']);
  });

  it('arms only once no matter how many observations arrive', async () => {
    // One timer per sink, not one per observation.
    const { sink, timer } = build();

    for (let i = 0; i < 10; i += 1) sink.record(event('app.ordinary'));

    expect(timer.started).toBe(1);
    await sink.flush();
  });

  it('does not arm at all in a process that records nothing', () => {
    // A permanently-armed timer is a wakeup every five seconds forever, in
    // every process, bought for no observability whatsoever.
    const { timer } = build();

    expect(timer.armed).toBe(false);
    expect(timer.started).toBe(0);
  });

  it('disarms once the buffer has drained', async () => {
    const { sink, timer } = build();

    sink.record(event('app.ordinary'));
    expect(timer.armed).toBe(true);

    await sink.flush();
    timer.fire();

    expect(timer.armed).toBe(false);
  });

  it('uses the configured interval', async () => {
    const { sink, timer } = build({ flushIntervalMs: 250 });

    sink.record(event('app.ordinary'));

    expect(timer.intervalMs).toBe(250);
    await sink.flush();
  });

  it('stops on `stop()`, so nothing can insert after the pools close', async () => {
    // The composition root calls `stop()` before `flush()` and before
    // `pools.close()`. A timer firing after the pools closed would log a write
    // failure on every clean shutdown.
    const { sink, timer } = build();

    sink.record(event('app.ordinary'));
    sink.stop();

    expect(timer.armed).toBe(false);

    sink.record(event('app.ordinary'));
    expect(timer.armed).toBe(false);
    await sink.flush();
  });
});

describe('a failed write is still logged and dropped', () => {
  it('does not retain failed rows, and does not throw', async () => {
    // The caller is a breaker changing state. Retaining rows to retry them
    // grows the buffer without bound during exactly the outage that caused the
    // failure, and propagating would let a broken observability path break the
    // mechanism it observes. The new triggers must not change either property.
    const { sink, db } = build();
    db.failNext = true;

    sink.record(event(PLATFORM_METRICS.BREAKER_TRANSITION));
    await expect(sink.flush()).resolves.toBeUndefined();

    expect(sink.pending()).toBe(0);
    expect(db.batches).toEqual([]);
  });
});
