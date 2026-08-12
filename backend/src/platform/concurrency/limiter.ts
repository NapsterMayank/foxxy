import { DependencyError } from '../errors/index';

/**
 * platform/concurrency — 04-RESILIENCE-PLAN.md §3.3.
 *
 * A hard cap on how many calls to one dependency may be in flight at once.
 * Beyond the cap the call is REJECTED IMMEDIATELY. It is never queued.
 *
 * That is the whole design, and it is worth being blunt about why, because
 * "queue it, it'll drain" is the instinct:
 *
 *   Unbounded queueing converts a slow dependency into a dead process. Each
 *   queued caller is still holding a request, a socket, a parsed body and a
 *   stack. When the LLM API goes from 2s to 40s, an unbounded queue turns a
 *   degraded feature into an out-of-memory kill that takes login, practice and
 *   billing down with it — none of which needed the LLM at all.
 *
 * A fast rejection is a better outcome than an infinite wait. The caller sees
 * `DependencyError` and degrades: retrieval falls back to keyword-only, Foxy
 * says "briefly unavailable", the mailer defers to the worker.
 *
 * There is no timer here and no clock: a limiter that never waits never needs
 * to know the time.
 */

export interface ConcurrencyLimiter {
  readonly name: string;
  readonly max: number;
  /** Calls in flight right now. */
  inFlight(): number;
  /** @throws DependencyError when the limit is already reached. */
  run<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Takes a slot and returns the function that gives it back. For work whose
   * lifetime is not one promise — a streamed LLM response holds a slot from
   * the first token to the last, and `run` cannot express that.
   *
   * The release function is idempotent, because a stream can be abandoned in
   * more than one way (return, throw, the client disconnecting) and a slot
   * released twice would let the limit drift upward until it meant nothing.
   *
   * @throws DependencyError when the limit is already reached.
   */
  acquire(): () => void;
}

export interface ConcurrencyLimiterOptions {
  readonly name: string;
  readonly max: number;
  /**
   * Called every time a call is refused for being over the limit.
   *
   * 04-RESILIENCE-PLAN.md §3.3 makes rejection the CORRECT behaviour, which is
   * exactly why it needs a metric: a fast rejection looks like health from
   * inside the process — no error, no timeout, no slow query — and looks like a
   * broken feature from outside it. Without this counter, "retrieval kept
   * falling back to keyword-only for an hour" is invisible.
   *
   * A callback rather than a `MetricsPort` dependency, for the same reason the
   * breaker takes `BreakerMetrics`: this file knows nothing about metric names,
   * and a limiter that needed a metrics implementation would need one in every
   * test too.
   */
  readonly onReject?: (name: string, max: number) => void;
}

export function createConcurrencyLimiter(options: ConcurrencyLimiterOptions): ConcurrencyLimiter {
  const { name, max } = options;
  let active = 0;

  function acquire(): () => void {
    if (active >= max) {
      options.onReject?.(name, max);
      throw new DependencyError(name, {
        message: `Concurrency limit reached for "${name}" (${String(max)} in flight); rejected rather than queued`,
        details: { port: name, max, inFlight: active },
      });
    }
    active += 1;
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      active -= 1;
    };
  }

  return {
    name,
    max,

    inFlight(): number {
      return active;
    },

    acquire,

    async run<T>(operation: () => Promise<T>): Promise<T> {
      const release = acquire();
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
}
