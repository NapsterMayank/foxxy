import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock, RecordingSleeper } from '../../clock/index';
import { createGuardedCache } from '../../cache/index';
import type { CachePort } from '../../cache/index';
import {
  DEFAULT_BREAKER_POLICY,
  DEFAULT_CONCURRENCY_LIMITS,
  DEFAULT_TIMEOUT_POLICY,
} from '../../config/timeouts';
import type { TimeoutPolicy } from '../../config/index';
import { createGuardedEmbed } from '../../embed/index';
import { createGuardedMail } from '../../mail/index';
import type { MailPort } from '../../mail/index';
import { DependencyError } from '../../errors/index';
import { FakeLogger } from '../../logger/index';
import { MemoryMetrics, PLATFORM_METRICS } from '../../metrics/index';
import { jitterLowerBoundMs } from '../../retry/index';
import { createResilienceRegistry, type PortGuard, type ResilienceRegistry } from '../index';

/**
 * ===========================================================================
 * D-237 — `TimeoutRule.retries` IS WIRED.
 *
 * The §4 timeout table has carried a `retries` column since the plan was
 * written. It was parsed, range-validated, documented ("a non-zero value here
 * is a statement that the call is idempotent") and READ BY NOTHING.
 *
 * That is worse than not having the column. `payments: { retries: 0 }` sits in
 * the table next to the sentence "none on writes — retrying a payment is worse
 * than failing it", and a reader takes it as an enforced safety property. It
 * forbade exactly as much as `mail: { retries: 3 }` required: nothing. An
 * unwired safety setting is not a no-op, it is a false guarantee, and the cost
 * is paid by the next person who trusts it.
 *
 * WHAT MAKES THE WIRING SAFE is that a guard wraps a PORT, not an operation.
 * `cache` carries `retries: 1` and `cache.incr` is the rate limiter's counter;
 * `mail` carries `retries: 3` and `mail.send` is not idempotent. Spending the
 * budget on every call the guard wraps would have double-counted logins and
 * quadrupled verification emails. So the RULE supplies the budget and the CALL
 * SITE supplies the permission, and a retry needs both.
 *
 * §9.5 — no `sleep` anywhere here. Every registry gets a `RecordingSleeper`,
 * which records the delay and advances the injected clock, so the jittered
 * sequence is asserted exactly and no wall-clock time passes.
 * ===========================================================================
 */

let clock: FixedClock;
let sleeper: RecordingSleeper;
let metrics: MemoryMetrics;

beforeEach(() => {
  clock = new FixedClock('2026-03-01T00:00:00.000Z');
  sleeper = new RecordingSleeper();
  metrics = new MemoryMetrics({ clock });
});

function registryWith(timeouts: TimeoutPolicy): ResilienceRegistry {
  return createResilienceRegistry({
    clock,
    logger: new FakeLogger(),
    timeouts,
    concurrency: DEFAULT_CONCURRENCY_LIMITS,
    breaker: DEFAULT_BREAKER_POLICY,
    metrics,
    sleeper,
    // Fixed, so the jittered delay is the lower bound of its band exactly.
    // `platform/retry` has no un-jittered path (§4, "synchronised retries are a
    // self-inflicted denial of service"), so the randomness is INJECTED rather
    // than removed.
    random: () => 0,
  });
}

/** A guard for one port with its retry budget overridden. */
function guardWithRetries(
  port: 'cache' | 'embed' | 'mail' | 'payments',
  retries: number,
): PortGuard {
  return registryWith({
    ...DEFAULT_TIMEOUT_POLICY,
    [port]: { ...DEFAULT_TIMEOUT_POLICY[port], retries },
  }).guard(port);
}

/** Fails `failures` times, then succeeds. Counts every attempt it sees. */
function flaky(failures: number): { calls: () => number; run: () => Promise<string> } {
  let calls = 0;
  return {
    calls: () => calls,
    run: (): Promise<string> => {
      calls += 1;
      return calls <= failures
        ? Promise.reject(new DependencyError('flaky', { details: { port: 'flaky' } }))
        : Promise.resolve('ok');
    },
  };
}

describe('the budget and the permission — both, or one attempt', () => {
  it('does NOT retry when the call site has not declared itself repeatable', async () => {
    // The default, and the reason this change cannot break anything that
    // already exists: every call site written before D-237 gets exactly the
    // single attempt it has always got.
    const guard = guardWithRetries('embed', 3);
    const op = flaky(2);

    await expect(guard.run(op.run)).rejects.toBeInstanceOf(DependencyError);
    expect(op.calls()).toBe(1);
  });

  it('retries up to the budget when the call site HAS declared itself repeatable', async () => {
    const guard = guardWithRetries('embed', 3);
    const op = flaky(2);

    await expect(guard.run(op.run, { idempotent: true })).resolves.toBe('ok');
    // `retries` is attempts AFTER the first, so 3 allows 4 in total; two
    // failures then a success is three.
    expect(op.calls()).toBe(3);
  });

  it('gives up at the budget rather than retrying forever', async () => {
    const guard = guardWithRetries('embed', 2);
    const op = flaky(99);

    await expect(guard.run(op.run, { idempotent: true })).rejects.toBeInstanceOf(DependencyError);
    expect(op.calls()).toBe(3);
  });

  /**
   * THE ASSERTION THIS WHOLE HANDOFF IS ABOUT.
   *
   * `payments: { retries: 0 }` must now forbid something. The call site is
   * DELIBERATELY declaring itself repeatable — the mistake a future author
   * makes — and the policy overrules it. The permission cannot exceed the
   * budget, so a zero in the table is a real zero and the sentence beside it
   * ("retrying a payment is worse than failing it") is enforced rather than
   * decorative.
   */
  it('REFUSES TO RETRY A PAYMENT even when the caller asks for it', async () => {
    expect(DEFAULT_TIMEOUT_POLICY.payments.retries).toBe(0);

    const guard = registryWith(DEFAULT_TIMEOUT_POLICY).guard('payments');
    const op = flaky(99);

    await expect(guard.run(op.run, { idempotent: true })).rejects.toBeInstanceOf(DependencyError);
    expect(op.calls()).toBe(1);
  });

  it('spends the shipped per-port budgets, not one global number', async () => {
    // The four rows that differ. If the guard read a constant instead of the
    // rule, these would all be equal and nobody would notice.
    const budgets: Record<string, number> = {};
    for (const port of ['cache', 'embed', 'mail', 'payments'] as const) {
      const guard = registryWith(DEFAULT_TIMEOUT_POLICY).guard(port);
      const op = flaky(99);
      await guard.run(op.run, { idempotent: true }).catch(() => undefined);
      budgets[port] = op.calls();
    }
    expect(budgets).toEqual({
      cache: DEFAULT_TIMEOUT_POLICY.cache.retries + 1,
      embed: DEFAULT_TIMEOUT_POLICY.embed.retries + 1,
      mail: DEFAULT_TIMEOUT_POLICY.mail.retries + 1,
      payments: 1,
    });
  });
});

describe('what is worth another attempt', () => {
  it('backs off with JITTER between attempts, never a tight loop', async () => {
    const guard = guardWithRetries('embed', 2);
    const op = flaky(99);

    await guard.run(op.run, { idempotent: true }).catch(() => undefined);

    // Two waits for three attempts, exponential, and each inside its jitter
    // band rather than at the raw `100 * 2 ** n`.
    expect(sleeper.delays).toHaveLength(2);
    expect(sleeper.delays[0]).toBe(jitterLowerBoundMs(0));
    expect(sleeper.delays[1]).toBe(jitterLowerBoundMs(1));
    expect(sleeper.delays[1]).toBeGreaterThan(sleeper.delays[0] ?? 0);
  });

  it('does NOT retry a breaker rejection — that would be a slow retry loop', async () => {
    /**
     * An open breaker has already decided the dependency is down and refuses
     * calls WITHOUT a network attempt. Retrying that rejection turns the
     * breaker into precisely the thing it exists to prevent: a caller
     * repeatedly asking a dependency known to be broken, now with sleeps in
     * between so it takes longer to fail.
     */
    const registry = registryWith(DEFAULT_TIMEOUT_POLICY);
    const guard = registry.guard('embed');
    const failing = (): Promise<never> =>
      Promise.reject(new DependencyError('embed', { details: { port: 'embed' } }));

    // Trip it. `embed` allows 2 retries, so this reaches the threshold quickly.
    for (let i = 0; i < 5; i += 1) {
      await guard.run(failing, { idempotent: true }).catch(() => undefined);
    }
    expect(guard.breaker.state()).toBe('open');

    const before = sleeper.delays.length;
    let calls = 0;
    await guard
      .run(
        () => {
          calls += 1;
          return Promise.resolve('never reached');
        },
        { idempotent: true },
      )
      .catch(() => undefined);

    expect(calls).toBe(0);
    // No network attempt AND no backoff wait: the rejection is free.
    expect(sleeper.delays.length).toBe(before);
  });

  it('does NOT retry a concurrency rejection — that would add load to an overloaded port', async () => {
    const guard = guardWithRetries('embed', 3);
    const limiter = guard.limiter;
    const held = Array.from({ length: limiter.max }, () => limiter.acquire());

    try {
      let calls = 0;
      await expect(
        guard.run(
          () => {
            calls += 1;
            return Promise.resolve('x');
          },
          { idempotent: true },
        ),
      ).rejects.toBeInstanceOf(DependencyError);
      expect(calls).toBe(0);
      expect(sleeper.delays).toHaveLength(0);
    } finally {
      for (const release of held) release();
    }
  });

  it('does NOT retry a non-dependency error — a 400 is not a blip', () => {
    // A validation failure repeated three times is three identical validation
    // failures, plus two backoff waits added to a request that was always going
    // to fail. Only a dependency failure is worth another attempt.
    const guard = guardWithRetries('embed', 3);
    let calls = 0;

    return expect(
      guard.run(
        () => {
          calls += 1;
          return Promise.reject(new RangeError('bad input'));
        },
        { idempotent: true },
      ),
    )
      .rejects.toBeInstanceOf(RangeError)
      .then(() => {
        expect(calls).toBe(1);
      });
  });

  it('holds ONE slot for the whole retried operation, not one per attempt', async () => {
    /**
     * The limiter is outside the retry loop. Re-acquiring per attempt would let
     * real in-flight concurrency exceed the configured limit during a retry
     * storm while the limiter's own count reported the configured number —
     * accounting diverging from reality with no symptom, which is the same
     * class of defect as D-262 and not worth introducing a second time.
     */
    const guard = guardWithRetries('embed', 3);
    const seen: number[] = [];
    const op = (): Promise<never> => {
      seen.push(guard.limiter.inFlight());
      return Promise.reject(new DependencyError('embed', { details: { port: 'embed' } }));
    };

    await guard.run(op, { idempotent: true }).catch(() => undefined);

    expect(seen).toHaveLength(4);
    expect(seen.every((inFlight) => inFlight === 1)).toBe(true);
    expect(guard.limiter.inFlight()).toBe(0);
  });

  it('counts every retry on the metrics port', async () => {
    // §4's other half. A dependency that succeeds on attempt two every single
    // time is a dependency that is failing every single time, and without this
    // counter it is indistinguishable from a healthy one.
    const guard = guardWithRetries('embed', 3);
    const op = flaky(2);

    await guard.run(op.run, { idempotent: true });

    const series = metrics.snapshot().filter((s) => s.name === PLATFORM_METRICS.PORT_RETRIED);
    expect(series.reduce((sum, s) => sum + s.value, 0)).toBe(2);
    expect(series.every((s) => s.tags.port === 'embed')).toBe(true);
  });
});

describe('the port wrappers spend their budgets where it is safe', () => {
  it('retries an embedding — pure, writes nothing, repeat is invisible', async () => {
    const guard = guardWithRetries('embed', 2);
    let calls = 0;
    const embed = createGuardedEmbed(
      {
        model: 'voyage-3',
        dimensions: 1024,
        embedQuery: (): Promise<number[]> => {
          calls += 1;
          return calls < 3
            ? Promise.reject(new DependencyError('embed', { details: { port: 'embed' } }))
            : Promise.resolve([0.1]);
        },
      },
      guard,
    );

    await expect(embed.embedQuery('photosynthesis')).resolves.toEqual([0.1]);
    expect(calls).toBe(3);
  });

  it('NEVER retries cache.incr — it is the rate limiter’s counter', async () => {
    /**
     * The case that made a blanket wiring impossible. A timed-out `INCR` has
     * very often been executed; retrying it counts one login attempt twice and
     * locks a user out having done nothing wrong — a retry budget silently
     * TIGHTENING an authentication limit, reported as "random lockouts".
     *
     * `get` on the same port and the same budget retries, which is what makes
     * this an assertion about `incr` rather than about the port being
     * un-wired.
     */
    let incrCalls = 0;
    let getCalls = 0;
    const inner: CachePort = {
      get: (): Promise<string | null> => {
        getCalls += 1;
        return Promise.reject(new DependencyError('cache', { details: { port: 'cache' } }));
      },
      set: () => Promise.resolve(),
      del: () => Promise.resolve(),
      incr: (): Promise<number> => {
        incrCalls += 1;
        return Promise.reject(new DependencyError('cache', { details: { port: 'cache' } }));
      },
      expire: () => Promise.resolve(true),
      close: () => Promise.resolve(),
    };
    const cache = createGuardedCache(inner, guardWithRetries('cache', 2));

    await cache.incr('rl:login:ip').catch(() => undefined);
    expect(incrCalls).toBe(1);

    await cache.get('k').catch(() => undefined);
    expect(getCalls).toBe(3);
  });

  it('NEVER retries mail.send — a timed-out SMTP send has often been delivered', async () => {
    // `mail` carries the largest budget in the table (3). Spending it would
    // send a password-reset link up to four times, from a change whose stated
    // purpose was reliability. §3.3's answer for mail is to DEFER TO THE
    // WORKER, whose queue already has at-least-once semantics.
    let sendCalls = 0;
    const alwaysFails: MailPort = {
      send: (): Promise<void> => {
        sendCalls += 1;
        return Promise.reject(new DependencyError('mail', { details: { port: 'mail' } }));
      },
    };
    const mail = createGuardedMail(alwaysFails, guardWithRetries('mail', 3));

    await mail
      .send({ to: 'a@example.test', template: 'email-verification', data: {} })
      .catch(() => undefined);

    // One attempt, and no backoff wait: the failure was consumed, nothing re-sent.
    expect(sendCalls).toBe(1);
    expect(sleeper.delays).toHaveLength(0);
  });
});
