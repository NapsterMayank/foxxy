import Redis from 'ioredis';
import { DependencyError } from '../errors/index';
import type { CachePort } from './cache.port';

export interface ValkeyCacheConfig {
  readonly url: string;
}

/**
 * Valkey adapter. Speaks the Redis protocol, so ioredis is the client.
 * Every failure surfaces as a DependencyError (502) rather than an opaque
 * ioredis error leaking out of the port.
 */
export function createValkeyCache(cfg: ValkeyCacheConfig): CachePort {
  const client = new Redis(cfg.url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
  });

  async function guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (cause) {
      throw new DependencyError('cache', { message: `Valkey ${operation} failed`, cause });
    }
  }

  return {
    get(key: string): Promise<string | null> {
      return guard('GET', () => client.get(key));
    },
    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
      await guard('SET', async () => {
        if (ttlSeconds === undefined) {
          await client.set(key, value);
        } else {
          await client.set(key, value, 'EX', ttlSeconds);
        }
      });
    },
    async del(key: string): Promise<void> {
      await guard('DEL', () => client.del(key));
    },
    incr(key: string): Promise<number> {
      return guard('INCR', () => client.incr(key));
    },
    async expire(key: string, ttlSeconds: number): Promise<boolean> {
      const result = await guard('EXPIRE', () => client.expire(key, ttlSeconds));
      return result === 1;
    },
    async close(): Promise<void> {
      await client.quit();
    },
  };
}
