/**
 * platform/metrics — 04-RESILIENCE-PLAN.md §5.
 *
 * ===========================================================================
 * WHY THIS EXISTS, IN ONE SENTENCE FROM §5:
 *
 *   "Every state transition is logged at `warn` and emitted as a metric.
 *    A BREAKER THAT OPENS WITHOUT ANYONE KNOWING IS A SILENT OUTAGE."
 *
 * Half of that was true. Transitions were logged. The metric went to
 * `createNoopBreakerMetrics()`, whose own comment admitted it: "observability
 * sink lands with the metrics port". There was no metrics port. So the second
 * half of the sentence was decoration, and the failure it describes — a
 * dependency that has been dead for an hour with nothing but a `warn` line in a
 * log nobody is tailing — was live.
 *
 * The same was true of `identity.rate_limit.in_process_fallback`, which is the
 * signal that AUTHENTICATION HAS SILENTLY DEGRADED to a per-instance limiter.
 * D-034 is explicit that "a silent fallback is a silent security downgrade —
 * the whole point is that somebody finds out". It emitted to a `MetricsSink`
 * interface whose only implementation was `NO_METRICS`.
 *
 * ===========================================================================
 * THREE INSTRUMENT TYPES, AND WHY EXACTLY THREE.
 *
 *   counter    monotonic, "how many times". Breaker transitions, rejections,
 *              timeouts, fallback activations.
 *   gauge      a level at a point in time, "how many right now". In-flight
 *              calls, queue depth, pool saturation.
 *   histogram  a distribution, "how long / how big". Latencies.
 *
 * These are the three the entire industry converged on, so an adapter for any
 * real backend is mechanical. Adding a fourth would make every future adapter
 * a translation problem.
 *
 * ===========================================================================
 * FIRE AND FORGET — `void`, NOT `Promise<void>`. This is deliberate.
 *
 * If recording a metric could fail or could be awaited, then every call site
 * has to decide what to do when observability is broken — and the honest answer
 * is always "nothing, carry on". Worse, an awaited metric puts the metrics
 * backend on the critical path of the request it is measuring, which means an
 * outage in the thing that TELLS you about outages becomes an outage.
 *
 * So `counter`/`gauge`/`histogram` return `void`, adapters buffer internally,
 * and a write failure is logged and dropped. The Postgres adapter's `flush()`
 * is the one awaitable operation, and only shutdown calls it.
 *
 * ===========================================================================
 * NO PII IN TAGS, ENFORCED RATHER THAN REQUESTED.
 *
 * Every adapter scrubs tags through `platform/pii`. A tag is a LOW-CARDINALITY
 * LABEL — 'cache', 'open', 'timeout'. Putting a user id or an email in one is
 * simultaneously a privacy breach and a cardinality explosion that will take
 * the metrics store down, and those two failures arrive together.
 */

export type MetricKind = 'counter' | 'gauge' | 'histogram';

/** Tags are a flat string map. Anything richer belongs in a log line. */
export type MetricTags = Readonly<Record<string, string>>;

export interface MetricsPort {
  /**
   * Increments a counter. `value` defaults to 1 — the overwhelmingly common
   * case is "this happened once", and making the caller write it every time is
   * noise that hides the calls where the value matters.
   */
  counter(name: string, value?: number, tags?: MetricTags): void;
  /** Records a level at a point in time. */
  gauge(name: string, value: number, tags?: MetricTags): void;
  /** Records one observation of a distribution. */
  histogram(name: string, value: number, tags?: MetricTags): void;
}

/** One recorded observation, as every adapter sees it. */
export interface MetricEvent {
  readonly name: string;
  readonly kind: MetricKind;
  readonly value: number;
  readonly tags: MetricTags;
  readonly at: Date;
}

/**
 * The aggregate a snapshot reports.
 *
 * Counters carry a running total; gauges carry the latest value; histograms
 * carry count/min/max/sum, which is enough to compute a mean and to see an
 * outlier. Percentiles need the full distribution and belong in a real backend
 * — offering an approximate p95 from this would be a number people trusted.
 */
export interface MetricSnapshot {
  readonly name: string;
  readonly kind: MetricKind;
  readonly tags: MetricTags;
  readonly count: number;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly sum: number;
  readonly lastAt: string;
}

/**
 * A metrics port that can also be read back.
 *
 * `/health/deps` needs a snapshot, and so does every test. Keeping it off
 * `MetricsPort` itself means a write-only adapter (a real backend, which
 * cannot be read back cheaply) still satisfies the port that call sites depend
 * on.
 */
export interface ReadableMetricsPort extends MetricsPort {
  snapshot(): readonly MetricSnapshot[];
  reset(): void;
}

/**
 * The metric names emitted by `platform/` itself.
 *
 * Constants rather than string literals at the call site, because a metric name
 * is an API: dashboards and alerts are written against it, and a typo produces
 * a metric that is silently never emitted — which looks exactly like the
 * healthy case.
 */
export const PLATFORM_METRICS = {
  /** §5 — a circuit breaker changed state. Tags: port, from, to. */
  BREAKER_TRANSITION: 'platform.breaker.transition',
  /** §5 — a call was rejected by an OPEN breaker, with no network attempt. */
  BREAKER_REJECTED: 'platform.breaker.rejected',
  /** §3.3 — a call was rejected because the port was at its concurrency limit. */
  CONCURRENCY_REJECTED: 'platform.concurrency.rejected',
  /** §4 — an outbound call exceeded its timeout. */
  PORT_TIMEOUT: 'platform.port.timeout',
  /**
   * §5 — A GUARDED CALL FAILED FAST. Tags: port.
   *
   * =========================================================================
   * THE OUTAGE SHAPE THAT WAS INVISIBLE, AND IT IS THE COMMONEST ONE.
   *
   * Until this counter existed, the only dependency failures anything could
   * see were the three the GUARD itself raises — a timeout, a breaker
   * rejection, a concurrency rejection. Every one of those is the guard
   * refusing or abandoning a call.
   *
   * A call that the DEPENDENCY refuses — connection refused, DNS failure, TLS
   * handshake reset, an HTTP 500 an adapter turns into a throw — emits none of
   * them. It fails in five milliseconds, well inside its timeout, and the
   * breaker files the failure internally and says nothing until it transitions
   * at five. So an embedding provider that is completely down, or a payments
   * host that refuses four checkouts and recovers, produced literally zero
   * rows in `metrics_events`, and `dependency.errors` could only ever count
   * timeouts and post-open rejections.
   *
   * That is the ordinary shape of an outage: things fail FAST, not slow.
   *
   * =========================================================================
   * DISJOINT FROM THE OTHER THREE, ON PURPOSE.
   *
   * This counts ONLY failures that are not already counted — see
   * `createPortFailureBridge`, which classifies structurally and declines to
   * emit for a timeout, a breaker rejection or a concurrency rejection. That
   * disjointness is what lets the alert collector SUM all four into
   * `dependency.errors` without inventing traffic that did not happen. A
   * double-counted error rate is worse than a missing one: it is a threshold
   * everybody quietly stops trusting.
   */
  PORT_CALL_FAILED: 'platform.port.call_failed',
  /**
   * §4 — a guarded call was RETRIED against its `TimeoutRule.retries` budget
   * (D-237). Tags: port, attempt.
   *
   * The budget was unwired for the whole life of the codebase, so a retry has
   * never been observable. It needs to be for the same reason a timeout does:
   * a dependency that succeeds on the second attempt every time is a dependency
   * that is failing every time, and from the outside it looks perfect. This is
   * the counter that separates "healthy" from "healthy at double the cost".
   */
  PORT_RETRIED: 'platform.port.retried',
  /**
   * §6 — a degradation path was taken: the product is still working, but not
   * the way it is supposed to. Tags: `path`.
   */
  DEGRADATION_ACTIVATED: 'platform.degradation.activated',
  /** A job finished. Tags: kind, outcome. */
  JOB_COMPLETED: 'platform.job.completed',
  /** A job was retried after a transient failure. Tags: kind. */
  JOB_RETRIED: 'platform.job.retried',
  /** A job exhausted its attempts. Tags: kind. THIS ONE DESERVES AN ALERT. */
  JOB_DEAD: 'platform.job.dead',
  /** A stuck `running` job was returned to the queue by the reaper. */
  JOB_RECLAIMED: 'platform.job.reclaimed',
  /**
   * A worker finished a job it no longer held the lease on — D-233. Tags:
   * kind, outcome.
   *
   * The completion was REFUSED, which is the correct outcome and is why this is
   * not an error. Non-zero means the lock timeout is shorter than this kind of
   * job actually takes, so the handler is running twice on every occurrence.
   * Before the fence existed these writes landed, and the job's final state
   * could flip to the loser's answer.
   */
  JOB_LEASE_LOST: 'platform.job.lease_lost',
  /** A notification was delivered. Tags: channel, kind. */
  NOTIFY_SENT: 'platform.notify.sent',
  /** A notification could not be delivered. Tags: channel, kind. */
  NOTIFY_FAILED: 'platform.notify.failed',
  /**
   * A NOTIFICATION REACHED NOBODY ON ANY CHANNEL — D-146, finally closed.
   * Tags: kind.
   *
   * =========================================================================
   * WHY `NOTIFY_FAILED` WAS NOT ALREADY THIS.
   *
   * `NOTIFY_FAILED` counts DELIVERIES, per channel. So a single notification
   * that failed on email AND on in-app increments it twice, and is arithmetically
   * indistinguishable from two notifications that each failed on one channel
   * while their other channel landed. The first case is somebody who was never
   * told something the system decided they needed to know; the second is a
   * degraded provider and a working product.
   *
   * The dispatcher has always DETECTED the first case — it logs
   * `notify.undeliverable` at `error` — and emitted no counter for it, so no
   * alert rule could watch it. D-146 recorded that as a known gap rather than
   * papering over it with a rule watching a signal nothing produces. This is the
   * counter that gap was waiting for.
   *
   * KIND ONLY, NEVER THE RECIPIENT. A tag is a low-cardinality label; a user id
   * or an address in one is simultaneously a privacy breach and a cardinality
   * explosion.
   */
  NOTIFY_UNDELIVERABLE: 'platform.notify.undeliverable',
  /**
   * Something PII-shaped was scrubbed on its way into a permanent record.
   * Non-zero means a module has a defect that needs fixing at the source —
   * the scrub is the safety net, not the design.
   */
  PII_SCRUBBED: 'platform.pii.scrubbed',
} as const;

/**
 * The port that does nothing.
 *
 * Explicit and named, so that choosing to discard metrics is a visible decision
 * at a composition root rather than the default that happens when nobody wires
 * anything. That distinction is exactly what went wrong with
 * `createNoopBreakerMetrics()`.
 */
export function createNoopMetrics(): MetricsPort {
  return {
    counter(): void {
      /* discarded, deliberately */
    },
    gauge(): void {
      /* discarded, deliberately */
    },
    histogram(): void {
      /* discarded, deliberately */
    },
  };
}
