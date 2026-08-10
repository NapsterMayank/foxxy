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
export function createGuardedCache(inner: CachePort, guard: PortGuard): CachePort {
  return {
    get(key: string): Promise<string | null> {
      return guard.run(() => inner.get(key));
    },
    set(key: string, value: string, ttlSeconds?: number): Promise<void> {
      return guard.run(() =>
        ttlSeconds === undefined ? inner.set(key, value) : inner.set(key, value, ttlSeconds),
      );
    },
    del(key: string): Promise<void> {
      return guard.run(() => inner.del(key));
    },
    incr(key: string): Promise<number> {
      return guard.run(() => inner.incr(key));
    },
    expire(key: string, ttlSeconds: number): Promise<boolean> {
      return guard.run(() => inner.expire(key, ttlSeconds));
    },
    close(): Promise<void> {
      return inner.close();
    },
  };
}
