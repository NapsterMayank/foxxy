import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock, RecordingSleeper } from '../../clock/index';
import {
  DEFAULT_BREAKER_POLICY,
  DEFAULT_CONCURRENCY_LIMITS,
  DEFAULT_TIMEOUT_POLICY,
} from '../../config/timeouts';
import { createGuardedEmbed, type EmbeddingProvider } from '../../embed/index';
import { DependencyError } from '../../errors/index';
import { FakeLogger } from '../../logger/index';
import { MemoryMetrics, PLATFORM_METRICS, type MetricSnapshot } from '../../metrics/index';
import { createResilienceRegistry, type ResilienceRegistry } from '../index';

/**
 * =============================================================================
 * A DEPENDENCY THAT SAYS NO IS NOW COUNTED — D-331.
 *
 * `dependency.errors`, the signal both dependency alert rules watch, is the sum
 * of four counters. Three of them — `platform.port.timeout`,
 * `platform.breaker.rejected`, `platform.concurrency.rejected` — are emitted
 * when the GUARD abandons or refuses a call. The fourth,
 * `platform.port.call_failed`, is the one for when the DEPENDENCY refuses, and
 * it existed, was tested, was listed in `IMMEDIATE_FLUSH_METRICS` and was summed
 * by the collector — and NOTHING EVER CALLED IT.
 *
 * An audit drove the real production wiring with a failing port and read the
 * table back:
 *
 *     EMBED-DOWN turn:      502 DEPENDENCY_FAILURE
 *     EMBED-DOWN metrics_events: []
 *     PAY-DOWN checkout:    502 DEPENDENCY_FAILURE
 *     PAY-DOWN metrics_events: []
 *
 * Connection refused, DNS failure and provider-500 are the most common shape an
 * outage takes, they return in milliseconds so no timeout fires, and the breaker
 * keeps its count privately until it transitions at five. So an entire payments
 * outage could come and go leaving nothing an alert rule could see.
 *
 * THIS FILE IS THE END-TO-END PROOF, and it is deliberately not a bridge test —
 * `port-failure-bridge.test.ts` already covers the classification in isolation.
 * Every test below builds a REAL `createResilienceRegistry` with a real
 * `MemoryMetrics` and reads the counter back off the snapshot, because the
 * defect was never in the bridge. It was in the wiring, and only a test that
 * spans the wiring can see it.
 *
 * THE DISJOINTNESS HALF MATTERS AS MUCH AS THE EMISSION HALF. The collector SUMS
 * all four. If `call_failed` also fired on timeouts and rejections, every
 * timeout would be worth two dependency errors and the paging threshold would
 * mean half what it says — a double-counted error rate is worse than a missing
 * one, because it is a number people quietly stop believing and then stop
 * looking at. So each test below asserts BOTH what fired and what did not.
 * =============================================================================
 */

let clock: FixedClock;
let metrics: MemoryMetrics;
let registry: ResilienceRegistry;

beforeEach(() => {
  clock = new FixedClock('2026-03-01T00:00:00.000Z');
  metrics = new MemoryMetrics({ clock });
  registry = createResilienceRegistry({
    clock,
    logger: new FakeLogger(),
    timeouts: DEFAULT_TIMEOUT_POLICY,
    concurrency: DEFAULT_CONCURRENCY_LIMITS,
    breaker: DEFAULT_BREAKER_POLICY,
    metrics,
    // §9.5 — no wall-clock waiting. `embed` carries `retries: 2`, so a call that
    // opted in would otherwise spend real jittered milliseconds here.
    sleeper: new RecordingSleeper(),
  });
});

/** Every observation of one metric, whatever its tags. */
function seriesFor(name: string): readonly MetricSnapshot[] {
  return metrics.snapshot().filter((series) => series.name === name);
}

/** The running total of one counter across all tag combinations. */
function totalFor(name: string): number {
  return seriesFor(name).reduce((sum, series) => sum + series.value, 0);
}

const hangs = (): Promise<never> =>
  new Promise(() => {
    /* never settles */
  });

describe('platform.port.call_failed — a dependency that refuses is visible (D-331)', () => {
  it('emits for a plain Error from the adapter, tagged with the port', async () => {
    // THE HEADLINE. A connection refused, expressed the way a driver expresses
    // it: a plain `Error`, no `DependencyError` wrapper, no `details`. Requiring
    // the wrapper would make the counter depend on every adapter author having
    // remembered, and the adapter that forgot is the one whose outage goes
    // unseen.
    const guard = registry.guard('payments');

    await expect(
      guard.run(() => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.4:443'))),
    ).rejects.toThrow('ECONNREFUSED');

    expect(totalFor(PLATFORM_METRICS.PORT_CALL_FAILED)).toBe(1);
    expect(seriesFor(PLATFORM_METRICS.PORT_CALL_FAILED)[0]?.tags).toEqual({ port: 'payments' });
  });

  it('emits through the real interface wrapper — the exact shape the audit drove', async () => {
    // `createGuardedEmbed` is production wiring, not a test harness: this is the
    // path `EMBED-DOWN metrics_events: []` was measured on. Asserting on
    // `guard.run` alone would leave open the possibility that the wrapper
    // swallows or re-wraps the rejection before the guard ever sees it.
    const down: EmbeddingProvider = {
      model: 'voyage-3',
      dimensions: 1024,
      embedQuery: () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.voyageai.com')),
    };
    const embed = createGuardedEmbed(down, registry.guard('embed'));

    await expect(embed.embedQuery('photosynthesis')).rejects.toBeInstanceOf(Error);

    expect(totalFor(PLATFORM_METRICS.PORT_CALL_FAILED)).toBe(1);
    expect(seriesFor(PLATFORM_METRICS.PORT_CALL_FAILED)[0]?.tags).toEqual({ port: 'embed' });
  });

  it('counts a DependencyError with no details — an adapter that wrapped but did not classify', async () => {
    const guard = registry.guard('llm');

    await expect(guard.run(() => Promise.reject(new DependencyError('llm')))).rejects.toBeInstanceOf(
      DependencyError,
    );

    expect(totalFor(PLATFORM_METRICS.PORT_CALL_FAILED)).toBe(1);
  });

  it('emits ONE per failed call, so the rate is a call rate', async () => {
    const guard = registry.guard('payments');
    for (let i = 0; i < 4; i += 1) {
      await guard.run(() => Promise.reject(new Error('provider 500'))).catch(() => undefined);
    }
    // The audit's payments outage: four failed checkouts. Four, not three (the
    // breaker trips at five) and not zero.
    expect(totalFor(PLATFORM_METRICS.PORT_CALL_FAILED)).toBe(4);
  });

  it('emits NOTHING for a call that succeeds', async () => {
    await expect(registry.guard('cache').run(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(totalFor(PLATFORM_METRICS.PORT_CALL_FAILED)).toBe(0);
  });
});

describe('the four summands of dependency.errors stay disjoint (D-331)', () => {
  it('a TIMEOUT emits platform.port.timeout and NOT call_failed', async () => {
    // The most important negative in the file. `dependency.errors` sums both, so
    // a timeout counted twice would silently halve the paging threshold — and
    // double counting is worse than under-counting, because the number stops
    // being believable rather than merely being absent.
    //
    // A 5ms deadline, not the production 15s: the property is "a hang becomes a
    // bounded rejection classified as a timeout", and 5ms asserts exactly that.
    const guard = registry.guard('payments');

    await expect(guard.run(hangs, { timeoutMs: 5 })).rejects.toBeInstanceOf(DependencyError);

    expect(totalFor(PLATFORM_METRICS.PORT_TIMEOUT)).toBe(1);
    expect(totalFor(PLATFORM_METRICS.PORT_CALL_FAILED)).toBe(0);
  });

  it('a CONCURRENCY rejection emits platform.concurrency.rejected and NOT call_failed', async () => {
    // `mail` is capped at 5. Six in flight, none of them settling, so the sixth
    // is refused by the limiter before the adapter is ever called — there is no
    // dependency failure here at all, only us sending too much.
    const guard = registry.guard('mail');
    const inFlight: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i += 1) {
      inFlight.push(guard.run(hangs).catch(() => undefined));
    }

    await expect(guard.run(() => Promise.resolve('never runs'))).rejects.toBeInstanceOf(
      DependencyError,
    );

    expect(totalFor(PLATFORM_METRICS.CONCURRENCY_REJECTED)).toBe(1);
    expect(totalFor(PLATFORM_METRICS.PORT_CALL_FAILED)).toBe(0);
    expect(inFlight).toHaveLength(5);
  });

  it('a BREAKER rejection is not counted again as a call failure', async () => {
    // Five real failures trip the breaker; each of those five IS a call failure
    // and is counted. The sixth call never reaches the network — the breaker
    // refuses it — and is already counted as `platform.breaker.rejected`.
    const guard = registry.guard('payments');
    for (let i = 0; i < 5; i += 1) {
      await guard.run(() => Promise.reject(new Error('provider 500'))).catch(() => undefined);
    }
    expect(guard.breaker.state()).toBe('open');
    expect(totalFor(PLATFORM_METRICS.PORT_CALL_FAILED)).toBe(5);

    await expect(guard.run(() => Promise.resolve('never runs'))).rejects.toBeInstanceOf(
      DependencyError,
    );

    // Still five. The rejection added to `breaker.rejected`, not to this.
    expect(totalFor(PLATFORM_METRICS.PORT_CALL_FAILED)).toBe(5);
    expect(totalFor(PLATFORM_METRICS.BREAKER_REJECTED)).toBe(1);
  });
});

describe('the failure hook observes and never owns the outcome (D-331)', () => {
  it('re-throws the ORIGINAL error, unchanged', async () => {
    // A `.catch` that reports is one keystroke away from a `.catch` that
    // swallows, and a swallowed guard failure resolves as `undefined` — every
    // caller would then treat an outage as an empty successful result.
    const original = new Error('connect ECONNREFUSED');
    const guard = registry.guard('http');

    await expect(guard.run(() => Promise.reject(original))).rejects.toBe(original);
  });

  it('does not disturb a resolved value', async () => {
    await expect(registry.guard('http').run(() => Promise.resolve({ ok: 1 }))).resolves.toEqual({
      ok: 1,
    });
  });
});
