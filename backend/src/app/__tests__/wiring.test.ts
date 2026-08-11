import { afterEach, describe, expect, it } from 'vitest';
import { RecordingAudit, createNoopAudit } from '@/platform/audit/index';
import { MemoryCache } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { parseConfig } from '@/platform/config/load-config';
import { createDeterministicEmbed } from '@/platform/embed/index';
import { DependencyError } from '@/platform/errors/index';
import { createFakeLlm } from '@/platform/llm/index';
import { FakeLogger } from '@/platform/logger/index';
import { RecordingMail } from '@/platform/mail/index';
import {
  FAKE_PROVIDER,
  RAZORPAY_PROVIDER,
  createFakePayments,
} from '@/platform/payments/index';
import { PLATFORM_METRICS } from '@/platform/metrics/index';
import { createRateLimiter, RATE_LIMIT_FALLBACK_METRIC } from '@/modules/identity/identity.rate-limit';
import { ABSTAIN_THRESHOLD, CANDIDATE_LIMIT } from '@/modules/retrieval/index';
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

/**
 * ============================================================================
 * THE PAYMENT-GATEWAY PORT — the third "wrong without anything failing" adapter
 * choice in the container, and the worst of the three.
 *
 * `embed` on the fake returns confident wrong answers; `llm` on the fake
 * returns one canned sentence. `payments` on the fake HAPPILY CREATES
 * SUBSCRIPTIONS and HAPPILY VERIFIES WEBHOOKS SIGNED WITH A SECRET WE CHOSE —
 * so a production deployment that fell back to it would grant entitlements
 * against payments that never happened, with no error, no failed request and
 * nothing in a log. It is discovered by reconciling a bank statement.
 *
 * These are the assertions that the boot refusal is REAL rather than a comment
 * about one.
 *
 * ---------------------------------------------------------------------------
 * WHY `PRODUCTION_BASE` SATISFIES EVERY *OTHER* GATE RATHER THAN NONE OF THEM.
 *
 * `createContainer` runs its production refusals in source order — mail, then
 * embed, then llm, then payments, then the migration journal — and every one of
 * them throws. A base environment that satisfied none of them therefore proved
 * nothing about payments: the FIRST unmet gate threw and `toThrow(/RAZORPAY…/)`
 * only ever passed because payments happened to be first among the unmet ones.
 *
 * That is exactly how these four tests broke: D-226 added the SMTP gate AHEAD
 * of payments, and all four went red with `SMTP_HOST is required in
 * production` — a correct refusal, reported as a payments regression. The
 * tests were asserting gate ORDER while claiming to assert gate CONTENT.
 *
 * So the base now satisfies every gate, and each case removes EXACTLY the
 * variable it is about via `without`. A gate added ahead of payments tomorrow
 * cannot break this block, because a gate that is satisfied does not throw and
 * therefore cannot be the thing observed.
 * ---------------------------------------------------------------------------
 */
describe('the container chooses a payment gateway and refuses to guess', () => {
  /**
   * Every production boot gate satisfied — SMTP (D-226), Voyage, the LLM key,
   * and Razorpay. Nothing here opens a socket: `nodemailer.createTransport`
   * connects on send, and the Voyage/Anthropic adapters take an injected
   * `HttpClient` and are constructed lazily.
   */
  const PRODUCTION_BASE = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:pass@localhost:5433/unused',
    REDIS_URL: 'redis://localhost:6379',
    CORS_READ_ORIGINS: 'https://app.example.com',
    CORS_WRITE_ORIGINS: 'https://app.example.com',
    SESSION_COOKIE_NAME: 'foxxy_session',
    APP_URL: 'https://app.example.com',
    API_URL: 'https://api.example.com',
    // D-226 — the mail gate, which runs BEFORE payments.
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'no-reply@example.com',
    SMTP_PASSWORD: 'smtp-app-password',
    SMTP_FROM: 'Foxxy <no-reply@example.com>',
    // The two AI gates, which also run before payments.
    VOYAGE_API_KEY: 'voyage-test-key',
    LLM_API_KEY: 'llm-test-key',
    // Payments — removed per-case by `without` below.
    RAZORPAY_KEY_ID: 'rzp_test_key_id',
    RAZORPAY_KEY_SECRET: 'rzp_test_key_secret',
    RAZORPAY_WEBHOOK_SECRET: 'whsec_different_from_the_api_secret',
    RAZORPAY_PLAN_IDS: 'monthly:plan_MONTH,yearly:plan_YEAR',
  } as const;

  /**
   * `PRODUCTION_BASE` with the named variables absent — the one axis under
   * test, with every other gate left satisfied.
   */
  function without(...keys: readonly (keyof typeof PRODUCTION_BASE)[]): Record<string, string> {
    return Object.fromEntries(
      Object.entries(PRODUCTION_BASE).filter(
        ([name]) => !keys.includes(name as keyof typeof PRODUCTION_BASE),
      ),
    );
  }

  /**
   * The deterministic AI adapters, so no case depends on a real vendor client
   * being constructible. Kept alongside the env keys rather than instead of
   * them: the keys make the GATES pass, these make the ADAPTERS inert.
   */
  const AI_OVERRIDES = {
    embed: createDeterministicEmbed(),
    llm: createFakeLlm(),
  };

  it('takes the deterministic fake in development, guarded', () => {
    const built = makeContainer();
    expect(built.payments.name).toBe(FAKE_PROVIDER);
  });

  it('REFUSES TO BOOT in production with no credentials, naming the missing one', () => {
    const config = parseConfig(
      without('RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'),
    );
    expect(() => createContainer(config, AI_OVERRIDES)).toThrow(/RAZORPAY_KEY_ID/);
  });

  it('refuses for the PAYMENTS reason, not because some earlier gate was unset', () => {
    // The assertion the old ordering-dependent form could not make. Had the
    // SMTP gate still been unsatisfied here, the message would name SMTP_HOST
    // and the test above would pass for entirely the wrong reason.
    const config = parseConfig(
      without('RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'),
    );
    expect(() => createContainer(config, AI_OVERRIDES)).not.toThrow(/SMTP_|VOYAGE_|LLM_API_KEY/);
  });

  it('names RAZORPAY_WEBHOOK_SECRET specifically when only that one is absent', () => {
    /**
     * THE CASE MOST LIKELY TO HAPPEN. The webhook secret is a DIFFERENT secret
     * from the API key, issued per endpoint in the Razorpay dashboard, and
     * setting the API key pair while forgetting it is the standard
     * misconfiguration. Its symptom without this check is not an outage: it is
     * checkout working perfectly while every genuine delivery fails its
     * signature — money in, no access.
     */
    const config = parseConfig(without('RAZORPAY_WEBHOOK_SECRET'));
    expect(() => createContainer(config, AI_OVERRIDES)).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
  });

  it('takes the Razorpay adapter in production once all three are set', async () => {
    const config = parseConfig(PRODUCTION_BASE);
    const built = createContainer(config, AI_OVERRIDES);
    try {
      expect(built.payments.name).toBe(RAZORPAY_PROVIDER);
    } finally {
      await built.shutdown();
    }
  });

  it('lets an EXPLICIT override through in production without credentials', async () => {
    /**
     * "No key was set" and "this deployment supplies its own port" are
     * different facts, and only one of them should be refused. The refusal is
     * about the SILENT fallback, not about the fake itself.
     */
    const config = parseConfig(
      without('RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'),
    );
    const built = createContainer(config, {
      ...AI_OVERRIDES,
      payments: createFakePayments({ secret: 'explicit' }),
    });
    try {
      expect(built.payments.name).toBe(FAKE_PROVIDER);
    } finally {
      await built.shutdown();
    }
  });

  it('hands billing the container’s port rather than letting it build one', () => {
    // `BillingModuleDeps.payments` is REQUIRED, so this cannot be silently
    // omitted — but it could be satisfied with a locally-constructed adapter,
    // which would sidestep both the guard and the boot refusal above.
    const built = makeContainer();
    const modules = buildModules(built);
    expect(modules.billing.service).toBeDefined();
    expect(built.payments.name).toBe(FAKE_PROVIDER);
  });
});

/**
 * ===========================================================================
 * THE PRODUCTION ABSTENTION FLOOR IS THE MEASURED ONE — ASSERTED, NOT ASSUMED.
 *
 * `buildModules` runs the shipped threshold by NOT passing one, and "does not
 * pass one" is invisible: it is the absence of a line, so nothing in a diff or
 * a review draws the eye to it. Meanwhile the override seam is real and in
 * active use — `eval/retrieval/` sweeps it, `tests/integration/retrieval-search`
 * zeroes it, and `tests/helpers/app-harness.ts` zeroes it for every service
 * suite in the repo, because those all embed with `createDeterministicEmbed`
 * and a floor measured against real voyage-3 vectors decides nothing on
 * semantics-free hashes.
 *
 * Three seams zeroing the floor for good reasons is exactly the shape from
 * which a fourth one leaks into the composition root and nobody notices for a
 * year — which is the failure §8.4 exists to prevent, in its other direction:
 * not a floor that abstains on everything, a floor that abstains on nothing
 * while its provenance still says MEASURED. This test is what makes that a
 * failing build.
 * ===========================================================================
 */
describe('the composition root runs the MEASURED abstention threshold', () => {
  it('gives retrieval the shipped threshold, provenance and all', () => {
    const built = makeContainer();
    const modules = buildModules(built);
    const threshold = modules.retrieval.service.threshold;

    // The provenance, first — a value alone cannot tell a reader whether it was
    // measured or guessed, and that distinction is the whole point of the type.
    expect(threshold.provenance.state).toBe('MEASURED');
    // …and the value, so "MEASURED" cannot be true of some other number.
    expect(threshold).toEqual(ABSTAIN_THRESHOLD);
    expect(threshold.value).toBe(0.029877369007803793);
    expect(threshold.candidateLimit).toBe(CANDIDATE_LIMIT);
  });

  it('does NOT inherit the test harness’s never-abstain-on-score override', () => {
    // The specific leak this file is watching for. A zero floor in production
    // abstains on nothing, forever, while every trace row still reports the
    // threshold state as measured — indistinguishable from a healthy pipeline.
    const built = makeContainer();
    const modules = buildModules(built);
    expect(modules.retrieval.service.threshold.value).toBeGreaterThan(0);
  });

  it('is the SAME threshold in the background worker as in the API process', () => {
    // `buildModules(container, { forWorker: true })` swaps the pool, and a
    // second construction site is a second place an override can be added to
    // one and not the other. Foxy's answers and the worker's would then
    // disagree about what "we do not know" means.
    const built = makeContainer();
    const api = buildModules(built);
    const worker = buildModules(built, { forWorker: true });
    expect(worker.retrieval.service.threshold).toEqual(api.retrieval.service.threshold);
    expect(worker.retrieval.service.threshold.provenance.state).toBe('MEASURED');
  });
});
