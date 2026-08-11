import type { Clock } from '../clock/index';
import type { DbHandle } from '../db/index';
import { schema } from '../db/index';
import type { Logger } from '../logger/index';
import { PLATFORM_METRICS, type MetricEvent } from './metrics.port';

/**
 * The durable metrics sink: a buffered writer to `metrics_events`.
 *
 * ===========================================================================
 * BUFFERED, AND THE BUFFER IS THE WHOLE DESIGN.
 *
 * `MetricsPort` returns `void`, so recording an observation must not await a
 * database round trip. It must also not fire an un-awaited insert per
 * observation: a breaker flapping produces a burst, and a burst of
 * fire-and-forget inserts is a burst of connection checkouts against a pool
 * that is already under whatever pressure made the breaker flap. Observability
 * that gets expensive exactly when the system is in trouble is worse than none.
 *
 * So observations accumulate in an array and are written in ONE multi-row
 * insert when the buffer fills or when `flush()` is called.
 *
 * ===========================================================================
 * IT WRITES ON THE `worker` POOL, NOT ON `core`.
 *
 * §3.1's rule is that a pool follows the CALLER's cost profile. Metric writes
 * are background bookkeeping that must never compete with a request, and the
 * `worker` pool is the one reserved for exactly that. This also means a metrics
 * write storm cannot starve login or a chapter listing — which matters most in
 * the scenario where metrics are flowing fastest.
 *
 * ===========================================================================
 * A FAILED WRITE IS LOGGED AND DROPPED. NEVER RETHROWN.
 *
 * The caller is a circuit breaker changing state, or a rate limiter falling
 * back. Neither can do anything useful with "the metrics insert failed", and
 * propagating it would let a broken observability path break the mechanism it
 * observes. Dropping is the only defensible behaviour, and it is logged at
 * `warn` so the gap in the data has an explanation beside it.
 *
 * The buffer is CLEARED before the insert is attempted, not after. Retaining
 * failed rows to retry them means an outage grows the buffer without bound
 * while the database is exactly the thing that is down.
 *
 * ===========================================================================
 * THREE TRIGGERS, NOT ONE — D-232.
 *
 * The buffer used to be written on TWO events: 100 observations, or shutdown.
 * Nothing else. So a low-traffic process — which every process is at 3am, and
 * which the worker is most of the time — accumulated observations in memory
 * indefinitely.
 *
 * That is not merely a reporting delay. Consider the single event this whole
 * subsystem exists for: a circuit breaker opens. §5 is explicit that "a breaker
 * that opens without anyone knowing is a silent outage". The transition emits
 * ONE counter. It lands in the buffer at position 7 of 100 and stays there,
 * because the dependency is now down and the traffic that would have filled the
 * buffer has stopped — the failure SUPPRESSES the very observations that would
 * have flushed the record of it. The alert evaluator polls `metrics_events` and
 * sees nothing. If the process is then killed rather than shut down cleanly,
 * the observation is lost outright and the incident has no trace at all.
 *
 * So:
 *
 *   COUNT      100 observations. The original trigger, for throughput.
 *   INTERVAL   every `flushIntervalMs` (5 s by default) while anything is
 *              buffered. Bounds the AGE of an observation, which is the
 *              property alerting actually depends on.
 *   SEVERITY   immediately, for the observations an alert is written against.
 *              A breaker opening waits for nothing.
 *
 * The interval timer is `unref`'d, so it cannot by itself keep the process
 * alive — a metrics sink must not be the reason a container refuses to exit.
 */

const { metricsEvents } = schema;

/** How many observations to hold before writing. */
const DEFAULT_BUFFER_SIZE = 100;

/**
 * How long an observation may sit unwritten — D-232.
 *
 * Five seconds. Short enough that the alert evaluator's polling interval, not
 * this buffer, is what bounds detection latency; long enough that an ordinary
 * burst still coalesces into one multi-row insert rather than becoming a write
 * per observation. The timer only runs while something is buffered, so an idle
 * process performs no work at all.
 */
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

/**
 * THE OBSERVATIONS THAT DO NOT WAIT — D-232.
 *
 * Every one of these is a signal an operator has an alert rule written
 * against, and every one of them describes a system already in trouble. That
 * second property is what makes the count trigger useless for them: a breaker
 * opens BECAUSE traffic to a dependency is failing, and the traffic that would
 * fill the buffer to 100 is the traffic that just stopped.
 *
 * Deliberately a SET of names rather than a `severity` field on `MetricEvent`.
 * A field would have to be set correctly at every call site, including the ones
 * written next year, and the failure mode of forgetting it is exactly the
 * silence this closes. A name is already an API — dashboards are written
 * against it — so a rename that missed this set would break the dashboard
 * first, loudly.
 *
 * `rate_limit.*` are string literals rather than imports: `platform/metrics`
 * must not depend on `platform/rate-limit` (the dependency runs the other way,
 * and a cycle here would be a boot-order problem in the composition root). The
 * `identity.`/`app.` prefixed variants are the per-caller namespaces those two
 * limiters are constructed with.
 */
const IMMEDIATE_FLUSH_METRICS: ReadonlySet<string> = new Set<string>([
  PLATFORM_METRICS.BREAKER_TRANSITION,
  PLATFORM_METRICS.JOB_DEAD,
  PLATFORM_METRICS.DEGRADATION_ACTIVATED,
  PLATFORM_METRICS.PII_SCRUBBED,
  'rate_limit.in_process_fallback',
  'identity.rate_limit.in_process_fallback',
  'app.authenticated_rate_limit.in_process_fallback',
  'rate_limit.counter_evicted',
]);

/** Whether this observation is written now rather than buffered. See above. */
export function isImmediateFlushMetric(name: string): boolean {
  return IMMEDIATE_FLUSH_METRICS.has(name);
}

export interface PostgresMetricsSinkOptions {
  /** §3.1 — the `worker` pool. Background bookkeeping, never request traffic. */
  readonly db: DbHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly bufferSize?: number;
  /**
   * How long an observation may sit unwritten (D-232). Defaults to 5 s.
   *
   * Injectable so a test can assert the interval fires without waiting for it,
   * and so a deployment that wants tighter alerting latency can pay for it.
   */
  readonly flushIntervalMs?: number;
  /**
   * The timer seam. Defaults to `setInterval`.
   *
   * Injected rather than reached for directly because plan §9.5 bans `sleep` in
   * a test, and a sink that called `setInterval` itself could only be tested by
   * waiting five real seconds — which is how an interval flush ends up with no
   * test at all.
   */
  readonly setInterval?: (callback: () => void, ms: number) => { unref?: () => void };
  readonly clearInterval?: (handle: { unref?: () => void }) => void;
}

export interface PostgresMetricsSink {
  /**
   * Buffers one observation.
   *
   * Writes IMMEDIATELY when the buffer is full, or when the observation is one
   * an alert is written against (D-232). Otherwise the interval timer bounds
   * how long it can sit.
   */
  record(event: MetricEvent): void;
  /** Writes everything buffered. Called on shutdown and by the worker loop. */
  flush(): Promise<void>;
  /** How many observations are waiting. For tests and for `/health/deps`. */
  pending(): number;
  /**
   * Stops the interval timer. Idempotent.
   *
   * Does NOT flush — `shutdown()` in the composition root already awaits
   * `flush()` before closing the pools, and folding the two together would
   * make the ordering implicit in a method name instead of visible at the call
   * site where it is load-bearing.
   */
  stop(): void;
}

/** What the injected timer returns. Structural, so `NodeJS.Timeout` satisfies it. */
interface IntervalHandle {
  unref?: () => void;
}

export function createPostgresMetricsSink(
  options: PostgresMetricsSinkOptions,
): PostgresMetricsSink {
  const { db, logger } = options;
  const bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const startTimer =
    options.setInterval ??
    ((callback: () => void, ms: number): IntervalHandle => setInterval(callback, ms));
  const stopTimer =
    options.clearInterval ??
    ((handle: IntervalHandle): void => {
      clearInterval(handle as NodeJS.Timeout);
    });

  let buffer: MetricEvent[] = [];
  /**
   * The in-flight write, so two concurrent flushes do not interleave.
   *
   * Not a lock: a second `flush()` while one is running returns the SAME
   * promise, having already handed its own rows to the running batch by virtue
   * of the buffer being drained first. Shutdown awaits it and gets a real
   * answer.
   */
  let writing: Promise<void> | undefined;

  async function write(rows: MetricEvent[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      await db.db.insert(metricsEvents).values(
        rows.map((event) => ({
          name: event.name,
          kind: event.kind,
          value: event.value,
          // Already scrubbed by the adapter that produced the event; the column
          // comment says identifiers-and-counts and this is the last chance to
          // notice, but re-scrubbing here would hide a defect in the adapter
          // rather than surface it.
          tags: event.tags,
          recordedAt: event.at,
        })),
      );
    } catch (error) {
      logger.warn(
        {
          event: 'metrics.write_failed',
          dropped: rows.length,
          err: error instanceof Error ? error.message : 'unknown metrics write failure',
        },
        'metrics could not be persisted; observations dropped',
      );
    }
  }

  function flush(): Promise<void> {
    // Drained BEFORE the write is attempted. Keeping failed rows to retry them
    // grows the buffer without bound during exactly the outage that caused the
    // failure.
    const rows = buffer;
    buffer = [];
    const pendingWrite = (writing ?? Promise.resolve()).then(() => write(rows));
    writing = pendingWrite.finally(() => {
      if (writing === pendingWrite) writing = undefined;
    });
    return writing;
  }

  /**
   * The interval flush — D-232. Started lazily, stopped when the buffer empties.
   *
   * Lazy because a process that records nothing should schedule nothing, and
   * stopped-when-empty because a permanently-armed timer that always finds an
   * empty buffer is a wakeup every five seconds forever in every process,
   * bought for no observability at all.
   */
  let timer: IntervalHandle | undefined;
  let stopped = false;

  function disarm(): void {
    if (timer === undefined) return;
    stopTimer(timer);
    timer = undefined;
  }

  function arm(): void {
    if (timer !== undefined || stopped) return;
    timer = startTimer(() => {
      if (buffer.length === 0) {
        disarm();
        return;
      }
      // Not awaited: `write` handles its own rejection, so there is nothing to
      // leak, and a timer callback cannot await anyway.
      void flush();
    }, flushIntervalMs);
    // A metrics sink must never be the reason a container refuses to exit.
    timer.unref?.();
  }

  return {
    record(event: MetricEvent): void {
      buffer.push(event);

      /**
       * SEVERITY FIRST — D-232.
       *
       * A breaker opening, a job dying, a rate limiter falling back to memory:
       * each is one observation describing a system already in trouble, and
       * each would otherwise wait for 99 companions that the trouble itself has
       * stopped producing. Checked before the count so a single one of these in
       * an otherwise silent process still reaches the table.
       */
      if (buffer.length >= bufferSize || isImmediateFlushMetric(event.name)) {
        // Deliberately not awaited — see the header. The rejection is already
        // handled inside `write`, so there is no unhandled rejection to leak.
        void flush();
        return;
      }

      arm();
    },

    flush,

    pending(): number {
      return buffer.length;
    },

    stop(): void {
      stopped = true;
      disarm();
    },
  };
}
