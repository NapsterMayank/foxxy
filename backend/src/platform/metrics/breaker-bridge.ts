import type { BreakerMetrics, BreakerTransition } from '../circuit-breaker/index';
import { PLATFORM_METRICS, type MetricsPort } from './metrics.port';

/**
 * Adapts `BreakerMetrics` (what the circuit breaker emits) onto `MetricsPort`
 * (where metrics go).
 *
 * ===========================================================================
 * WHY A BRIDGE RATHER THAN MAKING THE BREAKER DEPEND ON `MetricsPort`.
 *
 * The circuit breaker's header says it plainly: "Generic on purpose. It wraps
 * ANY port — nothing in here knows what an LLM or a cache is". `BreakerMetrics`
 * is a one-method interface describing the ONE thing a breaker has to say, and
 * that narrowness is what keeps `platform/circuit-breaker` testable with a
 * three-line fake (`RecordingBreakerMetrics`) instead of a metrics
 * implementation.
 *
 * If the breaker took a `MetricsPort`, every breaker test would need one, and
 * the decision about what a transition is CALLED — the metric name, the tag
 * names, the dashboard contract — would live inside the breaker rather than
 * here, where the rest of the naming lives.
 *
 * This file is the seam. It is where §5's "emitted as a metric" becomes true,
 * and it is fifteen lines.
 *
 * ===========================================================================
 * TWO METRICS FROM ONE TRANSITION, and the second is the important one.
 *
 * `platform.breaker.transition` counts every state change, tagged with the
 * direction. That is the timeline.
 *
 * `platform.breaker.rejected` counts calls refused WITHOUT a network attempt —
 * the actual user-visible cost. A breaker that opens and closes twice with no
 * traffic in between is noise; a breaker that is open for four minutes while
 * rejecting three thousand calls is an incident. Only the second metric tells
 * them apart, so the transition count alone would be a dashboard that flaps
 * without ever saying how much it hurt.
 */
export function createBreakerMetricsBridge(metrics: MetricsPort): BreakerMetrics {
  return {
    onTransition(transition: BreakerTransition): void {
      metrics.counter(PLATFORM_METRICS.BREAKER_TRANSITION, 1, {
        port: transition.name,
        from: transition.from,
        to: transition.to,
      });

      // The open interval, as a gauge, so "how long is it backing off for" is
      // answerable without parsing a log line. It doubles on each failed trial
      // up to five minutes (§5), and watching it climb is how you tell a
      // dependency that blipped from one that is genuinely gone.
      if (transition.to === 'open' && transition.openMs !== undefined) {
        metrics.gauge(`${PLATFORM_METRICS.BREAKER_TRANSITION}.open_ms`, transition.openMs, {
          port: transition.name,
        });
      }
    },

    /**
     * The cost counter. Tagged with the STATE the breaker was in when it
     * refused, because `open` and `half-open` are different situations: `open`
     * is a dependency being given time to recover, `half-open` is the trial
     * budget already spent and the caller arriving one moment too early.
     */
    onRejected(name: string, state: string): void {
      metrics.counter(PLATFORM_METRICS.BREAKER_REJECTED, 1, { port: name, state });
    },
  };
}
