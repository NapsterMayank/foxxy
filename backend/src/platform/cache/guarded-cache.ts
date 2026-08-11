import type { PortGuard } from '../resilience/index';
import type { CachePort } from './cache.port';

/**
 * The cache, behind a circuit breaker and a concurrency limit
 * (04-RESILIENCE-PLAN.md §5, which names `cache` explicitly).
 *
 * Why the cache of all things needs a breaker: when Valkey is unreachable,
 * ioredis queues commands and each one waits out its timeout. Rate limiting
 * runs BEFORE the database on every login (§6.4, step 1), so a cache outage
 * adds its full timeout to every single login attempt — and login is the one
 * path §3.1 says must never be starved. With the breaker open, the same
 * outage costs microseconds and the caller degrades immediately.
 *
 * `close()` deliberately bypasses the guard. Shutdown must not be blocked by
 * an open breaker, and a breaker that prevents the process from releasing its
 * connections has inverted its own purpose.
 */
/**
 * ===========================================================================
 * WHICH OF THESE FIVE OPERATIONS MAY BE RETRIED — D-237.
 *
 * `cache`'s §4 rule carries `retries: 1`, and this file is exactly why that
 * budget could not simply be applied to every call the guard wraps. Four of
 * these five commands are safe to repeat; `incr` is not, and it is the most
 * important one in the process.
 *
 * `incr` IS THE RATE LIMITER'S COUNTER. Retrying it after a timeout that the
 * server actually executed counts one login attempt twice, so a caller is
 * locked out having done nothing wrong — and the lockout is attributed to the
 * limiter, not to a retry nobody knew was happening. That is a retry budget
 * silently TIGHTENING authentication limits, discovered as "users report
 * random lockouts". It gets one attempt, forever, and the reason is written
 * next to it rather than in a plan.
 * ===========================================================================
 */
export function createGuardedCache(inner: CachePort, guard: PortGuard): CachePort {
  /** Reads and last-write-wins writes: repeating one changes nothing. */
  const REPEATABLE = { idempotent: true } as const;

  return {
    get(key: string): Promise<string | null> {
      return guard.run(() => inner.get(key), REPEATABLE);
    },
    set(key: string, value: string, ttlSeconds?: number): Promise<void> {
      // Last write wins with the same key and the same value — a repeat is
      // indistinguishable from the first.
      return guard.run(
        () => (ttlSeconds === undefined ? inner.set(key, value) : inner.set(key, value, ttlSeconds)),
        REPEATABLE,
      );
    },
    del(key: string): Promise<void> {
      // Deleting an absent key is a no-op, which is what makes delete the
      // textbook idempotent operation.
      return guard.run(() => inner.del(key), REPEATABLE);
    },
    incr(key: string): Promise<number> {
      // NOT REPEATABLE. See the header. This omission is the decision.
      return guard.run(() => inner.incr(key));
    },
    expire(key: string, ttlSeconds: number): Promise<boolean> {
      // Sets an absolute TTL rather than extending one, so re-applying it
      // yields the same expiry.
      return guard.run(() => inner.expire(key, ttlSeconds), REPEATABLE);
    },
    close(): Promise<void> {
      return inner.close();
    },
  };
}
