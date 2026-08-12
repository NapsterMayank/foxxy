import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../../clock/index';
// From `config/timeouts` rather than the config barrel: importing the barrel
// reads the real process environment and exits the process when it is
// incomplete. That eager check is the point of platform/config — it just means
// tests reach for the module underneath it.
import { DEFAULT_BREAKER_POLICY, type BreakerPolicy } from '../../config/timeouts';
import {
  ConflictError,
  DependencyError,
  InternalError,
  ValidationError,
} from '../../errors/index';
import { FakeLogger } from '../../logger/index';
import {
  RecordingBreakerMetrics,
  createCircuitBreaker,
  defaultIsFailure,
  type CircuitBreaker,
} from '../index';

/**
 * 04-RESILIENCE-PLAN.md §11, row "Circuit breaker":
 *
 *   "Drive 5 consecutive failures; assert the next call is rejected WITHOUT A
 *    NETWORK ATTEMPT; advance the injected clock 30 s; assert half-open."
 *
 * Every test below runs on a FixedClock. Nothing sleeps, nothing is timed, and
 * the whole file finishes in single-digit milliseconds — which is the payoff
 * for building the clock port on day one (§11, closing note).
 */

let clock: FixedClock;
let logger: FakeLogger;
let metrics: RecordingBreakerMetrics;

const POLICY: BreakerPolicy = DEFAULT_BREAKER_POLICY;

/** Counts how many times the wrapped operation was actually entered. */
function countingOperation(behaviour: () => Promise<string>): {
  run: () => Promise<string>;
  calls: () => number;
} {
  let calls = 0;
  return {
    run: (): Promise<string> => {
      calls += 1;
      return behaviour();
    },
    calls: (): number => calls,
  };
}

const failing = (): Promise<string> =>
  Promise.reject(new DependencyError('upstream', { message: 'ECONNREFUSED' }));
const succeeding = (): Promise<string> => Promise.resolve('ok');

function build(overrides: Partial<BreakerPolicy> = {}): CircuitBreaker {
  return createCircuitBreaker({
    name: 'upstream',
    clock,
    logger,
    metrics,
    policy: { ...POLICY, ...overrides },
  });
}

async function drive(
  breaker: CircuitBreaker,
  operation: () => Promise<string>,
  times: number,
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await breaker.execute(operation).catch(() => undefined);
  }
}

beforeEach(() => {
  clock = new FixedClock('2026-03-01T00:00:00.000Z');
  logger = new FakeLogger();
  metrics = new RecordingBreakerMetrics();
});

describe('closed → open', () => {
  it('passes calls through while closed', async () => {
    const breaker = build();
    await expect(breaker.execute(succeeding)).resolves.toBe('ok');
    expect(breaker.state()).toBe('closed');
  });

  it('stays closed at 4 failures — the threshold is 5, not "a few"', async () => {
    const breaker = build();
    await drive(breaker, failing, 4);
    expect(breaker.state()).toBe('closed');
  });

  it('opens on the 5th failure inside the 30s window', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    expect(breaker.state()).toBe('open');
  });

  it('does not open when the 5 failures straddle the 30s window', async () => {
    const breaker = build();
    await drive(breaker, failing, 4);
    // The first four age out before the fifth arrives.
    clock.advanceMs(POLICY.failureWindowMs + 1);
    await drive(breaker, failing, 1);
    expect(breaker.state()).toBe('closed');
  });

  it('opens on a 50% failure rate over a full rolling window of 20', async () => {
    // 10 failures and 10 successes, none of them 5-in-a-window: the count rule
    // cannot fire because successes reset nothing, so this is the RATE rule.
    const breaker = build({ failureThreshold: 1000 });
    for (let i = 0; i < 10; i += 1) {
      await breaker.execute(succeeding);
      await breaker.execute(failing).catch(() => undefined);
    }
    expect(breaker.state()).toBe('open');
  });

  it('does not apply the rate rule before the rolling window is full', async () => {
    const breaker = build({ failureThreshold: 1000 });
    // 2 of 3 failed — 66%, but over three calls, which means nothing.
    await breaker.execute(failing).catch(() => undefined);
    await breaker.execute(failing).catch(() => undefined);
    await breaker.execute(succeeding);
    expect(breaker.state()).toBe('closed');
  });
});

describe('open — the required §11 assertion', () => {
  it('rejects the next call WITHOUT A NETWORK ATTEMPT', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);

    // A fresh, counting operation: if the breaker let the call through, this
    // counter moves. That counter is the whole assertion — an open breaker
    // that still calls the dependency has saved nothing.
    const operation = countingOperation(failing);
    await expect(breaker.execute(operation.run)).rejects.toBeInstanceOf(DependencyError);
    expect(operation.calls()).toBe(0);
  });

  it('names the dependency but leaks nothing to the client', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    try {
      await breaker.execute(succeeding);
      expect.unreachable('expected the open breaker to reject');
    } catch (error) {
      const dependencyError = error as DependencyError;
      expect(dependencyError.dependency).toBe('upstream');
      expect(dependencyError.safeMessage).toBe('A required service is unavailable. Please try again.');
      expect(dependencyError.safeMessage).not.toContain('upstream');
    }
  });

  it('stays open just before the 30s interval elapses', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    clock.advanceMs(POLICY.openMs - 1);
    expect(breaker.state()).toBe('open');
  });
});

describe('open → half-open — the required §11 assertion', () => {
  it('becomes half-open once the injected clock advances 30s', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    expect(breaker.state()).toBe('open');

    clock.advanceMs(POLICY.openMs);

    expect(breaker.state()).toBe('half-open');
  });

  it('lets exactly 3 trial calls through and rejects the 4th', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    clock.advanceMs(POLICY.openMs);

    const operation = countingOperation(succeeding);
    await breaker.execute(operation.run);
    await breaker.execute(operation.run);
    expect(operation.calls()).toBe(2);

    // The third closes the breaker, so the fourth is a normal closed-state
    // call rather than a rejection — asserted separately below.
    await breaker.execute(operation.run);
    expect(breaker.state()).toBe('closed');
  });

  it('rejects a 4th concurrent trial while the first three are still running', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    clock.advanceMs(POLICY.openMs);

    // Three trials started and never settled: the breaker has no capacity left.
    const pending = new Promise<string>(() => {
      /* never settles */
    });
    void breaker.execute(() => pending);
    void breaker.execute(() => pending);
    void breaker.execute(() => pending);

    const fourth = countingOperation(succeeding);
    await expect(breaker.execute(fourth.run)).rejects.toBeInstanceOf(DependencyError);
    expect(fourth.calls()).toBe(0);
  });

  it('closes when all 3 trials succeed', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    clock.advanceMs(POLICY.openMs);
    await drive(breaker, succeeding, POLICY.halfOpenTrials);
    expect(breaker.state()).toBe('closed');
  });

  it('re-opens the moment any trial fails', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    clock.advanceMs(POLICY.openMs);
    await breaker.execute(succeeding);
    await breaker.execute(failing).catch(() => undefined);
    expect(breaker.state()).toBe('open');
  });
});

describe('the doubling wait', () => {
  it('doubles the open interval on each failed trial', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    expect(breaker.snapshot().openMs).toBe(30_000);

    clock.advanceMs(30_000);
    await breaker.execute(failing).catch(() => undefined);
    expect(breaker.snapshot().openMs).toBe(60_000);

    clock.advanceMs(60_000);
    await breaker.execute(failing).catch(() => undefined);
    expect(breaker.snapshot().openMs).toBe(120_000);
  });

  it('caps the wait at 5 minutes', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    for (let i = 0; i < 10; i += 1) {
      clock.advanceMs(breaker.snapshot().openMs);
      await breaker.execute(failing).catch(() => undefined);
    }
    expect(breaker.snapshot().openMs).toBe(POLICY.maxOpenMs);
    expect(POLICY.maxOpenMs).toBe(300_000);
  });

  it('resets the wait to 30s after a successful recovery', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    clock.advanceMs(30_000);
    await breaker.execute(failing).catch(() => undefined);
    expect(breaker.snapshot().openMs).toBe(60_000);

    clock.advanceMs(60_000);
    await drive(breaker, succeeding, POLICY.halfOpenTrials);
    expect(breaker.state()).toBe('closed');
    expect(breaker.snapshot().openMs).toBe(30_000);
  });
});

describe('what counts as a failure — §5', () => {
  it.each([
    ['DependencyError (502)', new DependencyError('x')],
    ['InternalError (500)', new InternalError()],
    ['a raw connection error', new Error('ECONNREFUSED')],
    ['a non-Error throw', 'boom'],
  ])('counts %s', (_label, thrown) => {
    expect(defaultIsFailure(thrown)).toBe(true);
  });

  it.each([
    ['ValidationError (400)', new ValidationError()],
    ['ConflictError (409)', new ConflictError()],
  ])('does NOT count %s — a malformed request is our defect', (_label, thrown) => {
    expect(defaultIsFailure(thrown)).toBe(false);
  });

  it('does not open on 5 client errors', async () => {
    const breaker = build();
    for (let i = 0; i < 5; i += 1) {
      await breaker.execute(() => Promise.reject(new ValidationError())).catch(() => undefined);
    }
    expect(breaker.state()).toBe('closed');
  });

  it('opens on 5 failing RESULTS when the caller classifies them', async () => {
    // The http adapter resolves with `{ status: 503 }` rather than throwing.
    // Without result classification the breaker would never see a 5xx at all.
    const breaker = build();
    for (let i = 0; i < 5; i += 1) {
      await breaker.execute(() => Promise.resolve({ status: 503 }), {
        isFailureResult: (value) => value.status >= 500,
      });
    }
    expect(breaker.state()).toBe('open');
  });

  it('does not open on 5 4xx RESULTS', async () => {
    const breaker = build();
    for (let i = 0; i < 5; i += 1) {
      await breaker.execute(() => Promise.resolve({ status: 404 }), {
        isFailureResult: (value) => value.status >= 500,
      });
    }
    expect(breaker.state()).toBe('closed');
  });
});

describe('observability — "a breaker that opens without anyone knowing is a silent outage"', () => {
  it('logs every transition at warn', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);

    const transition = logger.lines.find((line) => line.msg === 'circuit breaker state change');
    expect(transition?.level).toBe('warn');
    expect(transition?.obj).toMatchObject({ breaker: 'upstream', from: 'closed', to: 'open' });
  });

  it('emits a metric for every transition, including the recovery', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    clock.advanceMs(POLICY.openMs);
    await drive(breaker, succeeding, POLICY.halfOpenTrials);

    expect(metrics.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'closed->open',
      'open->half-open',
      'half-open->closed',
    ]);
  });

  it('reports the open interval on the transition into open', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    expect(metrics.transitions[0]?.openMs).toBe(30_000);
  });

  it('stamps the transition with the injected clock', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    expect(metrics.transitions[0]?.at.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('exposes a snapshot for /health/deps', async () => {
    const breaker = build();
    await drive(breaker, failing, 5);
    const snapshot = breaker.snapshot();
    expect(snapshot).toMatchObject({ name: 'upstream', state: 'open', recentFailures: 5 });
    expect(snapshot.retryAt?.toISOString()).toBe('2026-03-01T00:00:30.000Z');
  });

  it('reports no retryAt while closed', () => {
    expect(build().snapshot().retryAt).toBeNull();
  });
});
