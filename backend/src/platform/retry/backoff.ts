/**
 * Exponential backoff WITH JITTER — 04-RESILIENCE-PLAN.md §4.
 *
 * "Retries use exponential backoff with jitter. Synchronised retries are a
 * self-inflicted denial of service."
 *
 * That sentence is the whole reason this file exists rather than a `2 ** n`
 * expression at a call site. When a dependency has a two-second blip, every
 * caller that failed at the same instant retries at the same instant — the
 * dependency comes back up into a thundering herd and falls over again, and
 * the outage that should have lasted two seconds lasts until someone
 * intervenes. Jitter spreads the retries out.
 *
 * The strategy is EQUAL JITTER: half the exponential delay, plus a random
 * amount up to the other half. So the wait is always in `[base/2, base]`,
 * which keeps the sequence bounded and predictable enough to assert on while
 * still de-synchronising callers. Full jitter (`[0, base]`) de-synchronises
 * slightly better but allows a near-zero wait after a failure, which is the
 * opposite of what backoff is for.
 */

export interface BackoffPolicy {
  /** The first delay. Each subsequent attempt doubles it. */
  readonly baseMs: number;
  /** Ceiling. Doubling stops here. */
  readonly maxMs: number;
  /**
   * How much of the delay is randomised, 0..1.
   * `0.5` gives equal jitter; `0` disables jitter entirely (tests only).
   */
  readonly jitterRatio: number;
}

export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = {
  baseMs: 100,
  maxMs: 2_000,
  jitterRatio: 0.5,
};

/**
 * The deterministic part of the delay: 100ms, 200ms, 400ms, 800ms, … capped.
 * `attempt` is zero-based — attempt 0 is the wait after the first failure.
 */
export function backoffMs(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF_POLICY): number {
  if (attempt < 0) return policy.baseMs;
  return Math.min(policy.baseMs * 2 ** attempt, policy.maxMs);
}

/** The lower bound of the jittered delay for an attempt. */
export function jitterLowerBoundMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF_POLICY,
): number {
  return Math.round(backoffMs(attempt, policy) * (1 - policy.jitterRatio));
}

/**
 * The delay actually waited. `random` is injected — a test passes a fixed
 * value and asserts the exact sequence, rather than asserting on `Math.random`
 * and hoping.
 *
 * @param random returns a value in [0, 1). Defaults to `Math.random`.
 */
export function jitteredBackoffMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF_POLICY,
  random: () => number = Math.random,
): number {
  const full = backoffMs(attempt, policy);
  const floor = full * (1 - policy.jitterRatio);
  return Math.round(floor + random() * (full - floor));
}
