import type { Clock } from '../clock/index';
import type { CachePort } from './cache.port';

interface Entry {
  value: string;
  /** Epoch ms, or null for no expiry. */
  expiresAt: number | null;
}

/**
 * Test fake: an in-memory Map.
 *
 * Expiry is evaluated against an injected clock, so a test can prove that a
 * rate-limit window closes without sleeping for it.
 *
 * NOT for production use — see the process-memory warning on CachePort.
 */
export class MemoryCache implements CachePort {
  private readonly store = new Map<string, Entry>();

  constructor(private readonly clock: Clock) {}

  private live(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.clock.now().getTime()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.live(key)?.value ?? null);
  }

  set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds === undefined ? null : this.clock.now().getTime() + ttlSeconds * 1000,
    });
    return Promise.resolve();
  }

  del(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  incr(key: string): Promise<number> {
    const entry = this.live(key);
    const next = (entry === undefined ? 0 : Number(entry.value)) + 1;
    this.store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    return Promise.resolve(next);
  }

  expire(key: string, ttlSeconds: number): Promise<boolean> {
    const entry = this.live(key);
    if (entry === undefined) return Promise.resolve(false);
    entry.expiresAt = this.clock.now().getTime() + ttlSeconds * 1000;
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }

  /** Test helper — the number of live keys. */
  get size(): number {
    return [...this.store.keys()].filter((key) => this.live(key) !== undefined).length;
  }
}
