import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../src/platform/clock/index';
import { FakeLogger } from '../../src/platform/logger/index';
import { MemoryMetrics } from '../../src/platform/metrics/index';
import { PLATFORM_METRICS } from '../../src/platform/metrics/metrics.port';
import type {
  Channel,
  ChannelMessage,
  ChannelName,
  ChannelRecipient,
} from '../../src/platform/notify-channel/index';
import { createNotificationDispatcher } from '../../src/platform/notify-channel/index';

/**
 * "A NOTIFICATION REACHED NOBODY" NOW HAS A METRIC — D-146, closed.
 *
 * ===========================================================================
 * WHY THE OLD COUNTER COULD NOT STAND IN FOR IT, WHICH IS THE WHOLE POINT.
 *
 * The dispatcher has always DETECTED this case: it logs `notify.undeliverable`
 * at `error`. A log line is not a signal. Nothing aggregates it, and no alert
 * rule can watch it — `alert-rules.ts` said so in a comment for the whole life
 * of the file and filed it as a known gap rather than writing a rule against a
 * signal nothing produced.
 *
 * `platform.notify.failed` could not be given a threshold instead, because it
 * counts DELIVERIES, per channel:
 *
 *   one notification failing on email AND in-app        -> notify.failed = 2
 *   two notifications each failing on one of two,
 *   with their other channel landing                    -> notify.failed = 2
 *
 * The first is a person who was never told something the system decided they
 * needed to know. The second is a degraded provider and a working product. They
 * are arithmetically identical, and an alert cannot separate them. That
 * indistinguishability is the defect, and it is what the tests below pin.
 */

const RECIPIENT: ChannelRecipient = {
  userId: 'user-1',
  email: 'oncall@example.test',
  language: 'en',
};

const MESSAGE: ChannelMessage = {
  kind: 'ops.alert.page',
  title: { en: 'Readiness failing', hi: 'रेडीनेस विफल' },
  body: { en: 'not returning 200', hi: '200 नहीं लौटा रहा' },
};

function channel(name: ChannelName, behaviour: 'ok' | 'throws' | 'reports-failure'): Channel {
  return {
    name,
    send(): Promise<{ channel: ChannelName; delivered: boolean; reason?: string }> {
      if (behaviour === 'throws') throw new Error(`${name} exploded`);
      if (behaviour === 'reports-failure') {
        return Promise.resolve({ channel: name, delivered: false, reason: 'no address on file' });
      }
      return Promise.resolve({ channel: name, delivered: true });
    },
  };
}

function build(
  email: 'ok' | 'throws' | 'reports-failure',
  inApp: 'ok' | 'throws' | 'reports-failure',
): { dispatcher: ReturnType<typeof createNotificationDispatcher>; metrics: MemoryMetrics } {
  const metrics = new MemoryMetrics({ clock: new FixedClock('2026-08-10T00:00:00.000Z') });
  const dispatcher = createNotificationDispatcher({
    channels: {
      email: channel('email', email),
      'in-app': channel('in-app', inApp),
      whatsapp: channel('whatsapp', 'ok'),
      push: channel('push', 'ok'),
    },
    policy: { 'ops.alert.page': ['email', 'in-app'] },
    logger: new FakeLogger(),
    metrics,
  });
  return { dispatcher, metrics };
}

const UNDELIVERABLE = PLATFORM_METRICS.NOTIFY_UNDELIVERABLE;
const FAILED = PLATFORM_METRICS.NOTIFY_FAILED;

describe('platform.notify.undeliverable', () => {
  it('is emitted when EVERY channel throws', async () => {
    const { dispatcher, metrics } = build('throws', 'throws');
    const outcome = await dispatcher.send(RECIPIENT, MESSAGE);

    expect(outcome.delivered).toBe(false);
    expect(metrics.totalFor(UNDELIVERABLE)).toBe(1);
  });

  it('is emitted when every channel merely REPORTS failure without throwing', async () => {
    // A channel returning `{ delivered: false }` is the ordinary path — no email
    // address on file, a scrubbed push token. Nobody was told either way, and an
    // implementation that only counted throws would miss the commonest half.
    const { dispatcher, metrics } = build('reports-failure', 'reports-failure');
    await dispatcher.send(RECIPIENT, MESSAGE);
    expect(metrics.totalFor(UNDELIVERABLE)).toBe(1);
  });

  it('is NOT emitted when one channel lands — a partial failure is not a silence', async () => {
    const { dispatcher, metrics } = build('throws', 'ok');
    const outcome = await dispatcher.send(RECIPIENT, MESSAGE);

    expect(outcome.delivered).toBe(true);
    expect(metrics.totalFor(UNDELIVERABLE)).toBe(0);
    // The per-channel counter still records the email failure, as it always did.
    expect(metrics.totalFor(FAILED)).toBe(1);
  });

  /**
   * THE TEST THAT NAMES THE DEFECT. Both scenarios produce `notify.failed = 2`.
   * Only the new counter tells them apart, and it is the difference between
   * "somebody was not told" and "a provider is flaky".
   */
  it('separates one total silence from two partial failures, which notify.failed cannot', async () => {
    const silence = build('throws', 'throws');
    await silence.dispatcher.send(RECIPIENT, MESSAGE);

    const flaky = build('throws', 'ok');
    await flaky.dispatcher.send(RECIPIENT, MESSAGE);
    await flaky.dispatcher.send(RECIPIENT, MESSAGE);

    // Indistinguishable on the old counter...
    expect(silence.metrics.totalFor(FAILED)).toBe(2);
    expect(flaky.metrics.totalFor(FAILED)).toBe(2);
    // ...and unambiguous on the new one.
    expect(silence.metrics.totalFor(UNDELIVERABLE)).toBe(1);
    expect(flaky.metrics.totalFor(UNDELIVERABLE)).toBe(0);
  });

  it('tags the KIND and nothing that identifies a person (P13)', async () => {
    const { dispatcher, metrics } = build('throws', 'throws');
    await dispatcher.send(RECIPIENT, MESSAGE);

    const series = metrics.snapshot().filter((entry) => entry.name === UNDELIVERABLE);
    expect(series).toHaveLength(1);
    expect(series[0]?.tags).toEqual({ kind: 'ops.alert.page' });

    const flattened = JSON.stringify(series);
    expect(flattened).not.toContain(RECIPIENT.userId);
    expect(flattened).not.toContain('oncall@example.test');
  });

  it('counts per NOTIFICATION, so three silences are three and not six', async () => {
    const { dispatcher, metrics } = build('throws', 'throws');
    await dispatcher.send(RECIPIENT, MESSAGE);
    await dispatcher.send(RECIPIENT, MESSAGE);
    await dispatcher.send(RECIPIENT, MESSAGE);

    expect(metrics.totalFor(UNDELIVERABLE)).toBe(3);
    expect(metrics.totalFor(FAILED)).toBe(6);
  });
});
