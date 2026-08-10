import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock, RecordingSleeper } from '../../clock/index';
import { DependencyError, InternalError, ValidationError } from '../../errors/index';
import {
  DEFAULT_BACKOFF_POLICY,
  backoffMs,
  jitterLowerBoundMs,
  jitteredBackoffMs,
  retry,
} from '../index';

/**
 * 04-RESILIENCE-PLAN.md §11, row "Retry backoff":
 *
 *   "Assert the delay sequence and jitter bounds using the injected clock."
 *
 * Both halves are here. Nothing sleeps: `RecordingSleeper` records the
 * requested delay and advances the FixedClock by it, so the assertions are on
 * what the code ASKED to wait, and the whole file runs instantly (§9.5: "No
 * sleep. If a test needs to wait, the code needs an injectable clock").
 */

let clock: FixedClock;
let sleeper: RecordingSleeper;

beforeEach(() => {
  clock = new FixedClock('2026-03-01T00:00:00.000Z');
  sleeper = new RecordingSleeper(clock);
});

describe('backoffMs — the deterministic curve', () => {
  it('doubles from 100ms', () => {
    expect([0, 1, 2, 3].map((n) => backoffMs(n))).toEqual([100, 200, 400, 800]);
  });

  it('caps at 2s rather than growing forever', () => {
    expect(backoffMs(5)).toBe(2000);
    expect(backoffMs(50)).toBe(2000);
  });

  it('treats a negative attempt as the first', () => {
    expect(backoffMs(-1)).toBe(DEFAULT_BACKOFF_POLICY.baseMs);
  });
});

describe('jitteredBackoffMs — the bounds', () => {
  it('never returns less than half the exponential delay', () => {
    // random() = 0 is the floor of the range.
    expect([0, 1, 2, 3].map((n) => jitteredBackoffMs(n, DEFAULT_BACKOFF_POLICY, () => 0))).toEqual([
      50, 100, 200, 400,
    ]);
  });

  it('never returns more than the exponential delay', () => {
    // random() approaching 1 is the ceiling.
    expect(
      [0, 1, 2, 3].map((n) => jitteredBackoffMs(n, DEFAULT_BACKOFF_POLICY, () => 0.999999)),
    ).toEqual([100, 200, 400, 800]);
  });

  it('stays inside [floor, full] for every attempt across the whole random range', () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999999]) {
        const delay = jitteredBackoffMs(attempt, DEFAULT_BACKOFF_POLICY, () => r);
        expect(delay).toBeGreaterThanOrEqual(jitterLowerBoundMs(attempt));
        expect(delay).toBeLessThanOrEqual(backoffMs(attempt));
      }
    }
  });

  it('actually varies — this is the whole point of jitter', () => {
    // Two callers that failed at the same instant must not wake together.
    const a = jitteredBackoffMs(2, DEFAULT_BACKOFF_POLICY, () => 0.1);
    const b = jitteredBackoffMs(2, DEFAULT_BACKOFF_POLICY, () => 0.9);
    expect(a).not.toBe(b);
  });

  it('collapses to the exact exponential delay when jitter is disabled', () => {
    const noJitter = { ...DEFAULT_BACKOFF_POLICY, jitterRatio: 0 };
    expect(jitteredBackoffMs(1, noJitter, () => 0.3)).toBe(200);
  });
});

describe('retry — the delay SEQUENCE', () => {
  const alwaysFails = (): Promise<never> => Promise.reject(new DependencyError('upstream'));

  it('waits the jittered exponential sequence between attempts', async () => {
    await retry(alwaysFails, {
      attempts: 4,
      idempotent: true,
      isRetryable: () => true,
      sleeper,
      random: () => 0,
    }).catch(() => undefined);

    // Three waits for four attempts, each the floor of its band.
    expect(sleeper.delays).toEqual([50, 100, 200]);
  });

  it('advances the injected clock by exactly the delays it waited', async () => {
    await retry(alwaysFails, {
      attempts: 3,
      idempotent: true,
      isRetryable: () => true,
      sleeper,
      random: () => 0,
    }).catch(() => undefined);

    expect(clock.now().toISOString()).toBe('2026-03-01T00:00:00.150Z');
  });

  it('does not wait after the final attempt', async () => {
    await retry(alwaysFails, {
      attempts: 1,
      idempotent: true,
      isRetryable: () => true,
      sleeper,
    }).catch(() => undefined);
    expect(sleeper.delays).toEqual([]);
  });

  it('returns as soon as an attempt succeeds', async () => {
    let calls = 0;
    const result = await retry(
      () => {
        calls += 1;
        return calls < 3 ? Promise.reject(new DependencyError('x')) : Promise.resolve('ok');
      },
      { attempts: 5, idempotent: true, isRetryable: () => true, sleeper, random: () => 0 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleeper.delays).toEqual([50, 100]);
  });

  it('passes the zero-based attempt number to the operation', async () => {
    const seen: number[] = [];
    await retry(
      (attempt) => {
        seen.push(attempt);
        return Promise.reject(new DependencyError('x'));
      },
      { attempts: 3, idempotent: true, isRetryable: () => true, sleeper },
    ).catch(() => undefined);
    expect(seen).toEqual([0, 1, 2]);
  });

  it('rethrows the last error rather than inventing one', async () => {
    const boom = new DependencyError('upstream', { message: 'the real cause' });
    await expect(
      retry(() => Promise.reject(boom), {
        attempts: 2,
        idempotent: true,
        isRetryable: () => true,
        sleeper,
      }),
    ).rejects.toBe(boom);
  });

  it('stops immediately on an error it judges not retryable', async () => {
    let calls = 0;
    await expect(
      retry(
        () => {
          calls += 1;
          return Promise.reject(new ValidationError());
        },
        {
          attempts: 5,
          idempotent: true,
          isRetryable: (error) => error instanceof DependencyError,
          sleeper,
        },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toBe(1);
    expect(sleeper.delays).toEqual([]);
  });

  it('reports each retry through onRetry', async () => {
    const seen: { attempt: number; delayMs: number }[] = [];
    await retry(alwaysFails, {
      attempts: 3,
      idempotent: true,
      isRetryable: () => true,
      sleeper,
      random: () => 0,
      onRetry: ({ attempt, delayMs }) => seen.push({ attempt, delayMs }),
    }).catch(() => undefined);
    expect(seen).toEqual([
      { attempt: 0, delayMs: 50 },
      { attempt: 1, delayMs: 100 },
    ]);
  });
});

describe('retry — never retry a non-idempotent write (§4)', () => {
  it('refuses a retry budget on a non-idempotent operation', async () => {
    let calls = 0;
    await expect(
      retry(
        () => {
          calls += 1;
          return Promise.resolve('charged');
        },
        { attempts: 3, idempotent: false, isRetryable: () => true, sleeper },
      ),
    ).rejects.toBeInstanceOf(InternalError);

    // And it refuses BEFORE running anything. A payment must not be attempted
    // once and then discovered to be misconfigured.
    expect(calls).toBe(0);
  });

  it('allows a single attempt on a non-idempotent operation', async () => {
    await expect(
      retry(() => Promise.resolve('charged'), {
        attempts: 1,
        idempotent: false,
        isRetryable: () => true,
        sleeper,
      }),
    ).resolves.toBe('charged');
  });

  it('never retries a non-idempotent failure', async () => {
    let calls = 0;
    await expect(
      retry(
        () => {
          calls += 1;
          return Promise.reject(new DependencyError('payments'));
        },
        { attempts: 1, idempotent: false, isRetryable: () => true, sleeper },
      ),
    ).rejects.toBeInstanceOf(DependencyError);
    expect(calls).toBe(1);
  });

  it('rejects a zero attempt budget', async () => {
    await expect(
      retry(() => Promise.resolve('x'), {
        attempts: 0,
        idempotent: true,
        isRetryable: () => true,
        sleeper,
      }),
    ).rejects.toBeInstanceOf(InternalError);
  });
});
