import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../../clock/index';
import { createCircuitBreaker, type CircuitBreaker } from '../../circuit-breaker/index';
import { createConcurrencyLimiter } from '../../concurrency/index';
import {
  DEFAULT_BREAKER_POLICY,
  DEFAULT_CONCURRENCY_LIMITS,
  DEFAULT_TIMEOUT_POLICY,
} from '../../config/timeouts';
import { DependencyError, ValidationError } from '../../errors/index';
import { FakeLogger } from '../../logger/index';
import { createPortGuard, createResilienceRegistry, withTimeout, type PortGuard } from '../index';

/**
 * 04-RESILIENCE-PLAN.md §11, row "Timeout":
 *
 *   "Fake port delays past the timeout; assert `DependencyError`, NOT A HANG."
 *
 * The "not a hang" half is the one that matters and the one a naive test
 * misses: a test that awaits a hanging call and asserts nothing simply times
 * out at the runner level, which looks like a broken test rather than a
 * broken timeout. Every test here asserts a rejection arrives.
 */

let clock: FixedClock;
let logger: FakeLogger;

/** A promise that never settles — a dependency that has stopped answering. */
const hangs = (): Promise<never> =>
  new Promise(() => {
    /* deliberately never settles */
  });

function buildGuard(overrides?: { max?: number; timeoutMs?: number }): PortGuard {
  const breaker: CircuitBreaker = createCircuitBreaker({
    name: 'llm',
    clock,
    logger,
    policy: DEFAULT_BREAKER_POLICY,
  });
  return createPortGuard({
    name: 'llm',
    clock,
    breaker,
    limiter: createConcurrencyLimiter({ name: 'llm', max: overrides?.max ?? 20 }),
    timeout: { ...DEFAULT_TIMEOUT_POLICY.llm, totalMs: overrides?.timeoutMs ?? 20 },
  });
}

beforeEach(() => {
  clock = new FixedClock('2026-03-01T00:00:00.000Z');
  logger = new FakeLogger();
});

describe('withTimeout', () => {
  it('rejects with DependencyError rather than hanging', async () => {
    await expect(withTimeout('llm', 10, hangs)).rejects.toBeInstanceOf(DependencyError);
  });

  it('names the dependency in the log message but not the client message', async () => {
    try {
      await withTimeout('llm', 10, hangs);
      expect.unreachable('expected a timeout');
    } catch (error) {
      const dependencyError = error as DependencyError;
      expect(dependencyError.dependency).toBe('llm');
      expect(dependencyError.message).toContain('timed out after 10ms');
      expect(dependencyError.safeMessage).not.toContain('llm');
    }
  });

  it('returns the value when the call finishes in time', async () => {
    await expect(withTimeout('llm', 1000, () => Promise.resolve('answer'))).resolves.toBe('answer');
  });

  it('aborts the signal so an adapter can actually cancel its work', async () => {
    let aborted = false;
    await withTimeout('llm', 5, (signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return hangs();
    }).catch(() => undefined);
    expect(aborted).toBe(true);
  });

  it('propagates the operation´s own error untouched', async () => {
    const boom = new ValidationError('bad prompt');
    await expect(withTimeout('llm', 1000, () => Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe('the composed guard', () => {
  it('times out a hanging call', async () => {
    await expect(buildGuard().run(hangs)).rejects.toBeInstanceOf(DependencyError);
  });

  it('counts timeouts toward opening the breaker', async () => {
    // The failure mode §5 exists for: a dependency that is SLOW rather than
    // down. Five timeouts must open the circuit, or every subsequent caller
    // keeps paying the full timeout.
    const guard = buildGuard({ timeoutMs: 5 });
    for (let i = 0; i < 5; i += 1) {
      await guard.run(hangs).catch(() => undefined);
    }
    expect(guard.breaker.state()).toBe('open');
  });

  it('rejects without attempting the call once the breaker is open', async () => {
    const guard = buildGuard({ timeoutMs: 5 });
    for (let i = 0; i < 5; i += 1) {
      await guard.run(hangs).catch(() => undefined);
    }
    let attempted = false;
    await guard
      .run(() => {
        attempted = true;
        return Promise.resolve('ok');
      })
      .catch(() => undefined);
    expect(attempted).toBe(false);
  });

  it('rejects immediately past the concurrency limit, and never queues', async () => {
    const guard = buildGuard({ max: 2, timeoutMs: 60_000 });
    void guard.run(hangs).catch(() => undefined);
    void guard.run(hangs).catch(() => undefined);

    let attempted = false;
    await expect(
      guard.run(() => {
        attempted = true;
        return Promise.resolve('ok');
      }),
    ).rejects.toBeInstanceOf(DependencyError);
    expect(attempted).toBe(false);
  });

  it('does NOT open the breaker on concurrency overflow', async () => {
    // Overflow means WE are sending too much; the dependency may be perfectly
    // healthy. Counting it would open the circuit during a traffic spike —
    // a self-inflicted outage on top of a busy minute.
    const guard = buildGuard({ max: 1, timeoutMs: 60_000 });
    void guard.run(hangs).catch(() => undefined);
    for (let i = 0; i < 10; i += 1) {
      await guard.run(() => Promise.resolve('ok')).catch(() => undefined);
    }
    expect(guard.breaker.state()).toBe('closed');
  });

  it('releases the slot when a call finishes', async () => {
    const guard = buildGuard({ max: 1 });
    await guard.run(() => Promise.resolve('one'));
    await expect(guard.run(() => Promise.resolve('two'))).resolves.toBe('two');
  });

  it('releases the slot when a call throws', async () => {
    const guard = buildGuard({ max: 1 });
    await guard.run(() => Promise.reject(new ValidationError())).catch(() => undefined);
    await expect(guard.run(() => Promise.resolve('after'))).resolves.toBe('after');
  });

  it('honours a per-call timeout override', async () => {
    const guard = buildGuard({ timeoutMs: 60_000 });
    await expect(guard.run(hangs, { timeoutMs: 5 })).rejects.toBeInstanceOf(DependencyError);
  });
});

describe('the registry', () => {
  const build = (): ReturnType<typeof createResilienceRegistry> =>
    createResilienceRegistry({
      clock,
      logger,
      timeouts: DEFAULT_TIMEOUT_POLICY,
      concurrency: DEFAULT_CONCURRENCY_LIMITS,
      breaker: DEFAULT_BREAKER_POLICY,
    });

  it('builds a guard for every external port', () => {
    const registry = build();
    for (const port of ['cache', 'http', 'llm', 'embed', 'mail', 'payments'] as const) {
      expect(registry.guard(port).name).toBe(port);
    }
  });

  it('returns the SAME breaker for a port every time', () => {
    // One shared opinion per dependency. A breaker per call site means every
    // caller needs its own five failures before it stops — five times the
    // traffic aimed at something already known to be broken.
    const registry = build();
    expect(registry.guard('llm').breaker).toBe(registry.guard('llm').breaker);
  });

  it('applies the §3.3 concurrency limit to each port', () => {
    const registry = build();
    expect(registry.guard('llm').limiter.max).toBe(20);
    expect(registry.guard('embed').limiter.max).toBe(10);
    expect(registry.guard('mail').limiter.max).toBe(5);
    expect(registry.guard('payments').limiter.max).toBe(5);
  });

  it('reports every breaker for /health/deps', () => {
    const registry = build();
    expect(registry.snapshots().map((snapshot) => snapshot.name)).toEqual([
      'cache',
      'http',
      'llm',
      'embed',
      'mail',
      'payments',
    ]);
    expect(registry.snapshots().every((snapshot) => snapshot.state === 'closed')).toBe(true);
  });

  it('isolates ports from one another', async () => {
    // The whole reason for one breaker PER port rather than one for the
    // process: an LLM outage must not stop us sending email.
    const registry = build();
    const llm = registry.guard('llm');
    for (let i = 0; i < 5; i += 1) {
      await llm.run(() => Promise.reject(new DependencyError('llm'))).catch(() => undefined);
    }
    expect(llm.breaker.state()).toBe('open');
    expect(registry.guard('mail').breaker.state()).toBe('closed');
  });
});
