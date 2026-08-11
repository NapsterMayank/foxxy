import type { CachePort } from './cache.port';
import type { Clock } from '../clock/index';

/**
 * The readiness probe for the cache — D-230.
 *
 * ===========================================================================
 * WHY READINESS HAS TO COVER THE CACHE AT ALL.
 *
 * `/health/ready` probed the database and nothing else. The cache is where
 * EVERY rate-limit counter lives, and `platform/rate-limit` is deliberately
 * built to survive its loss: when `cache.incr` throws, counting moves into
 * process memory so that one dead container cannot take authentication down
 * with it. That trade is correct, and its own header states the cost plainly —
 * "the fallback is DELIBERATELY WEAKER: per instance, not global, so N
 * instances admit up to N x the limit".
 *
 * What was missing is the other half. A replica in that state stayed in the
 * load balancer's rotation indefinitely, answering login and signup on a
 * counter that resets whenever it restarts. Nothing removed it, because
 * nothing asked. Readiness is what turns "degraded" into "not receiving
 * traffic", and a degradation nobody routes around is a degradation nobody
 * ever notices ended.
 *
 * ===========================================================================
 * IT READS ONE KEY. IT DOES NOT WRITE.
 *
 * A `get` of a key that will never exist proves the round trip — connection,
 * auth, protocol, response — at the cost of one lookup and zero bytes of state.
 * A `set` probe would add a write to a Valkey configured with `allkeys-lru`
 * eviction on every health check from every replica, which is load applied to
 * the store precisely in proportion to how many things are watching it.
 *
 * A `null` answer IS a healthy answer. The key is supposed to be absent.
 */

export type CacheFailure = 'unreachable' | 'timeout';

export interface CacheHealth {
  readonly reachable: boolean;
  readonly latencyMs: number;
  /** A classification, never a vendor message. See `platform/db/health.ts`. */
  readonly failure: CacheFailure | null;
}

export interface CacheProbe {
  check(): Promise<CacheHealth>;
}

/**
 * The probe key.
 *
 * Namespaced and fixed, so it is greppable in a `MONITOR` session and cannot
 * collide with a rate-limit key. Never written, so it is always a miss.
 */
export const CACHE_PROBE_KEY = 'health:probe';

class CacheProbeTimeout extends Error {}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CacheProbeTimeout(`cache probe exceeded ${String(ms)}ms`));
    }, ms);
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export interface CacheProbeOptions {
  readonly cache: CachePort;
  /** §4 — the cache timeout rule's total. A probe must be bounded. */
  readonly timeoutMs: number;
  /** Injected, so latency is measured against the same clock as everything else. */
  readonly clock: Clock;
}

export function createCacheProbe(options: CacheProbeOptions): CacheProbe {
  const { cache, timeoutMs, clock } = options;

  return {
    async check(): Promise<CacheHealth> {
      const startedAt = clock.now().getTime();
      try {
        await withDeadline(cache.get(CACHE_PROBE_KEY), timeoutMs);
        return {
          reachable: true,
          latencyMs: clock.now().getTime() - startedAt,
          failure: null,
        };
      } catch (cause) {
        return {
          reachable: false,
          latencyMs: clock.now().getTime() - startedAt,
          // A classification, for the same reason the database probe returns
          // one: this reaches an unauthenticated response body, and an ioredis
          // error carries the host and port.
          failure: cause instanceof CacheProbeTimeout ? 'timeout' : 'unreachable',
        };
      }
    },
  };
}
