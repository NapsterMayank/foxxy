import type { CachePort } from '../cache/index';
import type { Clock } from '../clock/index';
import { RateLimitError } from '../errors/index';
import type { Logger } from '../logger/index';
import type { RateLimitRule } from '../../shared/constants/rate-limits';

/**
 * Fixed-window rate-limit counters — 01-BACKEND-IMPLEMENTATION-PLAN.md §6.9,
 * with the in-process fallback from 04-RESILIENCE-PLAN.md §6.
 *
 * ===========================================================================
 * WHY THIS LIVES IN `platform/` RATHER THAN IN `identity/`.
 *
 * It was written inside the identity module, because identity was the only
 * thing with routes. It is moved here unchanged (D-080) because the GLOBAL
 * authenticated limit — plan §6.9's last row — is registered in `app/plugins`
 * and applies to every module, and `app/` cannot import a module's internals
 * (ESLint `no-restricted-imports`, Foundation 1). The alternative was a second
 * implementation of the same fixed-window arithmetic, in a second place, with
 * its own fallback and its own bugs.
 *
 * `identity.rate-limit.ts` still exists and still owns identity's KEYS and its
 * metric name. What moved is the MECHANISM, which was never identity-specific.
 *
 * ===========================================================================
 * THE SHARED COUNTER IS THE REAL ONE. It lives in `platform/cache` under an
 * EXPIRING KEY, because an in-memory counter stops working the moment a second
 * instance runs and it fails silently: the limit still appears to work in every
 * test and in single-instance staging, then quietly does nothing in production
 * behind a load balancer (00-ARCHITECTURE.md §7).
 *
 * A FIXED window, not a sliding one. A fixed window admits at most 2x the limit
 * across a window boundary; for "5 login attempts per 15 minutes" that is 10 in
 * the worst case, nowhere near enough to brute-force a password. The simplicity
 * is worth more than the precision.
 *
 * ===========================================================================
 * WHY THERE IS A FALLBACK AT ALL — the failure it removes.
 *
 * Before it, `cache.incr` rejecting meant `consume` rejected, which meant LOGIN
 * RETURNED 500. One unreachable cache container disabled authentication for the
 * entire product. The circuit breaker added later made that failure fast; fast
 * failure is still failure.
 *
 * So when the cache is unavailable, counting moves into this process. The
 * fallback is DELIBERATELY WEAKER — per instance, not global, so N instances
 * admit up to N x the limit, and the counters vanish on restart. That is the
 * correct trade and it is worth stating plainly: degraded rate limiting beats no
 * authentication. An attacker who can also take down the cache gains a factor of
 * N on a limit that was never the only defence (Argon2id, the identical-response
 * rules and the common-password list are all still there); a locked-out user
 * base gains nothing.
 *
 * EVERY ACTIVATION IS LOGGED AT `warn` AND COUNTED AS A METRIC. A silent
 * fallback is a silent security downgrade — the whole point is that somebody
 * finds out. See decision-log D-034.
 */

export interface RateLimiter {
  /**
   * Counts one attempt against `key` and throws `RateLimitError` when the rule
   * is exceeded. Call it BEFORE doing the work being limited.
   */
  consume(key: string, rule: RateLimitRule): Promise<void>;
  /** Clears a counter — used after a successful login. */
  reset(key: string): Promise<void>;
}

/**
 * The metric sink. A one-method interface rather than the full `MetricsPort`
 * because a limiter needs to increment a counter and nothing else, and the
 * narrower dependency is what lets the identity module hold this without
 * depending on `platform/metrics`.
 */
export interface MetricsSink {
  increment(metric: string, tags?: Readonly<Record<string, string>>): void;
}

/** The default metric name. Callers with their own namespace override it. */
export const DEFAULT_FALLBACK_METRIC = 'rate_limit.in_process_fallback';

/**
 * How many distinct keys the in-process counter will track.
 *
 * A bound, not a guess at capacity. While the cache is down, every new IP
 * creates an entry, so an unbounded map hands an attacker a memory-exhaustion
 * lever exactly when the system is already degraded. At the cap, expired windows
 * are dropped first and only then the soonest-to-expire live ones — evicting the
 * entry closest to being forgotten anyway.
 */
const MAX_TRACKED_KEYS = 50_000;

interface Window {
  count: number;
  /** Epoch ms. The window is a FIXED one: this never moves once set. */
  expiresAtMs: number;
}

/**
 * The per-instance counters used only while the cache is unavailable.
 *
 * Same fixed-window semantics as the cache path, evaluated against the injected
 * clock so a test can prove a window closes without sleeping for it.
 */
export class InProcessRateLimitCounters {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly clock: Clock) {}

  incr(key: string, windowSeconds: number): number {
    const nowMs = this.clock.now().getTime();
    const existing = this.windows.get(key);

    if (existing === undefined || existing.expiresAtMs <= nowMs) {
      this.evictIfFull(nowMs);
      this.windows.set(key, { count: 1, expiresAtMs: nowMs + windowSeconds * 1000 });
      return 1;
    }

    existing.count += 1;
    return existing.count;
  }

  del(key: string): void {
    this.windows.delete(key);
  }

  /** Live keys. Test seam, and the number an operator would want on a dashboard. */
  size(): number {
    const nowMs = this.clock.now().getTime();
    let live = 0;
    for (const window of this.windows.values()) {
      if (window.expiresAtMs > nowMs) live += 1;
    }
    return live;
  }

  private evictIfFull(nowMs: number): void {
    if (this.windows.size < MAX_TRACKED_KEYS) return;

    for (const [key, window] of this.windows) {
      if (window.expiresAtMs <= nowMs) this.windows.delete(key);
    }
    if (this.windows.size < MAX_TRACKED_KEYS) return;

    // Still full: drop the entry that expires soonest. Never drop the newest —
    // that would let an attacker evict their own counter by making noise.
    let soonestKey: string | undefined;
    let soonestExpiry = Number.POSITIVE_INFINITY;
    for (const [key, window] of this.windows) {
      if (window.expiresAtMs < soonestExpiry) {
        soonestExpiry = window.expiresAtMs;
        soonestKey = key;
      }
    }
    if (soonestKey !== undefined) this.windows.delete(soonestKey);
  }
}

export interface RateLimiterDeps {
  readonly cache: CachePort;
  /** Injected — the fallback's window arithmetic must be testable. */
  readonly clock: Clock;
  readonly logger: Logger;
  /** Optional. Defaults to a no-op. */
  readonly metrics?: MetricsSink;
  /**
   * The metric emitted when the in-process fallback activates.
   *
   * A parameter rather than a constant because the name identifies WHICH
   * limiter degraded, and "authentication fell back" and "the global throttle
   * fell back" are different pages in a runbook.
   */
  readonly fallbackMetric?: string;
}

const NO_METRICS: MetricsSink = { increment: (): void => undefined };

export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  const { cache, logger } = deps;
  const metrics = deps.metrics ?? NO_METRICS;
  const fallbackMetric = deps.fallbackMetric ?? DEFAULT_FALLBACK_METRIC;
  const fallback = new InProcessRateLimitCounters(deps.clock);

  /**
   * Counts in the cache, or throws so the caller can fall back.
   *
   * The TTL is set on the transition from 0 to 1, which is what makes the window
   * FIXED: it starts at the first attempt and every later attempt inside it
   * inherits the same deadline. Calling `expire` every time would push the
   * deadline forward on each attempt and create a lockout that never ends.
   */
  async function countInCache(key: string, rule: RateLimitRule): Promise<number> {
    const count = await cache.incr(key);
    if (count === 1) {
      try {
        await cache.expire(key, rule.windowSeconds);
      } catch (error) {
        // A counter that exists with NO TTL is the never-ending lockout in a
        // different disguise — the key would sit above the limit forever. Remove
        // it if we can, and treat the attempt as a cache failure so the request
        // is counted in process instead.
        try {
          await cache.del(key);
        } catch {
          // Already unreachable; the TTL-less key is the cache's problem now.
        }
        throw error;
      }
    }
    return count;
  }

  function activateFallback(key: string, rule: RateLimitRule, error: unknown): number {
    // WARN, EVERY TIME, not once per outage. A rate limiter running on a
    // per-instance counter is a security posture change, and a change nobody is
    // told about is one nobody reverses.
    logger.warn(
      {
        event: 'rate_limit.fallback_activated',
        metric: fallbackMetric,
        // The message only — never the key (it identifies an account or an IP)
        // and never the error object, which can carry a connection string.
        err: error instanceof Error ? error.message : 'unknown cache failure',
      },
      'cache unavailable: rate limiting fell back to an in-process counter for this instance',
    );
    metrics.increment(fallbackMetric);
    return fallback.incr(key, rule.windowSeconds);
  }

  return {
    async consume(key: string, rule: RateLimitRule): Promise<void> {
      let count: number;
      try {
        count = await countInCache(key, rule);
      } catch (error) {
        count = activateFallback(key, rule, error);
      }

      if (count > rule.limit) {
        throw new RateLimitError(rule.windowSeconds, {
          // Log-side only. The key is already hashed where it needs to be, and
          // the safe message is the fixed "Too many requests." string.
          message: `Rate limit exceeded: ${count} attempts against a limit of ${rule.limit}`,
        });
      }
    },

    /**
     * Clears a counter. Both stores, because a cache that recovered mid-window
     * would otherwise leave a stale in-process count behind — and because a
     * failure to clear must never propagate: this runs immediately AFTER a
     * successful login, and throwing here would turn a healthy authentication
     * into a 500.
     */
    async reset(key: string): Promise<void> {
      fallback.del(key);
      try {
        await cache.del(key);
      } catch (error) {
        logger.warn(
          {
            event: 'rate_limit.reset_failed',
            metric: fallbackMetric,
            err: error instanceof Error ? error.message : 'unknown cache failure',
          },
          'cache unavailable: could not clear a rate-limit counter',
        );
        metrics.increment(fallbackMetric);
      }
    },
  };
}
