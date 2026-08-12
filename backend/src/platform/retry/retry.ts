import type { Sleeper } from '../clock/index';
import { InternalError } from '../errors/index';
import {
  DEFAULT_BACKOFF_POLICY,
  jitteredBackoffMs,
  type BackoffPolicy,
} from './backoff';

/**
 * The retry loop — 04-RESILIENCE-PLAN.md §4.
 *
 * Two rules from the plan are enforced MECHANICALLY here rather than left to
 * reviewer discipline:
 *
 *  1. **Never retry a non-idempotent write.** `idempotent: false` with a retry
 *     budget above one attempt is a programming error and throws at the call,
 *     not a comment somebody is meant to read. Retrying a payment is worse
 *     than failing it; the type system cannot say that, so this does.
 *
 *  2. **Backoff is jittered.** There is no un-jittered path through this
 *     function. Synchronised retries are a self-inflicted denial of service.
 *
 * `sleep` is a port, so a test asserts the delay sequence in microseconds
 * rather than waiting for it (§9.5: "No sleep. If a test needs to wait, the
 * code needs an injectable clock").
 */

export interface RetryOptions {
  /** TOTAL attempts, including the first. Must be at least 1. */
  readonly attempts: number;
  /**
   * Whether the operation may be safely repeated. `false` caps `attempts` at
   * 1 and throws if a caller asks for more.
   */
  readonly idempotent: boolean;
  /** Decides whether a thrown value is worth another attempt. */
  readonly isRetryable: (error: unknown) => boolean;
  readonly sleeper: Sleeper;
  readonly policy?: BackoffPolicy;
  /** Injected so a test can assert the exact jittered sequence. */
  readonly random?: () => number;
  /** Observability hook. Called before each wait. */
  readonly onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  if (options.attempts < 1) {
    throw new InternalError({ message: 'retry: attempts must be at least 1' });
  }
  if (!options.idempotent && options.attempts > 1) {
    throw new InternalError({
      message:
        'retry: a non-idempotent operation may not be retried (04-RESILIENCE-PLAN.md §4). ' +
        'Either mark it idempotent or ask for a single attempt.',
    });
  }

  const policy = options.policy ?? DEFAULT_BACKOFF_POLICY;
  let lastError: unknown;

  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const isLast = attempt === options.attempts - 1;
      if (isLast || !options.isRetryable(error)) throw error;

      const delayMs = jitteredBackoffMs(attempt, policy, options.random);
      options.onRetry?.({ attempt, delayMs, error });
      await options.sleeper.sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws. Kept because a `for` loop
  // is not exhaustive to the type checker, and an implicit `undefined` return
  // is exactly the kind of thing that becomes a null-pointer at 2am.
  throw lastError;
}
