import type { Clock } from '../clock/index';
import type { DbHandle } from '../db/index';
import { schema } from '../db/index';
import type { Logger } from '../logger/index';
import type { MetricEvent } from './metrics.port';

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
 */

const { metricsEvents } = schema;

/** How many observations to hold before writing. */
const DEFAULT_BUFFER_SIZE = 100;

export interface PostgresMetricsSinkOptions {
  /** §3.1 — the `worker` pool. Background bookkeeping, never request traffic. */
  readonly db: DbHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly bufferSize?: number;
}

export interface PostgresMetricsSink {
  /** Buffers one observation, flushing when the buffer is full. */
  record(event: MetricEvent): void;
  /** Writes everything buffered. Called on shutdown and by the worker loop. */
  flush(): Promise<void>;
  /** How many observations are waiting. For tests and for `/health/deps`. */
  pending(): number;
}

export function createPostgresMetricsSink(
  options: PostgresMetricsSinkOptions,
): PostgresMetricsSink {
  const { db, logger } = options;
  const bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;

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

  return {
    record(event: MetricEvent): void {
      buffer.push(event);
      if (buffer.length >= bufferSize) {
        // Deliberately not awaited — see the header. The rejection is already
        // handled inside `write`, so there is no unhandled rejection to leak.
        void flush();
      }
    },

    flush,

    pending(): number {
      return buffer.length;
    },
  };
}
