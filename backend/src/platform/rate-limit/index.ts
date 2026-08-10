/**
 * platform/rate-limit — fixed-window counters with an in-process fallback.
 *
 * The MECHANISM only. Every policy — which key, which rule, which endpoint —
 * belongs to the module or plugin doing the limiting. `platform/` holds no
 * business rules.
 */
export {
  createRateLimiter,
  InProcessRateLimitCounters,
  DEFAULT_FALLBACK_METRIC,
  type MetricsSink,
  type RateLimiter,
  type RateLimiterDeps,
} from './limiter';
