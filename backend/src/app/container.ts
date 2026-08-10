import { createPostgresAudit, type AuditPort } from '../platform/audit/index';
import { createAccessGuard, type AccessGuard } from '../platform/authz/index';
import {
  MemoryCache,
  createGuardedCache,
  createValkeyCache,
  type CachePort,
} from '../platform/cache/index';
import { createSystemClock, type Clock } from '../platform/clock/index';
import type { Config } from '../platform/config/index';
import {
  createDatabaseProbe,
  createDbPools,
  poolFor,
  type DatabaseProbe,
  type DbPools,
  type ModuleName,
  type NamedDbHandle,
} from '../platform/db/index';
import {
  createDeterministicEmbed,
  createGuardedEmbed,
  createVoyageEmbed,
  type EmbeddingProvider,
} from '../platform/embed/index';
import { createHttpClient, type HttpClient } from '../platform/http/index';
import { createUuidGen, type IdGen } from '../platform/id-gen/index';
import { createPostgresJobQueue, type JobQueue } from '../platform/jobs/index';
import {
  createAnthropicLlm,
  createFakeLlm,
  createGuardedLlm,
  type LlmProvider,
} from '../platform/llm/index';
import { createLogger, type Logger } from '../platform/logger/index';
import { createConsoleMail, createGuardedMail, type MailPort } from '../platform/mail/index';
import {
  MemoryMetrics,
  createPostgresMetricsSink,
  type MetricSnapshot,
  type MetricsPort,
} from '../platform/metrics/index';
import {
  createEmailChannel,
  createInAppChannel,
  createNotificationDispatcher,
  createPushChannel,
  createWhatsAppChannel,
  type Channel,
  type ChannelName,
  type ChannelPolicy,
  type NotificationDispatcher,
} from '../platform/notify-channel/index';
import {
  createFakePayments,
  createGuardedPayments,
  createRazorpayPayments,
  type PaymentsPort,
} from '../platform/payments/index';
import { createResilienceRegistry, type ResilienceRegistry } from '../platform/resilience/index';
import { toChannelPolicy } from '../modules/notify/index';

/**
 * The composition root.
 *
 * This is the ONLY place adapters are chosen. Everything downstream receives
 * an interface and cannot tell which implementation it has — which is what
 * makes swapping a vendor a one-file change and makes tests need no mocking
 * library.
 *
 * It is also the only place the resilience machinery is assembled. Every
 * external port leaves this file already wrapped in its concurrency limit,
 * its circuit breaker and its timeout (04-RESILIENCE-PLAN.md §3.3, §4, §5),
 * so no downstream caller can hold an unguarded port — not because they were
 * told not to, but because one is never handed out.
 */
export interface Container {
  readonly config: Config;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly idGen: IdGen;
  /**
   * The four bulkheaded pools (§3.1). A module receives the pool it is
   * assigned: identity gets `auth`, ordinary modules get `core`, retrieval and
   * foxy get `ai`, background jobs get `worker`.
   */
  readonly pools: DbPools;
  /**
   * The pool a given module's repositories must receive (§3.1, and the table
   * in `platform/db/module-pools.ts`).
   *
   * THIS REPLACES THE OLD `container.db` ALIAS — resolves D-030.
   *
   * `db` pointed at `pools.auth`, which was correct while identity was the
   * only module: it delivered identity its bulkhead without editing identity.
   * D-030 recorded that it "will become misleading the moment a second module
   * lands", and `learner` and `content` are that moment. A property called
   * `db` reads as "the database", so the second module to be written would
   * have taken it, and every learner query would then have been competing for
   * the ten connections reserved for login. The bulkhead would have looked
   * fully wired and been silently gone.
   *
   * There is no general-purpose handle any more. Asking for a pool means
   * naming which module is asking.
   */
  poolFor(module: ModuleName): NamedDbHandle;
  readonly cache: CachePort;
  readonly http: HttpClient;
  readonly mail: MailPort;
  /**
   * THE QUERY-EMBEDDING PORT — plan §8.4, and the one adapter choice in this
   * file that can be wrong without anything failing.
   *
   * Voyage when a key is configured, the deterministic fake otherwise, and
   * `createContainer` REFUSES TO BOOT in production without a key rather than
   * quietly taking the fake. The two providers are interchangeable to the type
   * system and produce vectors in completely unrelated spaces: the corpus's
   * 4,666 chunks were embedded by `voyage-3`, so a query embedded by the fake
   * lands nowhere near them and cosine distance becomes arithmetic that still
   * succeeds and no longer means anything. Every search would return confident,
   * wrong chunks — with no error, no timeout and no metric to notice it by.
   *
   * Always guarded, so no caller can hold a bare adapter (§3.3, §4, §5).
   */
  readonly embed: EmbeddingProvider;
  /**
   * THE LANGUAGE-MODEL PORT — plan §8.5, and the same "wrong without anything
   * failing" hazard as `embed` above.
   *
   * The real adapter when a key is configured, the deterministic scripted fake
   * otherwise, and `createContainer` REFUSES TO BOOT in production without a
   * key rather than quietly taking the fake. The two are interchangeable to the
   * type system, and a production deployment on the fake would serve every
   * student the same canned sentence — with citations, over SSE, through a UI
   * that shows no error at all.
   *
   * Always guarded, so no caller can hold a bare adapter (§3.3, §4, §5). The
   * guard carries BOTH timeout rules: 30s for a completion, and 8s to the first
   * token with a 60s total and no retry for a stream.
   */
  readonly llm: LlmProvider;
  /**
   * THE PAYMENT-GATEWAY PORT — plan §8.8, and the THIRD adapter choice in this
   * file that can be wrong without anything failing. It is also the worst of
   * the three.
   *
   * Razorpay when credentials are configured, the deterministic fake otherwise,
   * and `createContainer` REFUSES TO BOOT in production without them rather
   * than quietly taking the fake. `embed` on the fake returns wrong answers and
   * `llm` on the fake returns one canned sentence; `payments` on the fake
   * happily CREATES SUBSCRIPTIONS and happily VERIFIES WEBHOOKS SIGNED WITH A
   * SECRET WE CHOSE. Entitlements would be granted against payments that never
   * happened — no error, no failed request, and a revenue hole that is only
   * discovered by reconciling a bank statement.
   *
   * Always guarded, so no caller can hold a bare adapter (§3.3, §4, §5). Note
   * that `verifyWebhook` passes THROUGH the guard rather than into it: it is
   * pure HMAC with no I/O, and putting a breaker in front of it would let an
   * unrelated Razorpay outage start rejecting genuine deliveries.
   */
  readonly payments: PaymentsPort;
  readonly authz: AccessGuard;
  readonly resilience: ResilienceRegistry;
  readonly databaseProbe: DatabaseProbe;
  /**
   * WHERE EVERY RESILIENCE SIGNAL GOES — 04-RESILIENCE-PLAN.md §5.
   *
   * Built FIRST, before the resilience registry, because the registry needs it:
   * breaker transitions, breaker rejections, concurrency rejections and port
   * timeouts are all wired from here. Until this existed, §5's "emitted as a
   * metric" ended at `createNoopBreakerMetrics()`.
   */
  readonly metrics: MetricsPort;
  /** The live process's own counters — the body of `/health/deps`. */
  metricsSnapshot(): readonly MetricSnapshot[];
  /** The append-only record of privileged actions. Never throws. */
  readonly audit: AuditPort;
  /** Fans a message out over the channels its kind is configured for. */
  readonly notify: NotificationDispatcher;
  /**
   * Every channel adapter, keyed by name. TOTAL over `ChannelName`.
   *
   * Exposed so the `notify` module can call the IN-APP adapter directly, which
   * it must: the in-app row is the durable record, written synchronously in the
   * request, and putting it through the dispatcher alongside the remote
   * channels would give the worker a second chance to write it. See the header
   * of `modules/notify/domain/kinds.ts`.
   */
  readonly channels: Readonly<Record<ChannelName, Channel>>;
  /**
   * The job queue, ON THE `worker` POOL (§3.1).
   *
   * The API process ENQUEUES onto it — `notify.send` posts a delivery job — and
   * never claims from it. An enqueue is one indexed INSERT and the pool choice
   * is what keeps even that off the connections reserved for request traffic.
   */
  readonly jobQueue: JobQueue;
  shutdown(): Promise<void>;
}

export interface ContainerOverrides {
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly idGen?: IdGen;
  readonly cache?: CachePort;
  readonly mail?: MailPort;
  readonly audit?: AuditPort;
  /**
   * Substitute embedding provider.
   *
   * An integration test that wants stable, reproducible rankings supplies the
   * deterministic provider explicitly rather than relying on the absence of a
   * key — "no key was set" and "this test wants the fake" are different facts,
   * and only one of them should survive somebody adding a key to their shell.
   */
  readonly embed?: EmbeddingProvider;
  /**
   * Substitute language-model provider.
   *
   * Supplied explicitly by every test that exercises Foxy, rather than relying
   * on the absence of a key — "no key was set" and "this test wants the scripted
   * fake" are different facts, and only one of them should survive somebody
   * adding a key to their shell.
   */
  readonly llm?: LlmProvider;
  /**
   * Substitute payment gateway.
   *
   * Supplied explicitly by every test that exercises billing, rather than
   * relying on the absence of credentials — "no key was set" and "this test
   * wants the deterministic fake" are different facts, and only one of them
   * should survive somebody adding a key to their shell. A test that wants to
   * SIGN a delivery needs the concrete `FakePayments` anyway, so it has to pass
   * its own instance in regardless.
   */
  readonly payments?: PaymentsPort;
  /**
   * Channel routing by message kind.
   *
   * NOW OWNED BY THE `notify` MODULE, which is what the default below says:
   * `toChannelPolicy()` is notify's routing table (`domain/kinds.ts`) in the
   * shape the dispatcher takes. `platform/` still holds only the fan-out
   * MECHANISM and takes the POLICY as data, so quiet hours and frequency caps
   * live in the module and never leak into `platform/`.
   *
   * Overridable so a test can route a kind somewhere else without editing the
   * product's table.
   */
  readonly channelPolicy?: ChannelPolicy;
  /**
   * Substitute channel adapters, merged over the real map.
   *
   * The seam that proves the Phase 2 claim: a test registers a working fake
   * where `whatsapp` currently throws, adds one row to the policy, and a
   * notification is delivered over it WITHOUT A LINE CHANGING in the notify
   * service. If that ever stops being possible, "adding a channel is one
   * adapter" has quietly become false.
   */
  readonly channels?: Partial<Record<ChannelName, Channel>>;
}

export function createContainer(config: Config, overrides: ContainerOverrides = {}): Container {
  const logger = overrides.logger ?? createLogger({ level: config.log.level, env: config.env });
  const clock = overrides.clock ?? createSystemClock();
  const idGen = overrides.idGen ?? createUuidGen();

  const pools = createDbPools({
    url: config.db.url,
    ssl: config.db.ssl,
    sizes: config.db.pools,
    statementTimeoutMs: config.timeouts.postgres.totalMs,
    vectorStatementTimeoutMs: config.timeouts.postgresVector.totalMs,
    connectTimeoutMs: config.timeouts.postgres.connectMs,
    hnswEfSearch: config.db.hnswEfSearch,
  });

  /**
   * METRICS, BUILT BEFORE THE RESILIENCE REGISTRY — and the ordering is the
   * point of this block.
   *
   * The registry wires four §5/§4/§3.3 emissions from a `MetricsPort`, so the
   * port has to exist first. Before it did, `createResilienceRegistry` fell
   * back to `createNoopBreakerMetrics()` and the second half of §5 — "a breaker
   * that opens without anyone knowing is a silent outage" — was unimplemented.
   *
   * TWO SINKS, TEE'D, because they answer different questions:
   *
   *   MEMORY    "what is happening in this process right now" — the body of
   *             `/health/deps`. Reading it from Postgres would mean the
   *             endpoint that tells you the database is unreachable needs the
   *             database.
   *   POSTGRES  "what happened last Tuesday" — buffered, written on the
   *             `worker` pool so metric writes never compete with a request,
   *             and dropped-with-a-warning on failure so a broken
   *             observability path cannot break the mechanism it observes.
   *
   * The tee is `MemoryMetrics`'s `onRecord` hook rather than a wrapper class:
   * one object, one scrub, no chance of the two sinks disagreeing about what
   * was recorded.
   */
  const metricsSink = createPostgresMetricsSink({
    // §3.1 — the `worker` pool. Bookkeeping, never request traffic.
    db: pools.worker,
    clock,
    logger,
  });
  const metrics = new MemoryMetrics({
    clock,
    onRecord: (event) => {
      metricsSink.record(event);
    },
  });

  // One breaker per dependency for the whole process. Built after metrics,
  // because every breaker transition now goes somewhere.
  const resilience = createResilienceRegistry({
    clock,
    logger,
    timeouts: config.timeouts,
    concurrency: config.concurrency,
    breaker: config.breaker,
    metrics,
  });

  const rawCache = overrides.cache ?? createValkeyCache({ url: config.cache.url });
  const cache = createGuardedCache(rawCache, resilience.guard('cache'));

  const http = createHttpClient({
    timeoutMs: config.http.timeoutMs,
    maxRetries: config.http.maxRetries,
    guard: resilience.guard('http'),
  });

  // Resend adapter lands with the identity module (build step 4). Until then
  // the dev adapter prints to stdout, so signup works with no API key.
  const mail = createGuardedMail(overrides.mail ?? createConsoleMail(), resilience.guard('mail'));

  /**
   * THE EMBEDDING ADAPTER CHOICE — see `Container.embed`.
   *
   * The production check is a BOOT FAILURE rather than a warning on purpose.
   * The degraded mode it prevents is not "slower" or "fewer results"; it is
   * "every answer is grounded in passages selected at random, and looks
   * exactly like an answer that was grounded properly". A warn line in a log
   * nobody reads is not a defence against a failure with no symptom.
   */
  if (config.isProduction && overrides.embed === undefined && config.ai.voyageApiKey === null) {
    throw new Error(
      'VOYAGE_API_KEY is required in production. Without it the deterministic ' +
        'embedding fake would be used, and every retrieval query would be embedded ' +
        'into a vector space unrelated to the corpus — returning confident, wrong ' +
        'chunks with no error. Set VOYAGE_API_KEY, or run with NODE_ENV=development.',
    );
  }
  const embed = createGuardedEmbed(
    overrides.embed ??
      (config.ai.voyageApiKey === null
        ? createDeterministicEmbed()
        : createVoyageEmbed({ http, apiKey: config.ai.voyageApiKey })),
    resilience.guard('embed'),
  );

  /**
   * THE LANGUAGE-MODEL ADAPTER CHOICE — see `Container.llm`.
   *
   * A BOOT FAILURE rather than a warning, for the same reason as `embed`: the
   * degraded mode is not "slower" or "shorter answers", it is "every student
   * receives the same scripted sentence and the system reports itself healthy".
   * A warn line in a log nobody reads is not a defence against a failure with
   * no symptom.
   */
  if (config.isProduction && overrides.llm === undefined && config.ai.llmApiKey === null) {
    throw new Error(
      'LLM_API_KEY is required in production. Without it the deterministic scripted ' +
        'fake would be used, and every Foxy answer would be the same canned sentence — ' +
        'streamed, cited and indistinguishable from a working tutor. Set LLM_API_KEY, ' +
        'or run with NODE_ENV=development.',
    );
  }
  const llm = createGuardedLlm(
    overrides.llm ??
      (config.ai.llmApiKey === null
        ? createFakeLlm()
        : createAnthropicLlm({
            http,
            apiKey: config.ai.llmApiKey,
            ...(config.ai.llmModel === null ? {} : { model: config.ai.llmModel }),
            ...(config.ai.llmBaseUrl === null ? {} : { baseUrl: config.ai.llmBaseUrl }),
          })),
    {
      guard: resilience.guard('llm'),
      clock,
      completion: config.timeouts.llm,
      streaming: config.timeouts.llmStreaming,
    },
  );

  /**
   * THE PAYMENT ADAPTER CHOICE — see `Container.payments`.
   *
   * A BOOT FAILURE rather than a warning, for the same reason as `embed` and
   * `llm`, and with more at stake than either. All THREE credentials are
   * required together, and the check names which one is missing: the webhook
   * secret is a SEPARATE secret from the API key, set per endpoint in the
   * Razorpay dashboard, and supplying the API secret in its place is a common
   * misconfiguration whose only symptom is that every genuine delivery fails
   * its signature check while checkout keeps working.
   *
   * `RAZORPAY_PLAN_IDS` is deliberately NOT in the boot check. An empty map is
   * a loud failure at checkout time — `createSubscription` refuses a plan code
   * it cannot map — whereas missing credentials are a SILENT fallback to a fake
   * that grants entitlements for free. Only the silent one needs a boot gate.
   */
  const paymentsMissing =
    config.payments.razorpayKeyId === null
      ? 'RAZORPAY_KEY_ID'
      : config.payments.razorpayKeySecret === null
        ? 'RAZORPAY_KEY_SECRET'
        : config.payments.razorpayWebhookSecret === null
          ? 'RAZORPAY_WEBHOOK_SECRET'
          : null;

  /**
   * The three credentials as ONE value that is either wholly present or null.
   *
   * Narrowed here rather than at the call site so that the adapter is
   * constructed from strings the compiler has proved non-null. The tempting
   * `?? ''` at each field would be a credential that PARSES and then reaches
   * Razorpay — precisely the "a fake key that parses is exactly the thing that
   * would then reach Razorpay" hazard the config schema's own header calls out.
   */
  const razorpayCredentials =
    config.payments.razorpayKeyId !== null &&
    config.payments.razorpayKeySecret !== null &&
    config.payments.razorpayWebhookSecret !== null
      ? {
          keyId: config.payments.razorpayKeyId,
          keySecret: config.payments.razorpayKeySecret,
          webhookSecret: config.payments.razorpayWebhookSecret,
        }
      : null;

  if (config.isProduction && overrides.payments === undefined && paymentsMissing !== null) {
    throw new Error(
      `${paymentsMissing} is required in production. Without the Razorpay credentials the ` +
        'deterministic payments fake would be used, and it happily creates subscriptions and ' +
        'happily verifies webhooks signed with a secret we chose — granting entitlements ' +
        'against payments that never happened, with no error anywhere. Set RAZORPAY_KEY_ID, ' +
        'RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET, or run with NODE_ENV=development.',
    );
  }

  const payments = createGuardedPayments(
    overrides.payments ??
      (razorpayCredentials === null
        ? createFakePayments({
            /**
             * A FIXED, OBVIOUSLY-FAKE SECRET, and it never reaches production —
             * the boot check above has already thrown by the time this line can
             * run there. Fixed rather than random so that a developer can sign
             * a delivery by hand against a documented value; obviously fake so
             * that finding it in a log or a heap dump prompts the right
             * question.
             */
            secret: 'dev-only-not-a-real-webhook-secret',
            // The catalogue's purchasable codes, so the fake refuses an unknown
            // one exactly as Razorpay does rather than selling anything asked
            // for. Local, because `platform/` may not import a module.
            planCodes: ['monthly', 'yearly'],
          })
        : createRazorpayPayments({
            http,
            ...razorpayCredentials,
            planIds: config.payments.razorpayPlanIds,
          })),
    resilience.guard('payments'),
  );

  // The link reader is wired to the identity repository in build step 4.
  // Until that module exists the guard denies every parent-child read, which
  // is the correct posture for a boundary that has no data source yet.
  const authz = createAccessGuard({
    readLinkStatus: () => null,
  });

  /**
   * AUDIT, ON THE `auth` POOL.
   *
   * Every privileged action that exists today is an identity action — password
   * reset, logout-all, link approve, link revoke — and §3.1 assigns identity to
   * `auth`. Keeping the audit write in the SAME bulkhead as the operation it
   * records means that if `auth` is exhausted the action was not going to
   * happen anyway, so the audit write failing with it costs nothing that was
   * not already lost.
   *
   * `worker` was considered and rejected: an audit row written from a different
   * pool can outlive a rolled-back action, and a record of something that did
   * not happen is a worse failure than a missing record of something that did.
   */
  const audit =
    overrides.audit ?? createPostgresAudit({ db: pools.auth, clock, logger, metrics });

  /**
   * THE NOTIFICATION CHANNELS — 05-ROADMAP.md §8, row 2.
   *
   * The map is TOTAL over `ChannelName`, including the two that are not
   * implemented. That totality is the entire reason `whatsapp` and `push` have
   * adapters at all: a partial map makes "this channel does not exist" a second
   * failure mode for every call site to handle, alongside "this channel
   * failed". With every name resolving to a `Channel`, the dispatcher has one
   * failure path — and asking for WhatsApp today produces a loud, typed
   * `DependencyError` instead of an `undefined`.
   */
  const channels: Readonly<Record<ChannelName, Channel>> = {
    email: createEmailChannel({ mail }),
    // §3.1: the in-app channel writes a row for a user, which is ordinary
    // request-shaped traffic, so `core` rather than `worker`.
    'in-app': createInAppChannel({ db: pools.core, clock }),
    whatsapp: createWhatsAppChannel(),
    push: createPushChannel(),
    // Overrides LAST, so a test that supplies a working `whatsapp` gets it and
    // one that supplies nothing still gets the loud unimplemented adapter.
    ...overrides.channels,
  };

  const notify = createNotificationDispatcher({
    channels,
    // THE `notify` MODULE'S TABLE. Build step 14 landed, so the placeholder
    // empty policy is gone: `toChannelPolicy()` is `domain/kinds.ts` in the
    // shape the dispatcher takes, and adding WhatsApp to a kind is a row edit
    // there rather than anything in this file.
    policy: overrides.channelPolicy ?? toChannelPolicy(),
    logger,
    metrics,
  });

  /**
   * §3.1 — the `worker` pool, in BOTH processes and for different reasons.
   *
   * The worker claims from it, which is by definition background work. The API
   * only ever ENQUEUES onto it, and putting even that one INSERT on `core`
   * would mean a queue write competing with the request that caused it.
   */
  const jobQueue = createPostgresJobQueue({ db: pools.worker });

  return {
    config,
    logger,
    clock,
    idGen,
    pools,
    poolFor(module: ModuleName): NamedDbHandle {
      return poolFor(pools, module);
    },
    cache,
    http,
    mail,
    embed,
    llm,
    payments,
    authz,
    resilience,
    metrics,
    metricsSnapshot(): readonly MetricSnapshot[] {
      return metrics.snapshot();
    },
    audit,
    notify,
    channels,
    jobQueue,
    databaseProbe: createDatabaseProbe(pools, config.timeouts.postgres.totalMs),
    async shutdown(): Promise<void> {
      // FLUSH FIRST, AND SEQUENTIALLY. The ordering is load-bearing rather
      // than tidy: buffered observations need a live connection to be written,
      // so putting the flush in the same `allSettled` as `pools.close()` would
      // race them — and the observations most likely to be lost are the ones
      // emitted in the seconds before a shutdown, which are the ones an
      // incident review wants.
      //
      // `flush` swallows its own failures, so this cannot throw and cannot
      // prevent the pools closing.
      await metricsSink.flush();
      // `allSettled`: a cache that is already gone must not stop the pools
      // being closed. Shutdown is not the place to be strict.
      await Promise.allSettled([pools.close(), cache.close()]);
    },
  };
}

/** Convenience for tests: everything faked except the pieces a test names. */
export function createTestContainer(config: Config, overrides: ContainerOverrides = {}): Container {
  const clock = overrides.clock ?? createSystemClock();
  return createContainer(config, {
    ...overrides,
    clock,
    cache: overrides.cache ?? new MemoryCache(clock),
  });
}
