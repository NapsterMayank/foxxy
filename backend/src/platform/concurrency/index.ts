/**
 * platform/concurrency — max in-flight calls per external port.
 * 04-RESILIENCE-PLAN.md §3.3. On overflow: reject, never queue.
 */
export { createConcurrencyLimiter } from './limiter';
export type { ConcurrencyLimiter, ConcurrencyLimiterOptions } from './limiter';
