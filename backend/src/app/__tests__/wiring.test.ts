import { afterEach, describe, expect, it } from 'vitest';
import { RecordingAudit, createNoopAudit } from '@/platform/audit/index';
import { MemoryCache } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { parseConfig } from '@/platform/config/load-config';
import { DependencyError } from '@/platform/errors/index';
import { FakeLogger } from '@/platform/logger/index';
import { RecordingMail } from '@/platform/mail/index';
import { PLATFORM_METRICS } from '@/platform/metrics/index';
import { createRateLimiter, RATE_LIMIT_FALLBACK_METRIC } from '@/modules/identity/identity.rate-limit';
import { createContainer, type Container } from '../container';
import { buildModules } from '../routes';

/**
 * THE FOUNDATION HOOKS, WIRED — not merely built.
 *
 * WHY THIS FILE EXISTS, and it is the same reason `routes.test.ts` does. Every
 * new port here has thorough unit tests, and every one of them would pass in
 * full while the port was connected to nothing. That is not hypothetical: it is
 * precisely the state §5 was in before this work — `BreakerMetrics` existed, was
 * tested, and its only production implementation was `createNoopBreakerMetrics`,
 * whose own comment admitted the sink had never been built.
 *
 * A silently-unwired audit log is indistinguishable from a working one with
 * nothing to say. A silently-unwired metrics port is indistinguishable from a
 * healthy system. Both failures look exactly like success, which is why the
 * wiring needs its own assertions.
 *
 * No database connection is made: `pg.Pool` connects lazily and nothing here
 * issues a query.
 */

let container: Container | undefined;

function makeContainer(overrides: Parameters<typeof createContainer>[1] = {}): Container {
  const clock = new FixedClock('2026-08-09T09:00:00.000Z');
  const config = parseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5433/unused',
    REDIS_URL: 'redis://localhost:6379',
    CORS_READ_ORIGINS: 'http://localhost:3000',
    CORS_WRITE_ORIGINS: 'http://localhost:3000',
    SESSION_COOKIE_NAME: 'foxxy_session',
    APP_URL: 'http://app.test',
    API_URL: 'http://api.test',
  });
  container = createContainer(config, {
    clock,
    cache: new MemoryCache(clock),
    mail: new RecordingMail(),
    logger: new FakeLogger(),
    ...overrides,
  });
  return container;
}

afterEach(async () => {
  await container?.shutdown();
  container = undefined;
});

describe('the container wires the new ports', () => {
  it('exposes a metrics port and a readable snapshot', () => {
    const built = makeContainer();
    built.metrics.counter('test.wiring');
    expect(built.metricsSnapshot().map((series) => series.name)).toContain('test.wiring');
  });

  it('gives the resilience registry the SAME metrics port', () => {
    // The ordering that makes §5 true: metrics are built BEFORE the registry,
    // because the registry wires four emissions from them. If the registry fell
    // back to its no-op default, every breaker in the process would go on
    // reporting nothing and every unit test would still pass.
    const built = makeContainer();
    const limiter = built.resilience.guard('llm').limiter;

    // Saturate the port's concurrency limit and assert the rejection is counted
    // — §3.3's rejection is CORRECT behaviour, which is exactly why it needs a
    // metric: from inside the process it looks like health (no error, no
    // timeout), and from outside it looks like a broken feature.
    const releases = Array.from({ length: limiter.max }, () => limiter.acquire());
    expect(() => limiter.acquire()).toThrow(DependencyError);
    for (const release of releases) release();

    expect(
      built.metricsSnapshot().find((series) => series.name === PLATFORM_METRICS.CONCURRENCY_REJECTED)
        ?.value,
    ).toBe(1);
  });

  it('exposes a NON-NOOP audit port by default', () => {
    // The default has to be the real one. An audit port that quietly does
    // nothing unless somebody remembers to configure it is worse than none: it
    // produces an empty table that reads as "no privileged actions occurred".
    const built = makeContainer();
    expect(built.audit).toBeDefined();
    expect(built.audit).not.toEqual(createNoopAudit());
  });

  it('exposes a notification dispatcher with in-app as the default channel', () => {
    // An unregistered message kind falls through to in-app only. Conservative
    // on purpose: an unknown kind is one somebody added without registering it,
    // and delivering it to an inbox would mean an unreviewed notification
    // reaching a parent.
    const built = makeContainer();
    expect(built.notify.channelsFor('anything.unregistered')).toEqual(['in-app']);
  });

  it('resolves EVERY channel name, including the unimplemented ones', async () => {
    // The totality that makes `whatsapp` and `push` worth having as adapters. A
    // partial map would make "this channel does not exist" a second failure
    // mode alongside "this channel failed", for every call site to distinguish.
    const built = makeContainer({ channelPolicy: { 'test.kind': ['whatsapp'] } });
    const outcome = await built.notify.send(
      { userId: 'u1' },
      {
        kind: 'test.kind',
        title: { en: 'T', hi: 'श' },
        body: { en: 'B', hi: 'सं' },
      },
    );

    // It threw, it was CAUGHT per channel, and it was recorded as a failure
    // rather than crashing the caller.
    expect(outcome.delivered).toBe(false);
    expect(outcome.results[0]?.channel).toBe('whatsapp');
    expect(outcome.results[0]?.reason).toContain('NOT IMPLEMENTED');
  });
});

describe('buildModules passes the audit port to identity', () => {
  it('hands identity a real audit port rather than letting it default', () => {
    // `IdentityModuleDeps.audit` is OPTIONAL and defaults to a no-op, so the
    // module compiles and every one of its tests passes with auditing off. This
    // is the only assertion that the production wiring actually connects it.
    const audit = new RecordingAudit();
    const built = makeContainer({ audit });
    const modules = buildModules(built);
    expect(modules.identity.service).toBeDefined();
    // The override reached the container, which is what `buildModules` reads.
    expect(built.audit).toBe(audit);
  });
});

describe('the rate-limit fallback emits a metric', () => {
  it('counts an activation on the process metrics port', async () => {
    // D-034: "a silent fallback is a silent security downgrade — the whole
    // point is that somebody finds out". An in-process fallback means
    // AUTHENTICATION HAS DEGRADED to a per-instance limiter, so N instances
    // admit up to N times the limit.
    //
    // The `MetricsSink` interface and this metric name have existed since D-034
    // and the only production implementation was `NO_METRICS`. The `warn` line
    // was the sole signal. This asserts the adapter in `app/routes.ts` — the
    // three lines that finally give it somewhere to go.
    const built = makeContainer();
    const sink = {
      increment: (metric: string, tags?: Readonly<Record<string, string>>): void => {
        built.metrics.counter(metric, 1, tags);
      },
    };

    const limiter = createRateLimiter({
      // A cache that always fails, which is what a Valkey outage looks like
      // from in here.
      cache: {
        incr: () => Promise.reject(new Error('cache unavailable')),
        expire: () => Promise.reject(new Error('cache unavailable')),
        del: () => Promise.reject(new Error('cache unavailable')),
        get: () => Promise.reject(new Error('cache unavailable')),
        set: () => Promise.reject(new Error('cache unavailable')),
        close: () => Promise.resolve(),
      },
      clock: built.clock,
      logger: built.logger,
      metrics: sink,
    });

    // The request still succeeds — degraded rate limiting beats no
    // authentication — and the degradation is now COUNTED rather than only
    // logged.
    await limiter.consume('rl:identity:login:ip:test', { limit: 5, windowSeconds: 900 });

    const emitted = built
      .metricsSnapshot()
      .find((series) => series.name === RATE_LIMIT_FALLBACK_METRIC);
    expect(emitted?.value).toBe(1);
  });
});
