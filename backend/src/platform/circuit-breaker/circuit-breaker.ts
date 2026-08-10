import type { Clock } from '../clock/index';
import type { BreakerPolicy } from '../config/index';
import { DependencyError, isAppError } from '../errors/index';
import type { Logger } from '../logger/index';

/**
 * platform/circuit-breaker — 04-RESILIENCE-PLAN.md §5.
 *
 * "A timeout protects one request. A circuit breaker protects the system from
 * a dependency that is already known to be failing — it stops sending traffic
 * that will fail anyway."
 *
 * The distinction matters more than it sounds. With timeouts alone, a dead
 * dependency still costs every caller the full timeout: 200 requests a second
 * against a 30-second LLM timeout means 6,000 requests sitting in memory,
 * each holding a socket and a stack, and the process dies of a dependency it
 * could simply have declined to call.
 *
 * Generic on purpose. It wraps ANY port — nothing in here knows what an LLM
 * or a cache is, and there is no business rule (this is `platform/`).
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerTransition {
  readonly name: string;
  readonly from: BreakerState;
  readonly to: BreakerState;
  /** How long the breaker will stay open, when `to` is `open`. */
  readonly openMs: number | undefined;
  readonly at: Date;
  readonly reason: string;
}

/**
 * Where transitions go as metrics. "A breaker that opens without anyone
 * knowing is a silent outage" — so this is a required dependency, not an
 * optional one, and the no-op implementation has to be chosen deliberately.
 */
export interface BreakerMetrics {
  onTransition(transition: BreakerTransition): void;
  /**
   * A call was refused WITHOUT a network attempt, because the breaker was open
   * or its half-open trial budget was spent.
   *
   * Separate from `onTransition`, and it is the more important of the two.
   * A transition count says the breaker flapped; this says how much it cost.
   * A breaker that opens and closes twice with no traffic in between is noise;
   * one that is open for four minutes while refusing three thousand calls is an
   * incident, and the transition count alone cannot tell them apart.
   *
   * OPTIONAL so that the existing fakes and any future implementation stay
   * valid without change — a metrics interface that breaks its implementors
   * every time an event is added is one people stop implementing.
   */
  onRejected?(name: string, state: BreakerState): void;
}

/**
 * The breaker metrics that go nowhere.
 *
 * Still here, still explicit, but no longer the only implementation — which is
 * the point. §5 requires every transition to be "emitted as a metric", and
 * until `platform/metrics` existed this function was where that requirement
 * quietly ended. Choosing it now is a decision a composition root makes on
 * purpose, not the default that happens when nobody wires anything.
 */
export function createNoopBreakerMetrics(): BreakerMetrics {
  return {
    onTransition(): void {
      /* discarded deliberately; transitions are still logged at warn */
    },
    onRejected(): void {
      /* discarded deliberately */
    },
  };
}

/** Records every transition. For tests, and for `/health/deps`. */
export class RecordingBreakerMetrics implements BreakerMetrics {
  readonly transitions: BreakerTransition[] = [];
  readonly rejections: { readonly name: string; readonly state: BreakerState }[] = [];

  onTransition(transition: BreakerTransition): void {
    this.transitions.push(transition);
  }

  onRejected(name: string, state: BreakerState): void {
    this.rejections.push({ name, state });
  }
}

export interface BreakerSnapshot {
  readonly name: string;
  readonly state: BreakerState;
  /** Failures inside the rolling failure window. */
  readonly recentFailures: number;
  /** Outcomes considered by the failure-rate rule. */
  readonly windowSize: number;
  readonly failureRate: number;
  /** When the breaker may next attempt a trial call. Null unless open. */
  readonly retryAt: Date | null;
  readonly openMs: number;
}

export interface CircuitBreakerOptions {
  /** Names the dependency. Appears in the log line, the metric and the error. */
  readonly name: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly policy: BreakerPolicy;
  readonly metrics?: BreakerMetrics;
  /**
   * Overrides which THROWN values count as a dependency failure.
   * The default implements §5 exactly: timeouts, connection errors and 5xx
   * count; 4xx does not.
   */
  readonly isFailure?: (error: unknown) => boolean;
}

export interface ExecuteOptions<T> {
  /**
   * Lets a call classify a RETURNED value as a failure.
   *
   * Needed because an adapter that resolves with `{ status: 503 }` rather than
   * throwing would otherwise look like a success to the breaker, and the
   * breaker would never open on the exact failure it exists for.
   */
  readonly isFailureResult?: (value: T) => boolean;
}

export interface CircuitBreaker {
  readonly name: string;
  execute<T>(operation: () => Promise<T>, options?: ExecuteOptions<T>): Promise<T>;
  state(): BreakerState;
  snapshot(): BreakerSnapshot;
}

/**
 * §5, "Counted as a failure: timeout, connection error, 5xx. Not counted: 4xx.
 * A malformed request is our defect, not the dependency's."
 *
 * Counting our own 400s would open the breaker for every caller because ONE
 * caller sent rubbish — a self-inflicted outage triggered by a bug that was
 * only ever affecting one request.
 */
export function defaultIsFailure(error: unknown): boolean {
  if (isAppError(error)) return error.httpStatus >= 500;
  // AbortError (our timeouts), ECONNREFUSED, DNS failures, and anything else
  // unrecognised. An unrecognised failure from a dependency is a failure.
  return true;
}

interface Outcome {
  readonly at: number;
  readonly failed: boolean;
}

export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  const { name, clock, logger, policy } = options;
  const metrics = options.metrics ?? createNoopBreakerMetrics();
  const isFailure = options.isFailure ?? defaultIsFailure;

  let state: BreakerState = 'closed';
  /** The current open interval. Doubles on a failed trial, capped. */
  let openMs = policy.openMs;
  let openedAt = 0;
  /** Timestamps of failures, pruned to `failureWindowMs`. */
  let failureTimes: number[] = [];
  /** The last `rollingWindowSize` outcomes, for the failure-RATE rule. */
  let recent: Outcome[] = [];
  /** Trial calls started and succeeded while half-open. */
  let halfOpenStarted = 0;
  let halfOpenSucceeded = 0;

  function transition(to: BreakerState, reason: string): void {
    const from = state;
    if (from === to) return;
    state = to;

    const event: BreakerTransition = {
      name,
      from,
      to,
      openMs: to === 'open' ? openMs : undefined,
      at: clock.now(),
      reason,
    };

    // §5: "Every state transition is logged at `warn` and emitted as a
    // metric." Including the recovery to closed — an operator needs to know
    // the incident ENDED as much as that it started.
    logger.warn(
      {
        breaker: name,
        from,
        to,
        reason,
        ...(event.openMs === undefined ? {} : { openMs: event.openMs }),
      },
      'circuit breaker state change',
    );
    metrics.onTransition(event);
  }

  function prune(now: number): void {
    const cutoff = now - policy.failureWindowMs;
    failureTimes = failureTimes.filter((at) => at > cutoff);
    if (recent.length > policy.rollingWindowSize) {
      recent = recent.slice(recent.length - policy.rollingWindowSize);
    }
  }

  function failureRate(): number {
    if (recent.length === 0) return 0;
    return recent.filter((outcome) => outcome.failed).length / recent.length;
  }

  function shouldTrip(): boolean {
    if (failureTimes.length >= policy.failureThreshold) return true;
    // The rate rule only applies over a FULL window. Two failures out of the
    // first three calls after a deploy is not a 66% failure rate worth acting
    // on; it is three calls.
    return recent.length >= policy.rollingWindowSize && failureRate() >= policy.failureRateThreshold;
  }

  function open(reason: string): void {
    openedAt = clock.now().getTime();
    halfOpenStarted = 0;
    halfOpenSucceeded = 0;
    transition('open', reason);
  }

  function close(): void {
    failureTimes = [];
    recent = [];
    halfOpenStarted = 0;
    halfOpenSucceeded = 0;
    openMs = policy.openMs;
    transition('closed', 'trial calls succeeded');
  }

  function recordSuccess(): void {
    const now = clock.now().getTime();
    recent.push({ at: now, failed: false });
    prune(now);

    if (state === 'half-open') {
      halfOpenSucceeded += 1;
      if (halfOpenSucceeded >= policy.halfOpenTrials) close();
    }
  }

  function recordFailure(): void {
    const now = clock.now().getTime();
    failureTimes.push(now);
    recent.push({ at: now, failed: true });
    prune(now);

    if (state === 'half-open') {
      // §5: "Any fails → Open, with the wait doubled up to 5 minutes."
      // The dependency told us it is still broken; asking again as soon as
      // last time is how a breaker becomes a slow retry loop.
      openMs = Math.min(openMs * 2, policy.maxOpenMs);
      open('a trial call failed');
      return;
    }

    if (state === 'closed' && shouldTrip()) {
      open(
        failureTimes.length >= policy.failureThreshold
          ? `${String(failureTimes.length)} failures within ${String(policy.failureWindowMs)}ms`
          : `failure rate ${failureRate().toFixed(2)} over ${String(recent.length)} calls`,
      );
    }
  }

  /** Moves open → half-open once the wait has elapsed. */
  function maybeHalfOpen(): void {
    if (state !== 'open') return;
    if (clock.now().getTime() - openedAt < openMs) return;
    halfOpenStarted = 0;
    halfOpenSucceeded = 0;
    transition('half-open', 'open interval elapsed');
  }

  function reject(): never {
    // §5 — "a breaker that opens without anyone knowing is a silent outage",
    // and the rejections are how loud the outage actually is.
    metrics.onRejected?.(name, state);
    // No network attempt. That is the entire point — the call costs nothing.
    throw new DependencyError(name, {
      message: `Circuit breaker "${name}" is ${state}; call rejected without attempting it`,
      details: { breaker: name, state },
    });
  }

  return {
    name,

    async execute<T>(operation: () => Promise<T>, executeOptions?: ExecuteOptions<T>): Promise<T> {
      maybeHalfOpen();

      if (state === 'open') reject();
      if (state === 'half-open') {
        if (halfOpenStarted >= policy.halfOpenTrials) reject();
        halfOpenStarted += 1;
      }

      let value: T;
      try {
        value = await operation();
      } catch (error) {
        if (isFailure(error)) {
          recordFailure();
        } else {
          // A 4xx is a successful round trip that told us we were wrong.
          // It says nothing about the dependency's health.
          recordSuccess();
        }
        throw error;
      }

      if (executeOptions?.isFailureResult?.(value) === true) {
        recordFailure();
      } else {
        recordSuccess();
      }
      return value;
    },

    state(): BreakerState {
      maybeHalfOpen();
      return state;
    },

    snapshot(): BreakerSnapshot {
      maybeHalfOpen();
      return {
        name,
        state,
        recentFailures: failureTimes.length,
        windowSize: recent.length,
        failureRate: failureRate(),
        retryAt: state === 'open' ? new Date(openedAt + openMs) : null,
        openMs,
      };
    },
  };
}
