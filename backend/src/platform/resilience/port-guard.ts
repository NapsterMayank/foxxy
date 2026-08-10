import type { Clock } from '../clock/index';
import type { CircuitBreaker } from '../circuit-breaker/index';
import type { ConcurrencyLimiter } from '../concurrency/index';
import type { TimeoutRule } from '../config/index';
import { DependencyError } from '../errors/index';

/**
 * platform/resilience — the three §3-§5 mechanisms, composed once.
 *
 * Every external port is wrapped in the same three things:
 *
 *     concurrency limit  →  circuit breaker  →  timeout  →  the call
 *
 * The ORDER is a decision, not an accident:
 *
 *  - The limiter is OUTSIDE the breaker. An overflow rejection means *we* are
 *    sending too much, not that the dependency is unhealthy. Counting it as a
 *    breaker failure would open the circuit during a traffic spike and turn a
 *    busy minute into a self-inflicted outage.
 *  - The breaker is outside the timeout, so a timeout is what the breaker
 *    counts. That is the failure mode §5 exists for — a dependency that is
 *    slow rather than down is the expensive one.
 *
 * Writing this once is the point. Six ports each assembling their own version
 * of it is six chances to get the order wrong, and five of them will only be
 * discovered during an incident.
 */

export interface GuardedCallOptions<T> {
  /** Overrides the guard's default timeout for one call (e.g. streaming). */
  readonly timeoutMs?: number;
  /** Lets a returned value be classified as a dependency failure. */
  readonly isFailureResult?: (value: T) => boolean;
}

export interface PortGuard {
  readonly name: string;
  readonly breaker: CircuitBreaker;
  readonly limiter: ConcurrencyLimiter;
  /**
   * `signal` is aborted when the timeout fires, so an adapter that can
   * actually cancel its work (fetch, pg) should pass it through. The timeout
   * is enforced regardless — a call that ignores the signal still rejects on
   * time, it just leaves work running in the background.
   */
  run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options?: GuardedCallOptions<T>,
  ): Promise<T>;
}

export interface PortGuardOptions {
  readonly name: string;
  readonly breaker: CircuitBreaker;
  readonly limiter: ConcurrencyLimiter;
  readonly timeout: TimeoutRule;
  readonly clock: Clock;
  /**
   * Called when a call exceeds its deadline — 04-RESILIENCE-PLAN.md §4,
   * "every outbound call has a timeout. A call without one is a defect."
   *
   * A timeout is the failure mode §5 calls the expensive one: a dependency that
   * is SLOW rather than down. It does not open the breaker on its own until it
   * has happened five times, so the window in which timeouts are accumulating
   * and nothing has tripped yet is precisely the window an operator wants to
   * see. Without this counter it is invisible until the breaker opens, by which
   * point the answer to "when did this start" is unavailable.
   *
   * A callback rather than a `MetricsPort`, matching `BreakerMetrics` and the
   * limiter's `onReject`: nothing in `platform/resilience` should have to know
   * what a metric is called.
   */
  readonly onTimeout?: (name: string, timeoutMs: number) => void;
}

/**
 * Races an operation against its deadline.
 *
 * A rejected promise is not a cancelled operation — Node has no way to stop
 * work that has already started. The `AbortSignal` is how an adapter opts in
 * to real cancellation; this function guarantees only that the CALLER stops
 * waiting, which is what protects the caller's own deadline.
 */
export async function withTimeout<T>(
  name: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  onTimeout?: (name: string, timeoutMs: number) => void,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, rejectDeadline) => {
    timer = setTimeout(() => {
      controller.abort();
      onTimeout?.(name, timeoutMs);
      rejectDeadline(
        new DependencyError(name, {
          message: `${name} timed out after ${String(timeoutMs)}ms`,
          details: { port: name, timeoutMs },
        }),
      );
    }, timeoutMs);
    // A pending timer must never be the reason the process refuses to exit.
    timer.unref();
  });

  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createPortGuard(options: PortGuardOptions): PortGuard {
  const { name, breaker, limiter, timeout } = options;

  return {
    name,
    breaker,
    limiter,

    run<T>(
      operation: (signal: AbortSignal) => Promise<T>,
      callOptions?: GuardedCallOptions<T>,
    ): Promise<T> {
      const timeoutMs = callOptions?.timeoutMs ?? timeout.totalMs;
      return limiter.run(() =>
        breaker.execute(
          () => withTimeout(name, timeoutMs, operation, options.onTimeout),
          callOptions?.isFailureResult === undefined
            ? undefined
            : { isFailureResult: callOptions.isFailureResult },
        ),
      );
    },
  };
}
