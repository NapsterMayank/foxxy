/**
 * THE ALERT EVALUATOR — one cycle: collect, evaluate, deliver.
 *
 * =============================================================================
 * DELIVERY GOES THROUGH THE EXISTING `notify-channel` PORT. There is no second
 * notification path, and there must never be one.
 *
 * The tempting shortcut is a webhook POST straight to Slack from here. It is
 * fifteen lines and it is wrong: within a year the product has two notification
 * systems with two retry policies, two failure logs, two sets of credentials
 * and two definitions of "delivered", and the operational one — the one used
 * during incidents — is the untested one.
 *
 * Using the port instead means alerts inherit, for free: per-channel failure
 * isolation (a dead mail provider still writes the in-app row), the both-
 * languages type requirement (P7), PII scrubbing on the payload, and the
 * delivery metrics. Adding a real pager later is one adapter behind `Channel`,
 * not a parallel system.
 *
 * =============================================================================
 * SEVERITY IS EXPRESSED AS THE MESSAGE KIND, and the CHANNEL POLICY is what
 * turns it into "who gets woken up".
 *
 *   ops.alert.page    -> email + in-app   a human, now
 *   ops.alert.ticket  -> in-app only      filed, seen in working hours
 *
 * The policy lives in ONE map below, so "what pages a human" is a four-line
 * diff that a reviewer can see, rather than a boolean threaded through the
 * delivery code.
 *
 * Note that `in-app` is in BOTH lists. The dispatcher refuses to let anyone opt
 * out of it, deliberately, and the effect here is that an alert always leaves a
 * durable record even when every outbound channel is down — which, during an
 * infrastructure incident, is the likely case.
 */

import type { Clock } from '../clock/index';
import type { Logger } from '../logger/index';
import type {
  BilingualText,
  ChannelPolicy,
  ChannelRecipient,
  NotificationDispatcher,
} from '../notify-channel/index';
import type { Alert, AlertRule, Signals } from './alert-rules';
import { ALERT_RULES, CooldownLedger, evaluate } from './alert-rules';

export const ALERT_KIND_PAGE = 'ops.alert.page';
export const ALERT_KIND_TICKET = 'ops.alert.ticket';

/**
 * WHAT PAGES A HUMAN, in one place.
 *
 * `email` first, `in-app` second: the dispatcher fans out in order, and the
 * durable record should be written even if the mail provider is the thing that
 * is broken — which the dispatcher guarantees by catching per channel.
 */
export const ALERT_CHANNEL_POLICY: ChannelPolicy = {
  [ALERT_KIND_PAGE]: ['email', 'in-app'],
  [ALERT_KIND_TICKET]: ['in-app'],
};

export interface AlertEvaluatorOptions {
  readonly dispatcher: NotificationDispatcher;
  readonly recipient: ChannelRecipient;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly rules?: readonly AlertRule[];
  readonly cooldowns?: CooldownLedger;
}

export interface CycleResult {
  readonly evaluated: number;
  readonly fired: number;
  readonly delivered: number;
  readonly suppressed: number;
  readonly undeliverable: number;
}

export interface AlertEvaluator {
  runCycle(signals: Signals): Promise<CycleResult>;
}

/**
 * THE RUNBOOK PATH, INTO THE BODY, IN BOTH LANGUAGES.
 *
 * =============================================================================
 * IT WAS BEING LOST BETWEEN THIS FILE AND THE INBOX.
 *
 * `deliver()` puts `runbook` in `ChannelMessage.data`, which is right and stays.
 * But `email-channel.ts` maps only `kind`, `title`, `body` and `language` onto
 * the mail template — `MailPort.data` is `Record<string, string>` and the
 * channel deliberately does not widen it. So every field in `data` except those
 * four is dropped on the floor, and the on-call email arrived carrying the
 * sentence "check the runbook" and no runbook.
 *
 * At 3am the difference between a page with a path in it and a page without one
 * is several minutes of somebody grepping `docs/runbooks/` on a phone. The
 * runbook line is the single most actionable thing in the message and it was the
 * one part that did not survive delivery.
 *
 * =============================================================================
 * FIXED IN THE BODY RATHER THAN IN THE CHANNEL, ON PURPOSE.
 *
 * The channel-side fix is to give `mail` a real `ops-alert` template with its own
 * fields — which is the correct end state, is a change to a file this work does
 * not own, and is reported rather than done. Appending to the body here needs
 * nothing from anybody: it survives EVERY channel (email, in-app, and whatever
 * pager adapter lands later) because it is part of the message rather than part
 * of a payload each channel decides whether to render.
 *
 * `data.runbook` stays as well. It is the machine-readable copy, and the in-app
 * row keeps it.
 */
export function withRunbookLine(body: BilingualText, runbook: string): BilingualText {
  return {
    en: `${body.en}\n\nRunbook: ${runbook}`,
    hi: `${body.hi}\n\nरनबुक: ${runbook}`,
  };
}

export function createAlertEvaluator(options: AlertEvaluatorOptions): AlertEvaluator {
  const { dispatcher, recipient, logger, clock } = options;
  const rules = options.rules ?? ALERT_RULES;
  const cooldowns = options.cooldowns ?? new CooldownLedger();
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));

  async function deliver(alert: Alert): Promise<boolean> {
    const kind = alert.severity === 'page' ? ALERT_KIND_PAGE : ALERT_KIND_TICKET;

    const outcome = await dispatcher.send(recipient, {
      kind,
      title: alert.title,
      // The runbook path travels IN THE BODY, because `data` does not survive
      // the email channel. See `withRunbookLine`.
      body: withRunbookLine(alert.body, alert.runbook),
      // IDENTIFIERS AND COUNTS ONLY. P13, and the same rule the in-app channel
      // scrubs against on the way into the database. An alert payload is a
      // tempting place to attach "the affected user" and that is precisely how
      // a user id lands in a table with a weaker access model than the one it
      // came from. Nothing here identifies a person — an alert is about the
      // SYSTEM.
      data: {
        ruleId: alert.ruleId,
        severity: alert.severity,
        signal: alert.signal,
        value: alert.value,
        threshold: alert.threshold,
        runbook: alert.runbook,
        firedAt: alert.firedAt.toISOString(),
      },
    });

    if (!outcome.delivered) {
      // The alerting system failed to alert. Logged at `error` with the rule
      // that could not be delivered, because this is the one failure that
      // cannot be reported by the mechanism it broke.
      logger.error(
        {
          event: 'alerts.undeliverable',
          ruleId: alert.ruleId,
          severity: alert.severity,
          channels: outcome.results.map((result) => result.channel),
        },
        'AN ALERT REACHED NOBODY. The condition it describes is still true.',
      );
    }
    return outcome.delivered;
  }

  return {
    async runCycle(signals: Signals): Promise<CycleResult> {
      const now = clock.now();
      const fired = evaluate(rules, signals, now);
      const firedIds = new Set(fired.map((alert) => alert.ruleId));

      // A rule whose signal has returned to healthy has its cooldown cleared, so
      // a condition that recurs after recovering alerts IMMEDIATELY rather than
      // waiting out a cooldown started by the previous, already-resolved
      // occurrence. Without this, a dependency failing every ten minutes with a
      // fifteen-minute cooldown reports one incident an hour.
      for (const rule of rules) {
        if (!firedIds.has(rule.id)) cooldowns.clear(rule.id);
      }

      let delivered = 0;
      let suppressed = 0;
      let undeliverable = 0;

      for (const alert of fired) {
        const rule = rulesById.get(alert.ruleId);
        if (rule === undefined) continue;

        if (!cooldowns.shouldDeliver(rule, now)) {
          suppressed += 1;
          logger.info(
            { event: 'alerts.suppressed', ruleId: alert.ruleId, cooldownSeconds: rule.cooldownSeconds },
            'alert still breached but within its cooldown',
          );
          continue;
        }

        // `warn` for a ticket, `error` for a page. The log line exists whether
        // or not delivery succeeds, so the record of what fired survives an
        // outage of every channel.
        const line = {
          event: 'alerts.fired',
          ruleId: alert.ruleId,
          severity: alert.severity,
          signal: alert.signal,
          value: alert.value,
          threshold: alert.threshold,
          runbook: alert.runbook,
        };
        if (alert.severity === 'page') logger.error(line, alert.title.en);
        else logger.warn(line, alert.title.en);

        if (await deliver(alert)) delivered += 1;
        else undeliverable += 1;
      }

      return {
        evaluated: rules.length,
        fired: fired.length,
        delivered,
        suppressed,
        undeliverable,
      };
    },
  };
}
