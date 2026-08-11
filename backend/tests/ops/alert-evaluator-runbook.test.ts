import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../src/platform/clock/index';
import { FakeLogger } from '../../src/platform/logger/index';
import type {
  ChannelMessage,
  ChannelRecipient,
  NotificationDispatcher,
} from '../../src/platform/notify-channel/index';
import { ALERT_RULES } from '../../scripts/ops/alert-rules';
import { createAlertEvaluator, withRunbookLine } from '../../scripts/ops/alert-evaluator';

/**
 * THE RUNBOOK PATH HAS TO SURVIVE DELIVERY.
 *
 * =============================================================================
 * WHERE IT WAS BEING LOST.
 *
 * The evaluator put `runbook` in `ChannelMessage.data`, which is correct and
 * still happens. `email-channel.ts` maps only `kind`, `title`, `body` and
 * `language` onto the one mail template — `MailPort.data` is
 * `Record<string, string>` and the channel deliberately refuses to widen it — so
 * every other field in `data` is dropped between the evaluator and the inbox.
 *
 * The on-call email therefore arrived carrying a body that says to check the
 * runbook and no runbook. At 3am that difference is several minutes of somebody
 * grepping `docs/runbooks/` on a phone, and it is the single most actionable
 * line in the message.
 *
 * Fixed in the BODY rather than the channel, so it survives every channel —
 * in-app today, whatever pager adapter lands later — without depending on each
 * one deciding to render a payload field.
 */

const RECIPIENT: ChannelRecipient = {
  userId: 'oncall-1',
  email: 'oncall@example.test',
  tenantId: null,
  language: 'en',
};

interface Sent {
  readonly messages: ChannelMessage[];
  readonly dispatcher: NotificationDispatcher;
}

function recordingDispatcher(): Sent {
  const messages: ChannelMessage[] = [];
  return {
    messages,
    dispatcher: {
      channelsFor: () => ['in-app'],
      send: (_recipient, message) => {
        messages.push(message);
        return Promise.resolve({
          kind: message.kind,
          results: [{ channel: 'in-app' as const, delivered: true }],
          delivered: true,
        });
      },
    },
  };
}

describe('withRunbookLine', () => {
  it('appends the path in BOTH languages (P7)', () => {
    const rendered = withRunbookLine(
      { en: 'body', hi: 'मुख्य' },
      'docs/runbooks/incident-response.md#readiness-failing',
    );
    expect(rendered.en).toContain('docs/runbooks/incident-response.md#readiness-failing');
    expect(rendered.hi).toContain('docs/runbooks/incident-response.md#readiness-failing');
    // Hindi gets a Hindi label, not an English one bolted onto Devanagari.
    expect(rendered.hi).toMatch(/रनबुक/);
  });

  it('keeps the original body — the runbook is added, never a replacement', () => {
    const rendered = withRunbookLine({ en: 'the pool is full', hi: 'पूल भरा है' }, 'docs/r.md#x');
    expect(rendered.en).toContain('the pool is full');
    expect(rendered.hi).toContain('पूल भरा है');
  });
});

describe('the delivered alert carries its runbook', () => {
  it('puts the path in the BODY, where every channel renders it', async () => {
    const { messages, dispatcher } = recordingDispatcher();
    const evaluator = createAlertEvaluator({
      dispatcher,
      recipient: RECIPIENT,
      logger: new FakeLogger(),
      clock: new FixedClock('2026-08-10T00:00:00.000Z'),
      rules: ALERT_RULES.filter((rule) => rule.id === 'readiness_failing'),
    });

    await evaluator.runCycle({ 'readiness.failing': 1 });

    expect(messages).toHaveLength(1);
    // The body is the only part `email-channel.ts` forwards, so this is the
    // assertion that corresponds to what lands in an inbox.
    expect(messages[0]?.body.en).toContain(
      'docs/runbooks/incident-response.md#readiness-failing',
    );
    expect(messages[0]?.body.hi).toContain(
      'docs/runbooks/incident-response.md#readiness-failing',
    );
  });

  it('still carries the machine-readable copy in data, for the in-app row', () => {
    // `data.runbook` is not removed. The body copy is for the human; this is for
    // anything that wants to link it.
    const { messages, dispatcher } = recordingDispatcher();
    const evaluator = createAlertEvaluator({
      dispatcher,
      recipient: RECIPIENT,
      logger: new FakeLogger(),
      clock: new FixedClock('2026-08-10T00:00:00.000Z'),
      rules: ALERT_RULES.filter((rule) => rule.id === 'readiness_failing'),
    });

    return evaluator.runCycle({ 'readiness.failing': 1 }).then(() => {
      expect(messages[0]?.data?.runbook).toBe(
        'docs/runbooks/incident-response.md#readiness-failing',
      );
    });
  });

  it('every rule that can fire delivers a body containing a runbook path', async () => {
    const { messages, dispatcher } = recordingDispatcher();
    const evaluator = createAlertEvaluator({
      dispatcher,
      recipient: RECIPIENT,
      logger: new FakeLogger(),
      clock: new FixedClock('2026-08-10T00:00:00.000Z'),
    });

    // A signal value large enough to breach every `gte` threshold at once.
    const signals = Object.fromEntries(
      ALERT_RULES.map((rule) => [rule.signal, rule.threshold]),
    );
    await evaluator.runCycle(signals);

    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message.body.en).toMatch(/Runbook: docs\/runbooks\/.+#.+/);
      expect(message.body.hi).toMatch(/रनबुक: docs\/runbooks\/.+#.+/);
    }
  });
});
