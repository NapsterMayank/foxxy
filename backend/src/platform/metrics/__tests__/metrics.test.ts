import { describe, expect, it } from 'vitest';
import { createCircuitBreaker } from '../../circuit-breaker/index';
import { FixedClock } from '../../clock/index';
import { DEFAULT_BREAKER_POLICY, parseBreakerPolicy } from '../../config/timeouts';
import { DependencyError } from '../../errors/index';
import { FakeLogger } from '../../logger/index';
import { PII_REDACTED } from '../../pii/index';
import { createBreakerMetricsBridge } from '../breaker-bridge';
import { MemoryMetrics } from '../memory-metrics';
import { PLATFORM_METRICS } from '../metrics.port';

/**
 * 04-RESILIENCE-PLAN.md §5: "Every state transition is logged at `warn` AND
 * EMITTED AS A METRIC. A breaker that opens without anyone knowing is a silent
 * outage."
 *
 * Until `platform/metrics` existed, the first half was true and the second was
 * decoration: the only `BreakerMetrics` implementations were a no-op and a test
 * recorder, and the no-op's own comment said "observability sink lands with the
 * metrics port". These tests are what make the sentence true.
 *
 * EVERYTHING RUNS ON `FixedClock`. Nothing sleeps (plan §9.5).
 */

const policy = parseBreakerPolicy(DEFAULT_BREAKER_POLICY);

function buildBreaker(clock: FixedClock, metrics: MemoryMetrics) {
  return createCircuitBreaker({
    name: 'llm',
    clock,
    logger: new FakeLogger(),
    policy,
    metrics: createBreakerMetricsBridge(metrics),
  });
}

async function driveFailures(
  breaker: ReturnType<typeof buildBreaker>,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await expect(
      breaker.execute(() => Promise.reject(new DependencyError('llm'))),
    ).rejects.toThrow(DependencyError);
  }
}

describe('a breaker opening emits a metric', () => {
  it('counts the closed → open transition, tagged with the port and direction', async () => {
    // THE §5 assertion. Five failures inside the window trips the breaker, and
    // the transition has to arrive somewhere an operator can see it.
    const clock = new FixedClock();
    const metrics = new MemoryMetrics({ clock });
    const breaker = buildBreaker(clock, metrics);

    await driveFailures(breaker, policy.failureThreshold);

    expect(breaker.state()).toBe('open');
    const transitions = metrics
      .snapshot()
      .filter((series) => series.name === PLATFORM_METRICS.BREAKER_TRANSITION);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.tags).toEqual({ port: 'llm', from: 'closed', to: 'open' });
    expect(transitions[0]?.value).toBe(1);
  });

  it('emits the open interval as a gauge, so a doubling backoff is visible', async () => {
    // §5 doubles the wait on each failed trial, up to five minutes. Watching
    // that number climb is how an operator tells a dependency that blipped from
    // one that is genuinely gone — and it is not derivable from a state name.
    const clock = new FixedClock();
    const metrics = new MemoryMetrics({ clock });
    const breaker = buildBreaker(clock, metrics);

    await driveFailures(breaker, policy.failureThreshold);
    const first = metrics.snapshot().find((series) => series.name.endsWith('.open_ms'));
    expect(first?.value).toBe(policy.openMs);

    // Into half-open, fail the trial, and the interval doubles.
    clock.advanceMs(policy.openMs + 1);
    await driveFailures(breaker, 1);
    const second = metrics.snapshot().find((series) => series.name.endsWith('.open_ms'));
    expect(second?.value).toBe(policy.openMs * 2);
  });

  it('counts every call the OPEN breaker refuses without a network attempt', async () => {
    // The more important of the two counters, and the reason `onRejected`
    // exists at all. A breaker that opens and closes twice with no traffic in
    // between is noise; one that is open for four minutes while refusing three
    // thousand calls is an incident. The transition count alone cannot tell
    // them apart.
    const clock = new FixedClock();
    const metrics = new MemoryMetrics({ clock });
    const breaker = buildBreaker(clock, metrics);
    await driveFailures(breaker, policy.failureThreshold);

    let attempts = 0;
    for (let i = 0; i < 3; i += 1) {
      await expect(
        breaker.execute(() => {
          attempts += 1;
          return Promise.resolve('never runs');
        }),
      ).rejects.toThrow(DependencyError);
    }

    // The whole point of an open breaker: the dependency was never called.
    expect(attempts).toBe(0);
    expect(metrics.totalFor(PLATFORM_METRICS.BREAKER_REJECTED)).toBe(3);
  });

  it('counts the recovery back to closed as well', async () => {
    // §5 emits on EVERY transition, including the good one — an operator needs
    // to know the incident ENDED as much as that it started.
    const clock = new FixedClock();
    const metrics = new MemoryMetrics({ clock });
    const breaker = buildBreaker(clock, metrics);

    await driveFailures(breaker, policy.failureThreshold);
    clock.advanceMs(policy.openMs + 1);
    for (let i = 0; i < policy.halfOpenTrials; i += 1) {
      await breaker.execute(() => Promise.resolve('ok'));
    }

    expect(breaker.state()).toBe('closed');
    const directions = metrics
      .snapshot()
      .filter((series) => series.name === PLATFORM_METRICS.BREAKER_TRANSITION)
      .map((series) => `${String(series.tags.from)}->${String(series.tags.to)}`)
      .sort();
    expect(directions).toEqual(['closed->open', 'half-open->closed', 'open->half-open']);
  });
});

describe('metrics never contain PII', () => {
  it('drops an identifying tag KEY and redacts an identifying VALUE', () => {
    // A metric dimension is a low-cardinality label: 'cache', 'open',
    // 'timeout'. A user id in one is simultaneously a privacy breach and a
    // cardinality explosion, and the two failures arrive together.
    const clock = new FixedClock();
    const metrics = new MemoryMetrics({ clock });

    metrics.counter('test.thing', 1, {
      userEmail: 'asha@example.com',
      note: 'called 9876543210',
      port: 'cache',
    });

    const series = metrics.snapshot();
    expect(series).toHaveLength(1);
    expect(series[0]?.tags).toEqual({ note: PII_REDACTED, port: 'cache' });

    const serialised = JSON.stringify(series);
    expect(serialised).not.toContain('asha@example.com');
    expect(serialised).not.toContain('9876543210');
  });

  it('carries no PII on any metric the platform itself emits', () => {
    // The tags every §5/§4/§3.3 emission uses are port names, states and
    // numbers. Asserted as a set so that adding an identifying tag to one of
    // them fails here rather than in a breach report.
    const clock = new FixedClock();
    const metrics = new MemoryMetrics({ clock });
    metrics.counter(PLATFORM_METRICS.BREAKER_TRANSITION, 1, {
      port: 'llm',
      from: 'closed',
      to: 'open',
    });
    metrics.counter(PLATFORM_METRICS.CONCURRENCY_REJECTED, 1, { port: 'embed', max: '10' });
    metrics.counter(PLATFORM_METRICS.PORT_TIMEOUT, 1, { port: 'mail', timeoutMs: '10000' });

    for (const series of metrics.snapshot()) {
      for (const key of Object.keys(series.tags)) {
        expect(['port', 'from', 'to', 'max', 'timeoutMs']).toContain(key);
      }
    }
  });
});

describe('MemoryMetrics aggregates', () => {
  it('accumulates a counter and overwrites a gauge', () => {
    // A counter's reported value is its RUNNING TOTAL; a gauge's is its LATEST.
    // One rule for both would make either "how many times has this tripped" or
    // "how many calls are in flight" report nonsense.
    const clock = new FixedClock();
    const metrics = new MemoryMetrics({ clock });

    metrics.counter('c', 2);
    metrics.counter('c', 3);
    metrics.gauge('g', 7);
    metrics.gauge('g', 4);

    const byName = new Map(metrics.snapshot().map((series) => [series.name, series]));
    expect(byName.get('c')?.value).toBe(5);
    expect(byName.get('g')?.value).toBe(4);
    expect(byName.get('g')?.count).toBe(2);
  });

  it('records histogram min, max and sum', () => {
    const clock = new FixedClock();
    const metrics = new MemoryMetrics({ clock });
    metrics.histogram('h', 10);
    metrics.histogram('h', 30);
    metrics.histogram('h', 20);

    const series = metrics.snapshot()[0];
    expect(series?.count).toBe(3);
    expect(series?.min).toBe(10);
    expect(series?.max).toBe(30);
    expect(series?.sum).toBe(60);
  });

  it('treats tag order as irrelevant — one series, not two', () => {
    // Without sorting the key before joining, `{a,b}` and `{b,a}` are two
    // series and a dashboard shows half the traffic on each. That reads as a
    // traffic drop, which is the worst way for a bug like this to present.
    const clock = new FixedClock();
    const metrics = new MemoryMetrics({ clock });
    metrics.counter('c', 1, { a: '1', b: '2' });
    metrics.counter('c', 1, { b: '2', a: '1' });

    expect(metrics.snapshot()).toHaveLength(1);
    expect(metrics.snapshot()[0]?.value).toBe(2);
  });

  it('drops NaN and Infinity rather than poisoning a series', () => {
    // One NaN makes a sum NaN forever. An observation that is not a number is a
    // bug upstream, and it must not become a permanently broken aggregate.
    const clock = new FixedClock();
    const metrics = new MemoryMetrics({ clock });
    metrics.counter('c', 1);
    metrics.counter('c', Number.NaN);
    metrics.counter('c', Number.POSITIVE_INFINITY);

    expect(metrics.snapshot()[0]?.value).toBe(1);
    expect(metrics.droppedCount()).toBe(2);
  });

  it('tees every observation to the durable sink', () => {
    // How the Postgres sink is fed in production: one object, one scrub, no
    // chance of the two sinks disagreeing about what was recorded.
    const clock = new FixedClock();
    const seen: string[] = [];
    const metrics = new MemoryMetrics({
      clock,
      onRecord: (event) => seen.push(`${event.kind}:${event.name}:${String(event.value)}`),
    });

    metrics.counter('c');
    metrics.gauge('g', 3);
    metrics.histogram('h', 5);

    expect(seen).toEqual(['counter:c:1', 'gauge:g:3', 'histogram:h:5']);
  });

  it('stamps the injected clock, never the wall clock', () => {
    const clock = new FixedClock('2026-08-09T09:00:00.000Z');
    const metrics = new MemoryMetrics({ clock });
    metrics.counter('c');
    expect(metrics.snapshot()[0]?.lastAt).toBe('2026-08-09T09:00:00.000Z');
  });
});
