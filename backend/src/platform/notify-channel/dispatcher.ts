import type { Logger } from '../logger/index';
import { PLATFORM_METRICS, createNoopMetrics, type MetricsPort } from '../metrics/index';
import type {
  Channel,
  ChannelMessage,
  ChannelName,
  ChannelRecipient,
  ChannelResult,
} from './channel.port';

/**
 * The dispatcher — decides WHICH channels a message goes out on, and sends it.
 *
 * ===========================================================================
 * WHERE THE POLICY LIVES, AND WHY IT IS NOT IN THIS FILE.
 *
 * `platform/` holds no business logic. "A parent's weekly digest goes over
 * WhatsApp and email, but a mission nudge is in-app only and respects quiet
 * hours" is product policy — it belongs to the `notify` module, which does not
 * exist yet (build step 14).
 *
 * So the dispatcher holds the MECHANISM — fan out, honour preferences, record
 * outcomes, never let one channel's failure hide another's — and takes the
 * POLICY as data: `ChannelPolicy`, a map from message kind to an ordered
 * channel list. `notify` will own that map. `DEFAULT_CHANNEL_POLICY` below is a
 * fallback, not a product decision.
 *
 * The alternative — a `switch (message.kind)` in here — would put quiet hours
 * and frequency caps in `platform/` within two sprints.
 *
 * ===========================================================================
 * USER PREFERENCE FILTERS THE POLICY; IT DOES NOT REPLACE IT.
 *
 * A user's `optOut` list removes channels from what the policy chose. It cannot
 * ADD one, because a user opting IN to a channel the product does not use for
 * that message kind would be asking for a message that has no template.
 *
 * And `in-app` is deliberately NOT removable. Opting out of an in-app
 * notification is opting out of a page in the application — the user simply
 * does not open it. Allowing it would create the state "the system needed to
 * tell you something and had nowhere to put it", and the notification would be
 * discarded rather than merely unread.
 *
 * ===========================================================================
 * FAN-OUT IS SEQUENTIAL AND ONE CHANNEL'S FAILURE NEVER STOPS ANOTHER.
 *
 * Sequential rather than `Promise.all`, because the channels are ordered by
 * preference and because parallel sends multiply the load on a mail provider
 * that may be the reason the first one failed.
 *
 * Every throw is caught PER CHANNEL and converted into a failed result. That is
 * what makes the unimplemented WhatsApp channel safe to leave in a policy by
 * accident: it throws loudly, it is recorded loudly, and the email and in-app
 * deliveries beside it still happen.
 */

/** An ordered list of channels per message kind. Owned by `notify`, later. */
export type ChannelPolicy = Readonly<Record<string, readonly ChannelName[]>>;

/**
 * The policy used when a message kind is not in the policy map.
 *
 * IN-APP ONLY, and that is the conservative choice on purpose. An unknown
 * message kind is a message somebody added without registering it; delivering
 * it to an inbox or a phone would mean an unreviewed notification reaching a
 * parent, whereas delivering it in-app means it is visible to whoever looks.
 */
export const DEFAULT_CHANNELS: readonly ChannelName[] = ['in-app'];

/** What a recipient has turned off. Cannot turn anything ON — see the header. */
export interface ChannelPreferences {
  readonly optOut?: readonly ChannelName[];
}

export interface DispatchOutcome {
  readonly kind: string;
  readonly results: readonly ChannelResult[];
  /** True when AT LEAST ONE channel delivered. */
  readonly delivered: boolean;
}

export interface NotificationDispatcher {
  send(
    recipient: ChannelRecipient,
    message: ChannelMessage,
    preferences?: ChannelPreferences,
  ): Promise<DispatchOutcome>;
  /** Which channels a kind would use. Exposed so a test can assert routing. */
  channelsFor(kind: string, preferences?: ChannelPreferences): readonly ChannelName[];
}

export interface NotificationDispatcherOptions {
  /**
   * Every channel, keyed by name. TOTAL over `ChannelName` — including the
   * unimplemented ones, which is why they exist. A partial map would make
   * "channel missing" and "channel failed" two different problems for every
   * caller to distinguish.
   */
  readonly channels: Readonly<Record<ChannelName, Channel>>;
  readonly policy: ChannelPolicy;
  readonly logger: Logger;
  readonly metrics?: MetricsPort;
}

/** Opting out of in-app is opting out of a page. See the header. */
const NON_OPTIONAL_CHANNELS: readonly ChannelName[] = ['in-app'];

export function createNotificationDispatcher(
  options: NotificationDispatcherOptions,
): NotificationDispatcher {
  const { channels, policy, logger } = options;
  const metrics = options.metrics ?? createNoopMetrics();

  function channelsFor(kind: string, preferences?: ChannelPreferences): readonly ChannelName[] {
    const chosen = policy[kind] ?? DEFAULT_CHANNELS;
    const optOut = preferences?.optOut ?? [];
    return chosen.filter(
      (channel) => NON_OPTIONAL_CHANNELS.includes(channel) || !optOut.includes(channel),
    );
  }

  return {
    channelsFor,

    async send(
      recipient: ChannelRecipient,
      message: ChannelMessage,
      preferences?: ChannelPreferences,
    ): Promise<DispatchOutcome> {
      const selected = channelsFor(message.kind, preferences);
      const results: ChannelResult[] = [];

      for (const name of selected) {
        const channel = channels[name];
        try {
          const result = await channel.send(recipient, message);
          results.push(result);
          metrics.counter(
            result.delivered ? PLATFORM_METRICS.NOTIFY_SENT : PLATFORM_METRICS.NOTIFY_FAILED,
            1,
            { channel: name, kind: message.kind },
          );
        } catch (error) {
          // CAUGHT PER CHANNEL. A dead mail provider, or the unimplemented
          // WhatsApp channel left in a policy by mistake, must not prevent the
          // in-app row from being written — that row is the reason the user
          // ever finds out.
          const reason = error instanceof Error ? error.message : 'unknown channel failure';
          results.push({ channel: name, delivered: false, reason });
          metrics.counter(PLATFORM_METRICS.NOTIFY_FAILED, 1, {
            channel: name,
            kind: message.kind,
          });
          logger.warn(
            {
              event: 'notify.channel_failed',
              channel: name,
              kind: message.kind,
              // The message only. Never the recipient — an address or a user id
              // in a log line is the leak `platform/pii` exists to prevent, and
              // a failure log is the easiest place to forget that.
              err: reason,
            },
            'a notification channel failed; other channels were still attempted',
          );
        }
      }

      const delivered = results.some((result) => result.delivered);

      if (!delivered) {
        // EVERY channel failed. Distinct from a partial failure and logged at
        // `error`, because it means the person was not told something the
        // system decided they needed to know — and nobody will notice from the
        // outside.
        logger.error(
          {
            event: 'notify.undeliverable',
            kind: message.kind,
            channels: selected,
          },
          'a notification reached nobody on any channel',
        );
      }

      return { kind: message.kind, results, delivered };
    },
  };
}
