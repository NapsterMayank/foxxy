import { createRealSleeper, type Clock, type Sleeper } from '../clock/index';
import type { CircuitBreaker } from '../circuit-breaker/index';
import type { ConcurrencyLimiter } from '../concurrency/index';
import type { TimeoutRule } from '../config/index';
import { DependencyError } from '../errors/index';
import { retry } from '../retry/index';

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
  /**
   * DECLARES THIS CALL SAFE TO REPEAT — D-237, and the thing that finally makes
   * `TimeoutRule.retries` mean something.
   *
   * ==========================================================================
   * WHY THE BUDGET ALONE WAS NOT ENOUGH TO WIRE.
   *
   * `retries` has been in the §4 table since the plan was written, is parsed,
   * validated, min/maxed, documented as "a non-zero value here is a statement
   * that the call is idempotent" — and was READ BY NOTHING. `payments: 0`
   * reads as a deliberate safety property ("retrying a payment is worse than
   * failing it") and was exactly as inert as `mail: 3`. An unwired safety
   * setting is worse than an absent one, because it is read as a guarantee.
   *
   * It could not simply be applied to every `guard.run`, and that is why it sat
   * unwired rather than being an oversight. The guard wraps a PORT, not an
   * operation, and the port's rule cannot know which operation it is:
   *
   *   `cache` carries `retries: 1`, and `cache.incr` is the rate limiter's
   *   counter. Retrying it DOUBLE-COUNTS A LOGIN ATTEMPT — a retry budget
   *   silently tightening authentication limits.
   *
   *   `mail` carries `retries: 3`, and `mail.send` is not idempotent. Blanket
   *   wiring would send a verification email up to four times, from a fix whose
   *   stated purpose was reliability.
   *
   * So the rule supplies the BUDGET and the call site supplies the PERMISSION,
   * and a retry needs both. Absent (the default) means one attempt, which is
   * exactly today's behaviour — this change cannot retry anything that is not
   * explicitly declared repeatable.
   *
   * `payments: 0` is now load-bearing in the direction it always claimed: even
   * a call site that declares itself idempotent gets one attempt, because the
   * budget is zero. The permission cannot override the policy.
   * ==========================================================================
   */
  readonly idempotent?: boolean;
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
  /**
   * ==========================================================================
   * EVERY REJECTION LEAVING THE GUARD — D-331.
   *
   * `onTimeout` fires when the guard ABANDONS a call, the limiter's `onReject`
   * when the guard REFUSES one, and the breaker's metrics when it TRANSITIONS.
   * All three are things the guard did. Nothing fired when the DEPENDENCY
   * simply said no.
   *
   * That is the most common outage shape there is — connection refused, DNS
   * failure, a provider 500 — and it returns in milliseconds, far inside its
   * timeout, so no timeout counter moves. The breaker records it in its own
   * private counter and emits nothing at all until it transitions at five. An
   * audit drove the real production wiring with a failing embeddings port and a
   * failing payments port and read `metrics_events` back both times: EMPTY.
   * `dependency_error_rate_high` could only ever count timeouts and post-breaker
   * rejections, so the shape it most needed to see was the one shape invisible
   * to it.
   *
   * THIS FIRES FOR EVERY REJECTION, INCLUDING THE THREE THAT ARE ALREADY
   * COUNTED — timeouts, breaker rejections and concurrency rejections. That is
   * deliberate and is the whole reason it is a bare callback: filtering here
   * would put "which failures are already counted" at the call site, six times
   * over, in a module that is not allowed to know what a metric is called.
   * `createPortFailureBridge` in `platform/metrics` owns that decision, makes it
   * STRUCTURALLY (`details.timeoutMs` / `details.breaker` / `details.max`, never
   * message text) and declines to emit for those three, so the four summands of
   * `dependency.errors` stay disjoint. A double-counted error rate is worse than
   * a missing one: it is a number people quietly stop believing.
   *
   * The seam is a `.catch` that RE-THROWS. It observes without owning: the
   * caller sees exactly the rejection it would have seen, and this cannot change
   * a failure into a success or vice versa.
   * ==========================================================================
   */
  readonly onFailure?: (name: string, error: unknown) => void;
  /**
   * How the retry loop waits — D-237. Required by `platform/retry`, which has
   * no un-jittered path: "synchronised retries are a self-inflicted denial of
   * service" (§4).
   *
   * Optional, defaulting to the real one, so the dozens of registries built by
   * the resilience unit tests do not each have to supply a sleeper to assert
   * something unrelated to retrying. A test that asserts the DELAYS injects a
   * `RecordingSleeper` and reads the sequence back in microseconds — §9.5 bans
   * `sleep` in a test, and this is the seam that makes obeying it possible.
   */
  readonly sleeper?: Sleeper;
  /** Injected so a test can assert the exact jittered sequence. */
  readonly random?: () => number;
  /** Observability hook, fired before each backoff wait. */
  readonly onRetry?: (name: string, info: { attempt: number; delayMs: number }) => void;
}

/**
 * WHAT IS WORTH ANOTHER ATTEMPT — D-237.
 *
 * Only a `DependencyError`, and NOT the two the guard itself raises:
 *
 *  - A BREAKER REJECTION means the breaker has already decided the dependency
 *    is down and is refusing calls WITHOUT a network attempt. Retrying it turns
 *    the breaker into a slow retry loop against something known to be broken —
 *    the precise failure `recordFailure`'s "asking again as soon as last time"
 *    comment names, arrived at from the caller's side.
 *  - A CONCURRENCY REJECTION means WE are sending too much. Backing off and
 *    trying again from inside a held slot adds load to an overloaded port.
 *
 * Both are distinguished structurally, by the `details` the guard's own
 * throwers stamp, rather than by matching on message text.
 */
function isWorthRetrying(error: unknown): boolean {
  if (!(error instanceof DependencyError)) return false;
  const details: unknown = error.details;
  if (typeof details !== 'object' || details === null) return true;
  const record = details as Record<string, unknown>;
  // `breaker` is stamped by the breaker's `reject()`; `max` by the limiter's.
  return record.breaker === undefined && record.max === undefined;
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
  const sleeper: Sleeper = options.sleeper ?? createRealSleeper();

  return {
    name,
    breaker,
    limiter,

    run<T>(
      operation: (signal: AbortSignal) => Promise<T>,
      callOptions?: GuardedCallOptions<T>,
    ): Promise<T> {
      const timeoutMs = callOptions?.timeoutMs ?? timeout.totalMs;

      /**
       * THE BUDGET AND THE PERMISSION, D-237. Both, or one attempt.
       *
       * `timeout.retries` is "attempts AFTER the first", so total attempts is
       * `retries + 1`. `platform/retry` throws if asked for more than one
       * attempt on a non-idempotent operation, which is why the flag gates the
       * arithmetic rather than being passed straight through — `idempotent:
       * false` must mean "one attempt", not "an error at every call site that
       * never opted in".
       */
      const attempts = callOptions?.idempotent === true ? timeout.retries + 1 : 1;

      const attempt = (): Promise<T> =>
        breaker.execute(
          () => withTimeout(name, timeoutMs, operation, options.onTimeout),
          callOptions?.isFailureResult === undefined
            ? undefined
            : { isFailureResult: callOptions.isFailureResult },
        );

      /**
       * ONE SLOT FOR THE WHOLE RETRIED OPERATION — the limiter is OUTSIDE the
       * retry loop, and the breaker is INSIDE it.
       *
       * Limiter outside: re-acquiring per attempt would make real in-flight
       * concurrency exceed the configured limit during a retry storm, with the
       * limiter's count reporting the configured number the whole time. That is
       * precisely the class of defect D-262 was — accounting that diverges from
       * reality, with no symptom — and there is no reason to introduce a second
       * instance of it while fixing the first.
       *
       * Breaker inside: each attempt IS a real call to the dependency, and §5
       * counts failed calls. A retry loop hidden from the breaker would let one
       * caller make four failing calls that the breaker scores as one, so the
       * five-failure threshold would need twenty. It also means an OPEN breaker
       * short-circuits the second attempt for free — see `isWorthRetrying`,
       * which declines to retry that rejection at all.
       *
       * The fast path is preserved exactly: with `attempts === 1` — every call
       * site that has not opted in, and every call site at all on a port whose
       * rule says `retries: 0` — this is the same single `attempt()` the guard
       * has always run, with no sleeper, no policy and no loop.
       */
      const guarded =
        attempts === 1
          ? limiter.run(attempt)
          : limiter.run(() =>
              retry(attempt, {
                attempts,
                idempotent: true,
                isRetryable: isWorthRetrying,
                sleeper,
                ...(options.random === undefined ? {} : { random: options.random }),
                onRetry: (info) => {
                  options.onRetry?.(name, { attempt: info.attempt, delayMs: info.delayMs });
                },
              }),
            );

      /**
       * THE ONE SEAM EVERY FAILURE PASSES THROUGH — D-331.
       *
       * Wrapped OUTSIDE the limiter, so it sees all four kinds: the concurrency
       * rejection the limiter raises before `attempt` ever runs, the breaker
       * rejection, the timeout, and the adapter's own rejection. One place, so
       * no failure path can be added later that forgets to report itself.
       *
       * It observes the FINAL rejection of a retried call, not each attempt: a
       * call that fails twice and succeeds on the third is a success, and a
       * dependency error the caller never saw is not a dependency error. The
       * per-attempt story is `onRetry`'s job, and that is already counted.
       *
       * `onFailure` absent leaves the promise untouched rather than adding a
       * no-op `.catch`, preserving the fast path exactly for the dozens of test
       * registries that wire no observers at all.
       */
      const { onFailure } = options;
      if (onFailure === undefined) return guarded;

      return guarded.catch((error: unknown): never => {
        onFailure(name, error);
        // RE-THROWN, always. This hook is an observer; swallowing here would
        // turn every guarded failure into a resolved `undefined`.
        throw error;
      });
    },
  };
}
