/**
 * platform/retry — exponential backoff with jitter, and the rule that a
 * non-idempotent write is never retried. 04-RESILIENCE-PLAN.md §4.
 */
export {
  DEFAULT_BACKOFF_POLICY,
  backoffMs,
  jitterLowerBoundMs,
  jitteredBackoffMs,
} from './backoff';
export type { BackoffPolicy } from './backoff';
export { retry } from './retry';
export type { RetryOptions } from './retry';
