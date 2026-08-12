import type { Clock, Sleeper } from '../clock/index';
import {
  createCircuitBreaker,
  type BreakerMetrics,
  type BreakerSnapshot,
} from '../circuit-breaker/index';
import { createConcurrencyLimiter } from '../concurrency/index';
import type { BreakerPolicy, ConcurrencyLimits, TimeoutPolicy } from '../config/index';
import type { Logger } from '../logger/index';
import {
  PLATFORM_METRICS,
  createBreakerMetricsBridge,
  createNoopMetrics,
  createPortFailureBridge,
  type MetricsPort,
} from '../metrics/index';
import { createPortGuard, type PortGuard } from './port-guard';

/**
 * One guard per external port, built once at the composition root.
 *
 * A breaker is only useful if it is SHARED. Building one per call site gives
 * every caller its own private opinion about whether the dependency is up,
 * each needing its own five failures before it stops — which is five times
 * the traffic aimed at something already known to be broken. The registry
 * exists so there is exactly one breaker per dependency in the process.
 *
 * It also gives `/health/deps` (§8) a single place to read state from.
 */

/**
 * The ports carrying a guard today.
 *
 * `llm`, `embed`, `mail` and `payments` have no adapter yet — they are
 * interfaces only. Their guards are built anyway and wired into the interface
 * wrappers (`platform/llm/guarded-llm.ts` and friends), so the adapter that
 * lands later gets the breaker, the limiter and the timeout for free rather
 * than needing somebody to remember.
 */
export const GUARDED_PORTS = ['cache', 'http', 'llm', 'embed', 'mail', 'payments'] as const;

export type GuardedPortName = (typeof GUARDED_PORTS)[number];

export interface ResilienceRegistry {
  guard(port: GuardedPortName): PortGuard;
  /** Every breaker's current state — the body of `/health/deps`. */
  snapshots(): BreakerSnapshot[];
}

export interface ResilienceRegistryOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly timeouts: TimeoutPolicy;
  readonly concurrency: ConcurrencyLimits;
  readonly breaker: BreakerPolicy;
  /**
   * The low-level breaker sink. Still accepted so a test can pass
   * `RecordingBreakerMetrics` and assert transitions directly, with no metrics
   * implementation involved.
   */
  readonly breakerMetrics?: BreakerMetrics;
  /**
   * WHERE EVERY RESILIENCE SIGNAL GOES — 04-RESILIENCE-PLAN.md §5.
   *
   * This is the parameter that makes the second half of §5 true. Supplying it
   * wires SIX emissions at once — it said FIVE and wired five, and D-278 exists
   * because that count went stale once already, so it is maintained here
   * deliberately rather than left to be believed:
   *
   *   breaker transitions      §5  — "emitted as a metric"
   *   breaker rejections       §5  — how much the open breaker cost
   *   concurrency rejections   §3.3 — a degraded feature that looks healthy
   *   port timeouts            §4  — the slow-dependency window before the trip
   *   port retries             §4  — the budget D-237 wired; a dependency that
   *                                  always succeeds on attempt two is failing
   *                                  every time and looks perfect
   *   port call failures       D-331 — the dependency itself said no. The most
   *                                  common outage shape, and until now the only
   *                                  one that incremented NOTHING: an audit read
   *                                  `metrics_events: []` back from a real
   *                                  embeddings outage and a real payments one
   *
   * All six are wired HERE rather than at six call sites, for the same reason
   * the guards are composed here: six ports each remembering to emit is five
   * chances to forget, and the one that forgets is discovered during an
   * incident.
   *
   * Optional, defaulting to the no-op. `createContainer` always supplies it —
   * the optionality exists for the resilience unit tests, which build
   * registries by the dozen and have nothing to say about metric names.
   */
  readonly metrics?: MetricsPort;
  /**
   * How the §4 retry budget waits between attempts — D-237.
   *
   * Optional, defaulting to the real sleeper inside `createPortGuard`. A test
   * that asserts the retry BEHAVIOUR passes a `RecordingSleeper` and reads the
   * jittered sequence back without any wall-clock time passing, which is what
   * §9.5's ban on `sleep` in tests requires there to be a seam for.
   */
  readonly sleeper?: Sleeper;
  /** Injected so a test can assert the exact jittered delay sequence. */
  readonly random?: () => number;
}

export function createResilienceRegistry(
  options: ResilienceRegistryOptions,
): ResilienceRegistry {
  const metrics = options.metrics ?? createNoopMetrics();

  // An explicit `breakerMetrics` wins, so a test can observe transitions
  // directly. Otherwise the bridge turns them into named metrics.
  const breakerMetrics = options.breakerMetrics ?? createBreakerMetricsBridge(metrics);

  const guards = new Map<GuardedPortName, PortGuard>(
    GUARDED_PORTS.map((port) => [
      port,
      createPortGuard({
        name: port,
        clock: options.clock,
        timeout: options.timeouts[port],
        breaker: createCircuitBreaker({
          name: port,
          clock: options.clock,
          logger: options.logger,
          policy: options.breaker,
          metrics: breakerMetrics,
        }),
        limiter: createConcurrencyLimiter({
          name: port,
          max: options.concurrency[port],
          onReject: (name, max) => {
            metrics.counter(PLATFORM_METRICS.CONCURRENCY_REJECTED, 1, {
              port: name,
              max: String(max),
            });
          },
        }),
        onTimeout: (name, timeoutMs) => {
          metrics.counter(PLATFORM_METRICS.PORT_TIMEOUT, 1, {
            port: name,
            timeoutMs: String(timeoutMs),
          });
        },
        /**
         * THE SIXTH EMISSION — D-331. One line, and it is the line that makes a
         * connection-refused visible to an alert rule at all.
         *
         * The bridge, not a `metrics.counter` call, because the classification
         * it performs is the entire point: it declines to emit for timeouts,
         * breaker rejections and concurrency rejections, all three of which
         * `alert-sources.ts` already sums into `dependency.errors`. Inlining a
         * counter here would double-count every one of them and halve the
         * meaning of the paging threshold.
         */
        onFailure: createPortFailureBridge(metrics),
        /**
         * D-237 — the FIFTH emission wired here, for the same reason as the
         * other four: six ports each remembering to emit is five chances to
         * forget. A retry that nobody counts turns "this dependency is failing
         * half the time" into "this dependency is fine, and slow".
         */
        ...(options.sleeper === undefined ? {} : { sleeper: options.sleeper }),
        ...(options.random === undefined ? {} : { random: options.random }),
        onRetry: (name, info) => {
          metrics.counter(PLATFORM_METRICS.PORT_RETRIED, 1, {
            port: name,
            attempt: String(info.attempt),
          });
        },
      }),
    ]),
  );

  return {
    guard(port: GuardedPortName): PortGuard {
      const guard = guards.get(port);
      // The map is built from the same literal union, so this cannot happen —
      // but returning `undefined` from a lookup that callers treat as total is
      // how a port silently ends up unguarded.
      if (guard === undefined) {
        throw new Error(`No resilience guard registered for port "${port}"`);
      }
      return guard;
    },

    snapshots(): BreakerSnapshot[] {
      return [...guards.values()].map((guard) => guard.breaker.snapshot());
    },
  };
}
