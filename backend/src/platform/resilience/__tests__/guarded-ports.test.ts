import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock, RecordingSleeper } from '../../clock/index';
import { createGuardedCache, MemoryCache } from '../../cache/index';
import type { CachePort } from '../../cache/index';
import {
  DEFAULT_BREAKER_POLICY,
  DEFAULT_CONCURRENCY_LIMITS,
  DEFAULT_TIMEOUT_POLICY,
} from '../../config/timeouts';
import { createGuardedEmbed } from '../../embed/index';
import type { EmbeddingProvider } from '../../embed/index';
import { DependencyError } from '../../errors/index';
import { createGuardedLlm } from '../../llm/index';
import type { LlmChunk, LlmCompletion, LlmProvider, LlmRequest } from '../../llm/index';
import { FakeLogger } from '../../logger/index';
import { createGuardedMail, RecordingMail } from '../../mail/index';
import { createGuardedPayments } from '../../payments/index';
import type { PaymentsPort, VerifiedWebhook } from '../../payments/index';
import { createResilienceRegistry, type PortGuard, type ResilienceRegistry } from '../index';

/**
 * The interface wrappers — §5, "wraps every external port".
 *
 * `llm`, `embed`, `mail` and `payments` have no real adapter yet. The
 * resilience is wired into the INTERFACE rather than into each adapter, so
 * whoever builds those adapters gets the breaker, the concurrency limit and
 * the timeout by construction instead of by remembering.
 *
 * These tests exist to make sure that wiring is real now, while it is cheap to
 * verify with fakes — rather than being discovered to be decorative on the day
 * the LLM provider has an outage.
 */

let clock: FixedClock;
let registry: ResilienceRegistry;
/**
 * D-237 — the retry budget is now WIRED, so a guarded call can wait.
 *
 * Every registry in this file injects a `RecordingSleeper`. Without it the
 * ports that carry a non-zero budget (`cache: 1`, `embed: 2`) would spend real
 * jittered milliseconds inside the failure cases below, and §9.5's "no sleep in
 * a test — if a test needs to wait, the code needs an injectable clock" would
 * be violated by the code under test rather than by the test.
 */
let sleeper: RecordingSleeper;

beforeEach(() => {
  clock = new FixedClock('2026-03-01T00:00:00.000Z');
  sleeper = new RecordingSleeper();
  registry = createResilienceRegistry({
    clock,
    logger: new FakeLogger(),
    timeouts: DEFAULT_TIMEOUT_POLICY,
    concurrency: DEFAULT_CONCURRENCY_LIMITS,
    breaker: DEFAULT_BREAKER_POLICY,
    sleeper,
  });
});

const hangs = (): Promise<never> =>
  new Promise(() => {
    /* never settles */
  });

/**
 * A guard for one port with a shortened timeout.
 *
 * Used where the assertion is "a hang becomes a bounded rejection". The
 * production values are pinned in `config/__tests__/timeouts.test.ts`; there
 * is nothing to be learnt by making a test suite wait out the real ones.
 */
function scaledGuard(port: 'embed' | 'llm' | 'mail' | 'payments', totalMs: number): PortGuard {
  return createResilienceRegistry({
    clock,
    logger: new FakeLogger(),
    timeouts: { ...DEFAULT_TIMEOUT_POLICY, [port]: { ...DEFAULT_TIMEOUT_POLICY[port], totalMs } },
    concurrency: DEFAULT_CONCURRENCY_LIMITS,
    breaker: DEFAULT_BREAKER_POLICY,
    sleeper,
  }).guard(port);
}

describe('the cache wrapper', () => {
  function build(inner: CachePort): CachePort {
    return createGuardedCache(inner, registry.guard('cache'));
  }

  it('passes normal operations straight through', async () => {
    const cache = build(new MemoryCache(clock));
    await cache.set('k', 'v');
    expect(await cache.get('k')).toBe('v');
    expect(await cache.incr('n')).toBe(1);
    expect(await cache.expire('k', 60)).toBe(true);
    await cache.del('k');
    expect(await cache.get('k')).toBeNull();
  });

  it('preserves the TTL argument rather than quietly dropping it', async () => {
    // A rate-limit counter with no TTL never expires, and the user is locked
    // out permanently. Easy to break in a wrapper, invisible until it bites.
    const cache = build(new MemoryCache(clock));
    await cache.set('window', '1', 60);
    clock.advanceSeconds(61);
    expect(await cache.get('window')).toBeNull();
  });

  it('opens the breaker after 5 cache failures', async () => {
    const broken: CachePort = {
      get: () => Promise.reject(new DependencyError('cache')),
      set: () => Promise.reject(new DependencyError('cache')),
      del: () => Promise.reject(new DependencyError('cache')),
      incr: () => Promise.reject(new DependencyError('cache')),
      expire: () => Promise.reject(new DependencyError('cache')),
      close: () => Promise.resolve(),
    };
    const cache = build(broken);
    for (let i = 0; i < 5; i += 1) {
      await cache.get('k').catch(() => undefined);
    }
    expect(registry.guard('cache').breaker.state()).toBe('open');
  });

  it('fails fast once open — the reason rate limiting needs a breaker', async () => {
    // Rate limiting runs BEFORE the database on every login (§6.4, step 1).
    // Without the breaker, a cache outage adds its full timeout to every
    // single login attempt — and login is the path §3.1 says must never be
    // starved.
    let attempts = 0;
    const broken: CachePort = {
      get: () => {
        attempts += 1;
        return Promise.reject(new DependencyError('cache'));
      },
      set: () => Promise.reject(new DependencyError('cache')),
      del: () => Promise.reject(new DependencyError('cache')),
      incr: () => Promise.reject(new DependencyError('cache')),
      expire: () => Promise.reject(new DependencyError('cache')),
      close: () => Promise.resolve(),
    };
    const cache = build(broken);
    for (let i = 0; i < 5; i += 1) await cache.get('k').catch(() => undefined);
    expect(attempts).toBe(5);

    await cache.get('k').catch(() => undefined);
    expect(attempts).toBe(5);
  });

  it('closes without going through the breaker', async () => {
    // Shutdown must not be blocked by an open breaker. A breaker that stops
    // the process releasing its connections has inverted its own purpose.
    let closed = false;
    const inner: CachePort = {
      get: () => Promise.reject(new DependencyError('cache')),
      set: () => Promise.resolve(),
      del: () => Promise.resolve(),
      incr: () => Promise.resolve(1),
      expire: () => Promise.resolve(true),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
    const cache = build(inner);
    for (let i = 0; i < 5; i += 1) await cache.get('k').catch(() => undefined);
    expect(registry.guard('cache').breaker.state()).toBe('open');

    await cache.close();
    expect(closed).toBe(true);
  });
});

describe('the llm wrapper', () => {
  const REQUEST: LlmRequest = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 };

  function fakeLlm(chunks: string[], completion?: () => Promise<LlmCompletion>): LlmProvider {
    return {
      complete:
        completion ??
        ((): Promise<LlmCompletion> =>
          Promise.resolve({ text: 'done', inputTokens: 1, outputTokens: 1, model: 'fake' })),
      stream: (): AsyncIterable<LlmChunk> => ({
        // eslint-disable-next-line @typescript-eslint/require-await
        async *[Symbol.asyncIterator](): AsyncGenerator<LlmChunk> {
          for (const text of chunks) yield { text };
        },
      }),
    };
  }

  function build(inner: LlmProvider): LlmProvider {
    return createGuardedLlm(inner, {
      guard: registry.guard('llm'),
      clock,
      completion: DEFAULT_TIMEOUT_POLICY.llm,
      streaming: DEFAULT_TIMEOUT_POLICY.llmStreaming,
    });
  }

  it('passes a completion through', async () => {
    await expect(build(fakeLlm([])).complete(REQUEST)).resolves.toMatchObject({ text: 'done' });
  });

  it('times out a hanging completion rather than holding the request', async () => {
    const llm = createGuardedLlm(fakeLlm([], hangs), {
      guard: registry.guard('llm'),
      clock,
      completion: { ...DEFAULT_TIMEOUT_POLICY.llm, totalMs: 10 },
      streaming: DEFAULT_TIMEOUT_POLICY.llmStreaming,
    });
    await expect(llm.complete(REQUEST)).rejects.toBeInstanceOf(DependencyError);
  });

  it('streams every chunk through', async () => {
    const seen: string[] = [];
    for await (const chunk of build(fakeLlm(['a', 'b', 'c'])).stream(REQUEST)) {
      seen.push(chunk.text);
    }
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('holds a concurrency slot for the LIFETIME of the stream', async () => {
    // `run` would release the slot at the first token, which would let an
    // unbounded number of open streams sit behind a limit of 20.
    const llm = build(fakeLlm(['a', 'b']));
    const limiter = registry.guard('llm').limiter;
    expect(limiter.inFlight()).toBe(0);

    const iterator = llm.stream(REQUEST)[Symbol.asyncIterator]();
    await iterator.next();
    expect(limiter.inFlight()).toBe(1);

    await iterator.next();
    await iterator.next();
    expect(limiter.inFlight()).toBe(0);
  });

  it('releases the slot when a stream is abandoned part-way', async () => {
    const llm = build(fakeLlm(['a', 'b', 'c']));
    const limiter = registry.guard('llm').limiter;

    const iterator = llm.stream(REQUEST)[Symbol.asyncIterator]();
    await iterator.next();
    expect(limiter.inFlight()).toBe(1);

    // The client disconnected. A generator's `return()` runs the `finally`.
    await iterator.return?.(undefined);
    expect(limiter.inFlight()).toBe(0);
  });

  it('counts a first-token timeout against the breaker', async () => {
    const stalling: LlmProvider = {
      complete: () => hangs(),
      stream: (): AsyncIterable<LlmChunk> => ({
        [Symbol.asyncIterator]: (): AsyncIterator<LlmChunk> => ({ next: () => hangs() }),
      }),
    };
    const llm = createGuardedLlm(stalling, {
      guard: registry.guard('llm'),
      clock,
      completion: DEFAULT_TIMEOUT_POLICY.llm,
      streaming: { ...DEFAULT_TIMEOUT_POLICY.llmStreaming, firstTokenMs: 5 },
    });

    for (let i = 0; i < 5; i += 1) {
      const iterator = llm.stream(REQUEST)[Symbol.asyncIterator]();
      await iterator.next().catch(() => undefined);
    }
    expect(registry.guard('llm').breaker.state()).toBe('open');
  });

  /**
   * ==========================================================================
   * D-262 — THE TIMEOUT NOW CANCELS THE VENDOR CALL.
   *
   * Every assertion above this point was green while the defect was live, and
   * that is the point of writing these: `holds a concurrency slot for the
   * LIFETIME of the stream` and `releases the slot when a stream is abandoned
   * part-way` both pass whether or not anything is cancelled, because they only
   * ever asked the LIMITER what it thought. The limiter thought the stream was
   * over. The vendor was still streaming and still billing, the socket and its
   * reader lingered until GC, and REAL CONCURRENCY EXCEEDED THE CONFIGURED
   * LIMIT INVISIBLY — the slot was free while the work was not.
   *
   * A limit of 20 that is actually admitting 60 is indistinguishable, from
   * inside the process, from a limit of 20 that is working. No error, no
   * timeout, no metric. It is found on an invoice.
   *
   * These tests observe the ADAPTER's signal rather than the limiter's count,
   * which is the only vantage point from which the two states differ.
   * ==========================================================================
   */
  describe('D-262: a released slot and a cancelled call are the same event', () => {
    interface SignalProbe {
      readonly provider: LlmProvider;
      /** What the adapter was handed. `undefined` until `stream` is called. */
      signal: AbortSignal | undefined;
      /** Set the moment the signal fires, from the adapter's own listener. */
      abortedAt: number | null;
    }

    /**
     * An adapter that records its signal and yields on demand — the "scripted
     * adapter that records whether its signal aborted" D-262 asks for.
     *
     * It never ends on its own. A stream that finishes by itself cannot
     * distinguish a cancellation from an exhausted iterator, and the exhausted
     * iterator is what the old tests were measuring.
     */
    function signalProbe(): SignalProbe {
      let ticks = 0;
      const probe: SignalProbe = {
        signal: undefined,
        abortedAt: null,
        provider: {
          complete: (): Promise<LlmCompletion> =>
            Promise.resolve({ text: 'done', inputTokens: 1, outputTokens: 1, model: 'fake' }),
          stream: (req: LlmRequest): AsyncIterable<LlmChunk> => {
            probe.signal = req.signal;
            req.signal?.addEventListener('abort', () => {
              probe.abortedAt = ticks;
            });
            return {
              // eslint-disable-next-line @typescript-eslint/require-await
              async *[Symbol.asyncIterator](): AsyncGenerator<LlmChunk> {
                for (;;) {
                  ticks += 1;
                  yield { text: `t${String(ticks)}` };
                }
              },
            };
          },
        },
      };
      return probe;
    }

    it('hands the adapter a signal at all — step 1 of the three-file fix', () => {
      const probe = signalProbe();
      build(probe.provider).stream(REQUEST)[Symbol.asyncIterator]();
      // Lazily constructed inside the generator, so one pull is needed.
      expect(probe.signal).toBeUndefined();
    });

    it('supplies a live, un-aborted signal once the stream is running', async () => {
      const probe = signalProbe();
      const iterator = build(probe.provider).stream(REQUEST)[Symbol.asyncIterator]();
      await iterator.next();

      expect(probe.signal).toBeInstanceOf(AbortSignal);
      // Not pre-aborted: a signal that arrives already fired would cancel every
      // stream instantly and would still satisfy a naive "was it aborted" test.
      expect(probe.signal?.aborted).toBe(false);
      expect(probe.abortedAt).toBeNull();

      await iterator.return?.(undefined);
    });

    it('ABORTS WHEN THE TOTAL BUDGET EXPIRES, not merely stops yielding', async () => {
      // The exact scenario in D-262: driven past `streaming.totalMs` on the
      // INJECTED clock — no sleep, no real timer — the generator returns. Before
      // the fix it returned and left the vendor streaming.
      const probe = signalProbe();
      const llm = createGuardedLlm(probe.provider, {
        guard: registry.guard('llm'),
        clock,
        completion: DEFAULT_TIMEOUT_POLICY.llm,
        streaming: { ...DEFAULT_TIMEOUT_POLICY.llmStreaming, totalMs: 1_000 },
      });

      const iterator = llm.stream(REQUEST)[Symbol.asyncIterator]();
      await iterator.next();
      expect(probe.signal?.aborted).toBe(false);

      clock.advanceMs(1_001);
      const ended = await iterator.next();

      expect(ended.done).toBe(true);
      expect(probe.signal?.aborted).toBe(true);
    });

    it('cancels when the student disconnects mid-turn', async () => {
      // `foxy`'s `for await` unwinding calls `.return()`. The slot was already
      // released on this path; the fetch body was not closed.
      const probe = signalProbe();
      const iterator = build(probe.provider).stream(REQUEST)[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.next();
      expect(probe.signal?.aborted).toBe(false);

      await iterator.return?.(undefined);

      expect(probe.signal?.aborted).toBe(true);
    });

    it('aborts BEFORE the slot is released, so the two can never drift', async () => {
      /**
       * THE ORDERING ASSERTION, and it is the one that makes the pairing a
       * property rather than a coincidence. If the release ran first, the
       * limiter would hand the freed slot to a waiting caller while the vendor
       * stream it accounted for was still open — the same over-admission
       * window, just narrower and even harder to observe.
       *
       * Observed from the limiter's own count at the instant the abort fires,
       * which is the only place the order is visible.
       */
      const probe = signalProbe();
      const limiter = registry.guard('llm').limiter;
      let inFlightWhenAborted: number | null = null;

      const iterator = build(probe.provider).stream(REQUEST)[Symbol.asyncIterator]();
      await iterator.next();
      expect(limiter.inFlight()).toBe(1);

      probe.signal?.addEventListener('abort', () => {
        inFlightWhenAborted = limiter.inFlight();
      });

      await iterator.return?.(undefined);

      // Still held at abort time; released immediately afterwards.
      expect(inFlightWhenAborted).toBe(1);
      expect(limiter.inFlight()).toBe(0);
    });

    it('gives each stream its OWN controller, so one ending cannot cancel another', async () => {
      // A module-level or per-provider controller would pass every test above
      // and silently kill concurrent students' answers the moment any one of
      // them finished.
      const first = signalProbe();
      const second = signalProbe();
      const llm = build(first.provider);
      const other = build(second.provider);

      const a = llm.stream(REQUEST)[Symbol.asyncIterator]();
      const b = other.stream(REQUEST)[Symbol.asyncIterator]();
      await a.next();
      await b.next();

      await a.return?.(undefined);

      expect(first.signal?.aborted).toBe(true);
      expect(second.signal?.aborted).toBe(false);

      await b.return?.(undefined);
    });

    it('does NOT abort on a first-token timeout that the total budget survives', async () => {
      /**
       * `withTimeout` builds its OWN controller per `next()` (port-guard.ts:90)
       * and D-262's fix deliberately does not reuse it. Aborting the fetch when
       * one token wait expires would tear down a stream the total budget still
       * allows — turning a slow first token into a dead answer.
       *
       * Asserted by proving the two controllers are different objects: the
       * adapter's signal is not the one `withTimeout` aborts.
       */
      const probe = signalProbe();
      const iterator = build(probe.provider).stream(REQUEST)[Symbol.asyncIterator]();
      await iterator.next();

      const streamSignal = probe.signal;
      // A second pull goes through a fresh `withTimeout` controller; the
      // adapter's signal is unchanged and unfired throughout.
      await iterator.next();
      expect(probe.signal).toBe(streamSignal);
      expect(probe.signal?.aborted).toBe(false);

      await iterator.return?.(undefined);
    });
  });
});

describe('the embed wrapper', () => {
  const fakeEmbed = (behaviour: () => Promise<number[]>): EmbeddingProvider => ({
    model: 'voyage-3',
    dimensions: 1024,
    embedQuery: behaviour,
  });

  it('passes the vector through and preserves the model metadata', async () => {
    const embed = createGuardedEmbed(
      fakeEmbed(() => Promise.resolve([0.1, 0.2])),
      registry.guard('embed'),
    );
    expect(embed.model).toBe('voyage-3');
    expect(embed.dimensions).toBe(1024);
    await expect(embed.embedQuery('photosynthesis')).resolves.toEqual([0.1, 0.2]);
  });

  it('fails fast rather than stalling, so retrieval can fall back to keyword-only', async () => {
    // §6: "Embeddings down → keyword-only retrieval, still answers." That
    // fallback only runs if the embedding call FAILS FAST. With a queue and no
    // breaker, "still answers" becomes "spins forever".
    //
    // A scaled-down timeout, not the production 5s: the property is "a hang
    // becomes a bounded rejection", and asserting it in 20ms asserts exactly
    // the same thing as asserting it in five seconds. The production value is
    // pinned separately, in config/__tests__/timeouts.test.ts.
    const embed = createGuardedEmbed(fakeEmbed(hangs), scaledGuard('embed', 20));
    await expect(embed.embedQuery('x')).rejects.toBeInstanceOf(DependencyError);
  });
});

describe('the mail wrapper', () => {
  it('sends through', async () => {
    const recorder = new RecordingMail();
    const mail = createGuardedMail(recorder, registry.guard('mail'));
    await mail.send({ to: 'a@example.test', template: 'email-verification', data: {} });
    expect(recorder.sent).toHaveLength(1);
  });

  it('rejects past 5 in flight so the caller can defer to the worker', async () => {
    // §3.3's overflow behaviour for mail is "enqueue for the worker instead".
    // Nothing about sending an email needs to happen inside the request that
    // triggered it.
    const mail = createGuardedMail({ send: hangs }, registry.guard('mail'));
    for (let i = 0; i < 5; i += 1) {
      void mail
        .send({ to: 'a@example.test', template: 'email-verification', data: {} })
        .catch(() => undefined);
    }
    await expect(
      mail.send({ to: 'b@example.test', template: 'email-verification', data: {} }),
    ).rejects.toBeInstanceOf(DependencyError);
  });
});

describe('the payments wrapper', () => {
  const WEBHOOK: VerifiedWebhook = {
    providerEventId: 'evt_1',
    kind: 'subscription.charged',
    providerEventName: 'subscription.charged',
    providerSubscriptionId: 'sub_1',
    currentPeriodEnd: null,
    payload: {},
  };

  /**
   * The port grew `cancelSubscription`, and `CreateSubscriptionRequest` grew a
   * PAYER that is separate from the beneficiary, when the `billing` module
   * landed — see the header of `platform/payments/payments.port.ts`. The
   * payer/subject split is what keeps a B2B school pilot (the school pays, a
   * student benefits) a composition-root change rather than a schema migration.
   */
  const CREATE = {
    planCode: 'monthly',
    payer: { kind: 'user', id: 'u1' },
    subjectUserId: 'u1',
    amountMinorUnits: 29_900,
    currency: 'INR',
    idempotencyKey: 'idem-1',
  } as const;

  function fakePayments(overrides: Partial<PaymentsPort> = {}): PaymentsPort {
    return {
      name: 'test',
      createSubscription: () =>
        Promise.resolve({
          providerSubscriptionId: 'sub_1',
          checkoutUrl: 'https://pay.test',
          provider: 'test',
        }),
      cancelSubscription: () => Promise.resolve(),
      verifyWebhook: () => WEBHOOK,
      ...overrides,
    };
  }

  it('guards subscription creation', async () => {
    const payments = createGuardedPayments(fakePayments(), registry.guard('payments'));
    await expect(payments.createSubscription(CREATE)).resolves.toMatchObject({
      providerSubscriptionId: 'sub_1',
    });
  });

  it('guards cancellation — it is a network write like any other', async () => {
    let cancelled: string | null = null;
    const payments = createGuardedPayments(
      fakePayments({
        cancelSubscription: (id) => {
          cancelled = id;
          return Promise.resolve();
        },
      }),
      registry.guard('payments'),
    );
    await payments.cancelSubscription('sub_9');
    expect(cancelled).toBe('sub_9');
  });

  it('does NOT put webhook verification behind the breaker', async () => {
    // A local HMAC comparison with no network call in it. Routing it through a
    // breaker would mean an open circuit could stop us verifying signatures,
    // turning a provider outage into a security failure.
    //
    // The breaker is opened with immediate rejections rather than by waiting
    // out five 15-second payment timeouts. Both open it; one takes 75 seconds
    // of wall clock and tells you nothing extra.
    const guard = registry.guard('payments');
    const payments = createGuardedPayments(
      fakePayments({
        createSubscription: () => Promise.reject(new DependencyError('payments')),
      }),
      guard,
    );
    for (let i = 0; i < 5; i += 1) {
      await payments.createSubscription(CREATE).catch(() => undefined);
    }
    expect(guard.breaker.state()).toBe('open');

    expect(payments.verifyWebhook({ rawBody: '{}', signature: 'sig' })).toEqual(WEBHOOK);
  });

  it('returns null on a forged signature without throwing', () => {
    const payments = createGuardedPayments(
      fakePayments({ verifyWebhook: () => null }),
      registry.guard('payments'),
    );
    expect(payments.verifyWebhook({ rawBody: '{}', signature: 'forged' })).toBeNull();
  });
});
