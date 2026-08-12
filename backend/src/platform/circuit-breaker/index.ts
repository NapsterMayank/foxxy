/**
 * platform/circuit-breaker — 04-RESILIENCE-PLAN.md §5.
 *
 * Generic. Wraps any port. Knows nothing about what it is protecting.
 */
export {
  createCircuitBreaker,
  createNoopBreakerMetrics,
  defaultIsFailure,
  RecordingBreakerMetrics,
} from './circuit-breaker';
export type {
  BreakerMetrics,
  BreakerSnapshot,
  BreakerState,
  BreakerTransition,
  CircuitBreaker,
  CircuitBreakerOptions,
  ExecuteOptions,
} from './circuit-breaker';
