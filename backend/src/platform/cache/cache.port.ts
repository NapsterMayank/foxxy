/**
 * platform/cache — the cache and rate-limit counter port.
 *
 * Counters live here and NEVER in process memory. In-memory counters stop
 * working the moment a second instance runs, and they fail silently
 * (00-ARCHITECTURE.md §7).
 */
export interface CachePort {
  get(key: string): Promise<string | null>;
  /** `ttlSeconds` omitted means no expiry. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomic increment. Returns the value after incrementing. */
  incr(key: string): Promise<number>;
  /** Sets a TTL on an existing key. Returns false when the key is absent. */
  expire(key: string, ttlSeconds: number): Promise<boolean>;
  close(): Promise<void>;
}
