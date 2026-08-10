import { describe, expect, it } from 'vitest';
import { DEFAULT_CONCURRENCY_LIMITS } from '../../config/timeouts';
import { DependencyError } from '../../errors/index';
import { createConcurrencyLimiter } from '../index';

/**
 * 04-RESILIENCE-PLAN.md §3.3 — max in-flight per port, reject on overflow.
 *
 * The property under test is NEVER QUEUE. It is easy to write a limiter that
 * looks right and quietly queues, and the difference only shows up when the
 * dependency is slow — at which point the queue is the reason the process
 * dies. So the assertions are about what does NOT happen: the operation is
 * never entered, and the caller is never left waiting.
 */

const hangs = (): Promise<never> =>
  new Promise(() => {
    /* never settles */
  });

describe('createConcurrencyLimiter', () => {
  it('runs a call within the limit', async () => {
    const limiter = createConcurrencyLimiter({ name: 'llm', max: 2 });
    await expect(limiter.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('reports how many are in flight', () => {
    const limiter = createConcurrencyLimiter({ name: 'llm', max: 2 });
    expect(limiter.inFlight()).toBe(0);
    void limiter.run(hangs).catch(() => undefined);
    expect(limiter.inFlight()).toBe(1);
  });

  it('rejects with DependencyError at the limit', async () => {
    const limiter = createConcurrencyLimiter({ name: 'llm', max: 1 });
    void limiter.run(hangs).catch(() => undefined);
    await expect(limiter.run(() => Promise.resolve('ok'))).rejects.toBeInstanceOf(DependencyError);
  });

  it('never enters the operation on overflow — a rejection costs nothing', async () => {
    const limiter = createConcurrencyLimiter({ name: 'llm', max: 1 });
    void limiter.run(hangs).catch(() => undefined);
    let entered = false;
    await limiter
      .run(() => {
        entered = true;
        return Promise.resolve('ok');
      })
      .catch(() => undefined);
    expect(entered).toBe(false);
  });

  it('rejects SYNCHRONOUSLY-fast rather than waiting for a slot', async () => {
    // The observable difference between rejecting and queueing: with a queue
    // this promise would still be pending while the hanging call runs.
    const limiter = createConcurrencyLimiter({ name: 'llm', max: 1 });
    void limiter.run(hangs).catch(() => undefined);

    let settled = false;
    const overflow = limiter.run(() => Promise.resolve('ok')).catch(() => {
      settled = true;
    });
    await overflow;
    expect(settled).toBe(true);
    expect(limiter.inFlight()).toBe(1);
  });

  it('names the port for the log but tells the client nothing', async () => {
    const limiter = createConcurrencyLimiter({ name: 'payments', max: 1 });
    void limiter.run(hangs).catch(() => undefined);
    try {
      await limiter.run(() => Promise.resolve('ok'));
      expect.unreachable('expected an overflow rejection');
    } catch (error) {
      const dependencyError = error as DependencyError;
      expect(dependencyError.dependency).toBe('payments');
      expect(dependencyError.details).toMatchObject({ port: 'payments', max: 1, inFlight: 1 });
      expect(dependencyError.safeMessage).not.toContain('payments');
    }
  });

  it('frees the slot after a success', async () => {
    const limiter = createConcurrencyLimiter({ name: 'llm', max: 1 });
    await limiter.run(() => Promise.resolve('one'));
    expect(limiter.inFlight()).toBe(0);
    await expect(limiter.run(() => Promise.resolve('two'))).resolves.toBe('two');
  });

  it('frees the slot after a failure', async () => {
    const limiter = createConcurrencyLimiter({ name: 'llm', max: 1 });
    await limiter.run(() => Promise.reject(new Error('boom'))).catch(() => undefined);
    expect(limiter.inFlight()).toBe(0);
  });

  it('admits exactly `max` concurrent calls, no more', async () => {
    const limiter = createConcurrencyLimiter({ name: 'llm', max: 3 });
    for (let i = 0; i < 3; i += 1) void limiter.run(hangs).catch(() => undefined);
    expect(limiter.inFlight()).toBe(3);
    await expect(limiter.run(() => Promise.resolve('x'))).rejects.toBeInstanceOf(DependencyError);
  });
});

describe('acquire — for work whose lifetime is not one promise', () => {
  it('holds the slot until released', () => {
    const limiter = createConcurrencyLimiter({ name: 'llm', max: 1 });
    const release = limiter.acquire();
    expect(limiter.inFlight()).toBe(1);
    expect(() => limiter.acquire()).toThrow(DependencyError);
    release();
    expect(limiter.inFlight()).toBe(0);
  });

  it('is idempotent — a stream can be abandoned more than one way', () => {
    // Released twice, the count would drift below zero and the limit would
    // silently stop meaning anything.
    const limiter = createConcurrencyLimiter({ name: 'llm', max: 1 });
    const release = limiter.acquire();
    release();
    release();
    expect(limiter.inFlight()).toBe(0);
  });
});

describe('the configured limits match §3.3', () => {
  it.each([
    ['llm', 20],
    ['embed', 10],
    ['mail', 5],
    ['payments', 5],
  ] as const)('%s is capped at %i', (port, max) => {
    expect(DEFAULT_CONCURRENCY_LIMITS[port]).toBe(max);
  });
});
