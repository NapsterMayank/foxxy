import type { Clock } from '../clock/index';
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
   * wires FOUR emissions at once, and they are four because that is the list
   * §5 and §3.3 and §4 actually name:
   *
   *   breaker transitions      §5  — "emitted as a metric"
   *   breaker rejections       §5  — how much the open breaker cost
   *   concurrency rejections   §3.3 — a degraded feature that looks healthy
   *   port timeouts            §4  — the slow-dependency window before the trip
   *
   * All four are wired HERE rather than at six call sites, for the same reason
   * the guards are composed here: six ports each remembering to emit is five
   * chances to forget, and the one that forgets is discovered during an
   * incident.
   *
   * Optional, defaulting to the no-op. `createContainer` always supplies it —
   * the optionality exists for the resilience unit tests, which build
   * registries by the dozen and have nothing to say about metric names.
   */
  readonly metrics?: MetricsPort;
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
