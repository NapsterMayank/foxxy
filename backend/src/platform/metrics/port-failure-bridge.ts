import { DependencyError } from '../errors/index';
import { PLATFORM_METRICS, type MetricsPort } from './metrics.port';

/**
 * Turns "a guarded call failed" into `platform.port.call_failed` — the counter
 * that makes a FAST dependency failure visible.
 *
 * ===========================================================================
 * THE HOLE THIS FILLS, MEASURED RATHER THAN ASSERTED.
 *
 * `dependency.errors`, the signal both dependency alert rules watch, was the sum
 * of three counters: `platform.port.timeout`, `platform.breaker.rejected` and
 * `platform.concurrency.rejected`. Every one of those is emitted by the GUARD
 * when the guard itself refuses or abandons a call.
 *
 * A call the DEPENDENCY refuses increments none of them. It returns in
 * milliseconds — far inside its timeout — and the breaker records the failure in
 * its own private counter and emits nothing at all until it transitions at five.
 * An audit drove the real production wiring with a failing port and read the
 * table back:
 *
 *     EMBED-DOWN turn:      502 DEPENDENCY_FAILURE
 *     EMBED-DOWN metrics_events: []
 *     PAY-DOWN checkout:    502 DEPENDENCY_FAILURE
 *     PAY-DOWN metrics_events: []
 *
 * Empty. A payments outage that failed four checkouts and recovered left no
 * trace anywhere an alert rule could see, and connection-refused / DNS-failure /
 * provider-500 is the single most common shape an outage takes.
 *
 * ===========================================================================
 * A BRIDGE, FOR THE SAME REASON `createBreakerMetricsBridge` IS ONE.
 *
 * `platform/resilience` wraps ANY port and knows nothing about metric names —
 * its hooks are plain callbacks (`onTimeout`, `onReject`, `onRetry`) precisely
 * so the naming decision lives here, with the rest of the naming. This file is
 * that seam for failures, and the classification below is the whole of it.
 *
 * ===========================================================================
 * IT DECLINES TO EMIT FOR THE THREE THAT ARE ALREADY COUNTED.
 *
 * The alert collector SUMS all four counters into `dependency.errors`. If this
 * one also fired on timeouts and rejections, every timeout would be worth two
 * dependency errors and the paging threshold would mean half what it says. A
 * double-counted error rate is worse than a missing one — it is a number people
 * quietly stop believing, and then stop looking at.
 *
 * The three are recognised STRUCTURALLY, by the `details` their own throwers
 * stamp, never by matching on message text:
 *
 *   `details.breaker`    stamped by the breaker's `reject()`
 *   `details.max`        stamped by the limiter's overflow rejection
 *   `details.timeoutMs`  stamped by `withTimeout`'s deadline
 *
 * This is deliberately the same discrimination `isWorthRetrying` uses in
 * `port-guard.ts`. Message-text matching would break silently the first time
 * somebody improved an error message.
 *
 * ANYTHING ELSE COUNTS — including a plain `Error` from an adapter that never
 * wrapped its failure in a `DependencyError`. Requiring the wrapper would make
 * the counter depend on every adapter author having remembered, and the adapter
 * that forgot is the one whose outage goes unseen.
 */

/** Why a guarded call failed, as far as the metric is concerned. */
export type PortFailureClass = 'timeout' | 'breaker' | 'concurrency' | 'call';

/**
 * Classifies one failure. Exported because it is the entire decision, and a
 * decision that determines whether an outage is visible deserves its own test
 * rather than being reachable only through a metrics fake.
 */
export function classifyPortFailure(error: unknown): PortFailureClass {
  if (!(error instanceof DependencyError)) return 'call';

  const details: unknown = error.details;
  if (typeof details !== 'object' || details === null) return 'call';

  const record = details as Record<string, unknown>;
  if (record.breaker !== undefined) return 'breaker';
  if (record.max !== undefined) return 'concurrency';
  if (record.timeoutMs !== undefined) return 'timeout';
  return 'call';
}

/**
 * The hook `platform/resilience` should call on EVERY failure leaving
 * `PortGuard.run` — including the three this bridge then ignores.
 *
 * Passing all four in and filtering here, rather than filtering at the call
 * site, is the point: the guard stays ignorant of what is already counted, and
 * the "which failures are already counted" decision is one function that a test
 * can drive with all four shapes.
 */
export type PortFailureRecorder = (port: string, error: unknown) => void;

export function createPortFailureBridge(metrics: MetricsPort): PortFailureRecorder {
  return (port: string, error: unknown): void => {
    if (classifyPortFailure(error) !== 'call') return;
    metrics.counter(PLATFORM_METRICS.PORT_CALL_FAILED, 1, { port });
  };
}
