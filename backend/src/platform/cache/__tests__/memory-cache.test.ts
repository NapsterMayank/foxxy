import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../../clock/index';
import { MemoryCache } from '../memory-cache';

describe('MemoryCache — the cache-port fake', () => {
  let clock: FixedClock;
  let cache: MemoryCache;

  beforeEach(() => {
    clock = new FixedClock();
    cache = new MemoryCache(clock);
  });

  it('returns null for a key that was never set', async () => {
    expect(await cache.get('missing')).toBeNull();
  });

  it('round-trips a value', async () => {
    await cache.set('k', 'v');
    expect(await cache.get('k')).toBe('v');
  });

  it('deletes a value', async () => {
    await cache.set('k', 'v');
    await cache.del('k');
    expect(await cache.get('k')).toBeNull();
  });

  it('deleting an absent key is a no-op', async () => {
    await expect(cache.del('nope')).resolves.toBeUndefined();
  });

  it('expires a value exactly at its TTL boundary', async () => {
    await cache.set('k', 'v', 60);
    clock.advanceSeconds(59);
    expect(await cache.get('k')).toBe('v');
    clock.advanceSeconds(1);
    expect(await cache.get('k')).toBeNull();
  });

  it('keeps a value with no TTL indefinitely', async () => {
    await cache.set('k', 'v');
    clock.advanceDays(365);
    expect(await cache.get('k')).toBe('v');
  });

  it('increments from zero for a new key', async () => {
    expect(await cache.incr('rate:login:1.2.3.4')).toBe(1);
    expect(await cache.incr('rate:login:1.2.3.4')).toBe(2);
  });

  it('preserves the expiry across increments — the window does not slide', async () => {
    await cache.incr('window');
    await cache.expire('window', 900);
    clock.advanceSeconds(600);
    await cache.incr('window');
    clock.advanceSeconds(300);
    expect(await cache.get('window')).toBeNull();
  });

  it('expire returns false for an absent key', async () => {
    expect(await cache.expire('missing', 10)).toBe(false);
  });

  it('expire returns true for a present key', async () => {
    await cache.set('k', 'v');
    expect(await cache.expire('k', 10)).toBe(true);
  });

  it('reports only live keys in size', async () => {
    await cache.set('a', '1', 10);
    await cache.set('b', '2');
    expect(cache.size).toBe(2);
    clock.advanceSeconds(11);
    expect(cache.size).toBe(1);
  });

  it('clears on close', async () => {
    await cache.set('k', 'v');
    await cache.close();
    expect(await cache.get('k')).toBeNull();
  });
});
