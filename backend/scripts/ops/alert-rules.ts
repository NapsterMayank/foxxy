/**
 * ALERT RULES — 04-RESILIENCE-PLAN.md §5.
 *
 * =============================================================================
 * THE GAP THIS CLOSES.
 *
 * §5 ends with: "Every state transition is logged at `warn` and emitted as a
 * metric. A BREAKER THAT OPENS WITHOUT ANYONE KNOWING IS A SILENT OUTAGE."
 *
 * `platform/metrics` closed the first half of that — the metric now lands in
 * `metrics_events` instead of a no-op sink. But the second half was still open:
 * the row is WRITTEN and nothing READS it. A breaker that opens, rejects four
 * thousand calls for twenty minutes and closes again produces a perfect audit
 * trail that nobody looks at. That is not observability, it is archaeology.
 *
 * This file is the rules. `alert-evaluator.ts` reads the signals and delivers.
 *
 * =============================================================================
 * PURE ON PURPOSE.
 *
 * Nothing here touches the database, the clock, the network or the dispatcher.
 * `evaluate()` is (rules, signals, now) -> alerts. That is what makes every
 * threshold, every severity and every cooldown testable without a container,
 * and it is the same split the `practice` module uses for its domain rules.
 *
 * =============================================================================
 * PAGE versus TICKET — the split is the whole point of a severity field.
 *
 *   PAGE    a human is woken up. Reserved for: the product is down, is about to
 *           be down, or is quietly doing the wrong thing (a security control
 *           that has silently degraded). If it can wait until the morning it is
 *           not a page.
 *
 *   TICKET  filed, visible, actioned in working hours. Everything that is
 *           degraded-but-serving, and everything that is a trend rather than an
 *           event.
 *
 * The distinction has to be explicit and it has to be conservative, because
 * both mistakes are expensive and only one of them is visible: paging on
 * everything trains people to ignore the pager, and after that a real outage
 * arrives as a notification somebody swipes away at 3am.
 */

import type { BilingualText } from '../../src/platform/notify-channel/index';

/** Who this reaches, and when. */
export type AlertSeverity = 'page' | 'ticket';

export type Comparison = 'gte' | 'lte';

/**
 * A signal is one number over one evaluation window.
 *
 * Deliberately flat `Record<string, number>` rather than a rich metric type:
 * a rule that can only compare a number against a threshold is a rule that can
 * be read at 3am. Anything needing more expressiveness than this is asking for
 * a query language, and a query language in an alerting config is how alerting
 * configs become unreviewable.
 */
export type Signals = Readonly<Record<string, number>>;

export interface AlertRule {
  /** Stable identifier. Used for cooldown keying and in the notification data. */
  readonly id: string;
  /** Which signal this rule watches. */
  readonly signal: string;
  readonly comparison: Comparison;
  readonly threshold: number;
  readonly severity: AlertSeverity;
  /**
   * Minimum gap between two deliveries of the SAME rule, in seconds.
   *
   * Not a nicety. A breaker flapping every 30 seconds emits a transition metric
   * every 30 seconds; without a cooldown the on-call phone receives 120 pages an
   * hour and the incident becomes "the pager", not "the dependency".
   */
  readonly cooldownSeconds: number;
  readonly title: BilingualText;
  /** `{value}` and `{threshold}` are substituted. Both languages, P7. */
  readonly body: BilingualText;
  /** One line an operator can act on. Points at the runbook section. */
  readonly runbook: string;
}

export interface Alert {
  readonly ruleId: string;
  readonly severity: AlertSeverity;
  readonly signal: string;
  readonly value: number;
  readonly threshold: number;
  readonly title: BilingualText;
  readonly body: BilingualText;
  readonly runbook: string;
  readonly firedAt: Date;
}

/**
 * The signal names the evaluator produces. Constants, not literals at the rule
 * site, because a typo yields a rule that watches a signal nobody emits — which
 * looks EXACTLY like a healthy system, forever. That failure mode has already
 * occurred five times in this codebase in other guises.
 *
 * `alert-evaluator.ts` builds its signal map from these same constants, and
 * `assertRulesAreSatisfiable()` below refuses a rule naming anything else.
 */
export const SIGNALS = {
  /** §5 — breaker transitions INTO `open`, counted over the window. */
  BREAKER_OPENED: 'breaker.opened',
  /** D-034 — authentication rate limiting has silently degraded to per-instance. */
  RATE_LIMIT_FALLBACK: 'rate_limit.fallback',
  /** A job exhausted every attempt. `PLATFORM_METRICS.JOB_DEAD`. */
  JOB_DEAD_LETTERED: 'job.dead_lettered',
  /** 1 when `/health/ready` is not returning 200, else 0. */
  READINESS_FAILING: 'readiness.failing',
  /** Fraction of `max_connections` in use, 0..1. §2 F4. */
  DB_POOL_SATURATION: 'db.pool_saturation',
  /**
   * Dependency errors over the window: port timeouts + breaker rejections +
   * concurrency rejections.
   *
   * NOT an HTTP 5xx rate, and the difference is stated because somebody will
   * look for one. Nothing emits a per-request metric, deliberately — the
   * `metrics_events` header is explicit that a row per request is the one thing
   * that would make a table the wrong sink. So the error rate that IS available
   * is the one measured at the ports, which is also the one that moves first:
   * dependency errors precede user-visible failures.
   */
  DEPENDENCY_ERRORS: 'dependency.errors',
  /** Seconds since the newest worker heartbeat. §3.2. */
  WORKER_HEARTBEAT_AGE_SECONDS: 'worker.heartbeat_age_seconds',
  /** Hours since the newest completed base backup. §7. */
  BACKUP_AGE_HOURS: 'backup.age_hours',
  /**
   * Notification DELIVERIES that failed, per channel, over the window.
   *
   * NOT "notifications that reached nobody on any channel", which is the thing
   * an operator actually wants and which does not exist as a metric. The
   * dispatcher logs that case at `error` (`notify.undeliverable`) and emits no
   * counter for it, so a rule watching it would never fire. Recorded as a gap
   * rather than papered over with a rule that watches nothing — see D-146.
   */
  NOTIFY_FAILED: 'notify.failed',
} as const;

export type SignalName = (typeof SIGNALS)[keyof typeof SIGNALS];

/**
 * THE RULES.
 *
 * Ordered by severity then by how early the signal moves, so the file reads
 * top-down as "what wakes someone up" followed by "what gets filed".
 */
export const ALERT_RULES: readonly AlertRule[] = [
  // ===========================================================================
  // PAGE — a human, now.
  // ===========================================================================
  {
    id: 'readiness_failing',
    signal: SIGNALS.READINESS_FAILING,
    comparison: 'gte',
    threshold: 1,
    severity: 'page',
    // Short: readiness failing means the load balancer has already stopped
    // routing. There is no such thing as too many reminders that the product is
    // down, and it self-silences the moment it recovers.
    cooldownSeconds: 300,
    title: {
      en: 'API readiness failing',
      hi: 'API रेडीनेस विफल',
    },
    body: {
      en: '/health/ready is not returning 200. The load balancer has stopped routing traffic to this instance. The process is NOT restarted by this condition (§8).',
      hi: '/health/ready 200 नहीं लौटा रहा है। लोड बैलेंसर ने इस इंस्टेंस पर ट्रैफ़िक भेजना बंद कर दिया है। इस स्थिति में प्रोसेस पुनः आरंभ नहीं होती (§8)।',
    },
    runbook: 'docs/runbooks/incident-response.md#readiness-failing',
  },
  {
    id: 'db_pool_saturated',
    signal: SIGNALS.DB_POOL_SATURATION,
    comparison: 'gte',
    threshold: 0.9,
    severity: 'page',
    cooldownSeconds: 600,
    title: {
      en: 'Database connections near exhaustion',
      hi: 'डेटाबेस कनेक्शन समाप्ति के करीब',
    },
    body: {
      en: '{value} of max_connections is in use (threshold {threshold}). §2 F4: a saturated pool is the most common way a healthy application looks completely down. Find the long-running query before adding connections.',
      hi: 'max_connections का {value} उपयोग में है (सीमा {threshold})। §2 F4: संतृप्त पूल वह सबसे सामान्य तरीका है जिससे स्वस्थ ऐप्लिकेशन पूरी तरह बंद दिखती है। कनेक्शन बढ़ाने से पहले लंबी चलने वाली क्वेरी खोजें।',
    },
    runbook: 'docs/runbooks/incident-response.md#database-pool-saturated',
  },
  {
    id: 'breaker_opened',
    signal: SIGNALS.BREAKER_OPENED,
    comparison: 'gte',
    threshold: 1,
    severity: 'page',
    // 15 minutes: long enough that a flapping dependency does not become a
    // flapping pager, short enough that a breaker still open after a quarter of
    // an hour says so again.
    cooldownSeconds: 900,
    title: {
      en: 'Circuit breaker opened',
      hi: 'सर्किट ब्रेकर खुला',
    },
    body: {
      en: '{value} breaker transition(s) into OPEN in the window. Calls to that dependency are now rejected without a network attempt. Check /health/deps for which port, and the degradation matrix (§6) for what the user sees.',
      hi: 'विंडो में {value} ब्रेकर OPEN हुए। उस डिपेंडेंसी की कॉल अब बिना नेटवर्क प्रयास के अस्वीकृत हैं। कौन-सा पोर्ट है यह /health/deps पर देखें, और उपयोगकर्ता को क्या दिखेगा यह डिग्रेडेशन मैट्रिक्स (§6) में।',
    },
    runbook: 'docs/runbooks/incident-response.md#circuit-breaker-open',
  },
  {
    id: 'rate_limit_fallback',
    signal: SIGNALS.RATE_LIMIT_FALLBACK,
    comparison: 'gte',
    threshold: 1,
    severity: 'page',
    cooldownSeconds: 900,
    // PAGE, not ticket, and the reason is worth stating because the product is
    // still up and it is tempting to file it. D-034: "a silent fallback is a
    // silent SECURITY DOWNGRADE — the whole point is that somebody finds out."
    // Authentication rate limiting has become per-instance and weaker; the
    // window in which credential stuffing is cheapest is open right now.
    title: {
      en: 'Rate limiting degraded to in-process',
      hi: 'रेट लिमिटिंग घटकर इन-प्रोसेस हो गई',
    },
    body: {
      en: 'The cache is unavailable, so authentication rate limits are per-instance and weaker ({value} activation(s)). Login still works — that is the deliberate trade (D-034) — but brute-force protection is reduced until the cache returns.',
      hi: 'कैश उपलब्ध नहीं है, इसलिए प्रमाणीकरण रेट लिमिट प्रति-इंस्टेंस और कमज़ोर हैं ({value} बार सक्रिय)। लॉगिन अब भी काम करता है — यह जानबूझकर किया गया समझौता है (D-034) — पर कैश लौटने तक ब्रूट-फ़ोर्स सुरक्षा घटी हुई है।',
    },
    runbook: 'docs/runbooks/incident-response.md#rate-limit-fallback',
  },
  {
    id: 'worker_heartbeat_stale',
    signal: SIGNALS.WORKER_HEARTBEAT_AGE_SECONDS,
    comparison: 'gte',
    threshold: 300,
    severity: 'page',
    cooldownSeconds: 1800,
    title: {
      en: 'Worker heartbeat stale',
      hi: 'वर्कर हार्टबीट पुरानी',
    },
    body: {
      en: 'No worker has written a heartbeat for {value}s (threshold {threshold}s). The worker has no HTTP surface, so this row is its only liveness signal (§3.2). Jobs are not running: digests, retention nudges and the session sweeper are all stopped.',
      hi: 'किसी वर्कर ने {value} सेकंड से हार्टबीट नहीं लिखी (सीमा {threshold} सेकंड)। वर्कर का कोई HTTP सर्फ़ेस नहीं है, इसलिए यही उसकी एकमात्र लाइवनेस सूचना है (§3.2)। जॉब्स नहीं चल रहे: डाइजेस्ट, रिटेंशन नज और सेशन स्वीपर सब रुके हैं।',
    },
    runbook: 'docs/runbooks/incident-response.md#worker-heartbeat-stale',
  },
  {
    id: 'backup_stale',
    signal: SIGNALS.BACKUP_AGE_HOURS,
    comparison: 'gte',
    threshold: 36,
    severity: 'page',
    cooldownSeconds: 21_600,
    // 36 hours, not 24: one missed nightly run is a fault, and paging on the
    // first late minute would fire on every clock skew and every slow backup.
    // Two consecutive misses is a real loss of recovery point, and PAGES —
    // because the cost of finding out during a restore is unbounded.
    title: {
      en: 'No recent database backup',
      hi: 'हाल का कोई डेटाबेस बैकअप नहीं',
    },
    body: {
      en: 'The newest completed base backup is {value}h old (threshold {threshold}h). Continuous WAL archiving may still be running, but the recovery point is now bounded by an old base. §7: a backup that has never been restored is not a backup — and one that never ran is not even that.',
      hi: 'नवीनतम पूर्ण बेस बैकअप {value} घंटे पुराना है (सीमा {threshold} घंटे)। WAL आर्काइविंग शायद अब भी चल रही हो, पर रिकवरी पॉइंट अब पुराने बेस से बंधा है। §7: जिस बैकअप को कभी पुनर्स्थापित नहीं किया गया वह बैकअप नहीं है — और जो कभी चला ही नहीं वह उससे भी कम है।',
    },
    runbook: 'docs/runbooks/backup-restore.md#nightly-backup-missing',
  },
  {
    id: 'dependency_error_rate_high',
    signal: SIGNALS.DEPENDENCY_ERRORS,
    comparison: 'gte',
    threshold: 50,
    severity: 'page',
    cooldownSeconds: 900,
    title: {
      en: 'Dependency error rate high',
      hi: 'डिपेंडेंसी त्रुटि दर उच्च',
    },
    body: {
      en: '{value} dependency errors in the window (threshold {threshold}) — port timeouts, breaker rejections and concurrency rejections combined. This moves BEFORE user-visible failures do.',
      hi: 'विंडो में {value} डिपेंडेंसी त्रुटियाँ (सीमा {threshold}) — पोर्ट टाइमआउट, ब्रेकर अस्वीकृतियाँ और कंकरेंसी अस्वीकृतियाँ मिलाकर। यह उपयोगकर्ता को दिखने वाली विफलताओं से पहले बढ़ती है।',
    },
    runbook: 'docs/runbooks/incident-response.md#dependency-error-rate',
  },

  // ===========================================================================
  // TICKET — filed, visible, handled in working hours.
  // ===========================================================================
  {
    id: 'job_dead_lettered',
    signal: SIGNALS.JOB_DEAD_LETTERED,
    comparison: 'gte',
    threshold: 1,
    severity: 'ticket',
    cooldownSeconds: 3600,
    // TICKET at one, PAGE at ten (the rule below). One dead job is a bug in one
    // job; ten is the queue failing. §6 rule 3 — "never lose written work" —
    // holds either way: the row is still there and can be replayed.
    title: {
      en: 'Background job dead-lettered',
      hi: 'बैकग्राउंड जॉब डेड-लेटर हुआ',
    },
    body: {
      en: '{value} job(s) exhausted every attempt in the window. The work is not lost — the row remains and can be replayed — but it has not happened.',
      hi: 'विंडो में {value} जॉब ने सभी प्रयास समाप्त कर दिए। काम खोया नहीं है — पंक्ति मौजूद है और दोबारा चलाई जा सकती है — पर वह हुआ नहीं है।',
    },
    runbook: 'docs/runbooks/incident-response.md#job-dead-lettered',
  },
  {
    id: 'job_dead_letter_storm',
    signal: SIGNALS.JOB_DEAD_LETTERED,
    comparison: 'gte',
    threshold: 10,
    severity: 'page',
    cooldownSeconds: 1800,
    title: {
      en: 'Background jobs failing en masse',
      hi: 'बैकग्राउंड जॉब्स सामूहिक रूप से विफल',
    },
    body: {
      en: '{value} jobs dead-lettered in the window (threshold {threshold}). This is the queue failing, not one job. Stop the worker before the retry storm compounds it.',
      hi: 'विंडो में {value} जॉब डेड-लेटर हुए (सीमा {threshold})। यह एक जॉब नहीं, पूरी क्यू की विफलता है। रीट्राई स्टॉर्म बढ़ने से पहले वर्कर रोकें।',
    },
    runbook: 'docs/runbooks/incident-response.md#job-dead-lettered',
  },
  {
    id: 'dependency_errors_elevated',
    signal: SIGNALS.DEPENDENCY_ERRORS,
    comparison: 'gte',
    threshold: 10,
    severity: 'ticket',
    cooldownSeconds: 3600,
    title: {
      en: 'Dependency errors elevated',
      hi: 'डिपेंडेंसी त्रुटियाँ बढ़ी हुई',
    },
    body: {
      en: '{value} dependency errors in the window (threshold {threshold}). Below the paging threshold, but above normal. Usually a dependency getting slower rather than failing.',
      hi: 'विंडो में {value} डिपेंडेंसी त्रुटियाँ (सीमा {threshold})। पेजिंग सीमा से नीचे, पर सामान्य से ऊपर। आमतौर पर कोई डिपेंडेंसी विफल नहीं, धीमी हो रही होती है।',
    },
    runbook: 'docs/runbooks/incident-response.md#dependency-error-rate',
  },
  {
    id: 'notify_delivery_failing',
    signal: SIGNALS.NOTIFY_FAILED,
    comparison: 'gte',
    threshold: 5,
    severity: 'ticket',
    cooldownSeconds: 3600,
    title: {
      en: 'Notification deliveries failing',
      hi: 'सूचना डिलीवरी विफल हो रही है',
    },
    body: {
      en: '{value} channel deliveries failed in the window (threshold {threshold}). Per CHANNEL, not per notification — the in-app fallback may still have landed. If the in-app channel is among them the cause is usually the database refusing the row: a foreign key to a deleted user, or a missing tenant.',
      hi: 'विंडो में {value} चैनल डिलीवरी विफल हुईं (सीमा {threshold})। यह प्रति चैनल है, प्रति सूचना नहीं — इन-ऐप फ़ॉलबैक फिर भी पहुँचा हो सकता है। यदि इन-ऐप भी विफल है तो कारण आमतौर पर डेटाबेस द्वारा पंक्ति अस्वीकृति है: हटाए गए उपयोगकर्ता की फ़ॉरेन की, या अनुपस्थित टेनेंट।',
    },
    runbook: 'docs/runbooks/incident-response.md#notifications-failing',
  },
];

/**
 * Refuses a rule that watches a signal nothing produces.
 *
 * A rule pointing at a misspelled signal never fires, and a rule that never
 * fires is indistinguishable from a system that is never unhealthy. This
 * codebase has found that exact shape five times — an ESLint rule matching zero
 * files, a limiter hooked where no actor exists, a metrics sink wired to a
 * no-op, a harness applying one migration of nine, a `SET LOCAL` outside a
 * transaction. Alerting is the worst place for the sixth.
 *
 * Called at evaluator START-UP, not lazily, so a bad rule fails the process
 * rather than being discovered during the incident it was written for.
 */
export function assertRulesAreSatisfiable(
  rules: readonly AlertRule[],
  producedSignals: readonly string[],
): void {
  const known = new Set(producedSignals);
  const orphans = rules.filter((rule) => !known.has(rule.signal));
  if (orphans.length > 0) {
    const detail = orphans.map((rule) => `${rule.id} -> '${rule.signal}'`).join(', ');
    throw new Error(
      `alert rules watch signals that nothing produces: ${detail}. ` +
        `Known signals: ${[...known].sort().join(', ')}. ` +
        `A rule on an unknown signal can never fire, which looks exactly like a healthy system.`,
    );
  }
}

/** `{value}` / `{threshold}` substitution, in both languages. */
function render(text: BilingualText, value: number, threshold: number): BilingualText {
  const substitute = (source: string): string =>
    source.replaceAll('{value}', formatNumber(value)).replaceAll('{threshold}', formatNumber(threshold));
  return { en: substitute(text.en), hi: substitute(text.hi) };
}

/** Integers stay integers; fractions get two places. `0.9333` reads badly. */
function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * The evaluation itself.
 *
 * A signal that is ABSENT never fires a rule. That is deliberate and it is the
 * opposite of the obvious alternative (treat missing as zero): a missing signal
 * means the evaluator could not measure it, and inventing a zero would turn
 * "the database is unreachable so I cannot count breaker transitions" into
 * "there were no breaker transitions" — a reassuring answer produced by the
 * failure it is supposed to detect.
 *
 * Un-measurable signals are surfaced separately by the evaluator, at `error`.
 */
export function evaluate(
  rules: readonly AlertRule[],
  signals: Signals,
  now: Date,
): readonly Alert[] {
  const fired: Alert[] = [];

  for (const rule of rules) {
    const value = signals[rule.signal];
    if (value === undefined) continue;

    const breached =
      rule.comparison === 'gte' ? value >= rule.threshold : value <= rule.threshold;
    if (!breached) continue;

    fired.push({
      ruleId: rule.id,
      severity: rule.severity,
      signal: rule.signal,
      value,
      threshold: rule.threshold,
      title: rule.title,
      body: render(rule.body, value, rule.threshold),
      runbook: rule.runbook,
      firedAt: now,
    });
  }

  return fired;
}

/**
 * Per-rule cooldown.
 *
 * IN MEMORY, and that is a decision rather than an omission. The alternatives
 * are a table (a migration, for state that is worthless after a restart) or the
 * cache (a dependency whose failure is itself one of the things being alerted
 * on — an alerter that goes quiet when the cache dies is the exact failure mode
 * §5 is about).
 *
 * The cost is that a restart of the evaluator re-pages anything still breached.
 * That is the right direction to fail: a duplicate page is an annoyance, a
 * suppressed one is an outage nobody heard about.
 */
export class CooldownLedger {
  private readonly lastSentAt = new Map<string, number>();

  /** True when the rule may be delivered now; records the delivery if so. */
  shouldDeliver(rule: AlertRule, now: Date): boolean {
    const previous = this.lastSentAt.get(rule.id);
    const nowMs = now.getTime();
    if (previous !== undefined && nowMs - previous < rule.cooldownSeconds * 1000) {
      return false;
    }
    this.lastSentAt.set(rule.id, nowMs);
    return true;
  }

  /** Clears the cooldown for a rule whose signal has returned to healthy. */
  clear(ruleId: string): void {
    this.lastSentAt.delete(ruleId);
  }

  /** For tests and for the `--once` report. */
  suppressedCount(): number {
    return this.lastSentAt.size;
  }
}
