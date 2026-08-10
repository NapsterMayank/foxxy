import type { ChannelName } from '@/platform/notify-channel/index';
import { KIND_POLICY, type KindPolicy, type NotifyKind } from './kinds';
import type { NotifyPreferences } from './preferences';
import { isWithinQuietHours, quietHoursEndAt } from './quiet-hours';

/**
 * The delivery plan — the one function that decides WHO hears about a
 * notification, on WHICH channels, and WHEN.
 *
 * Pure: the routing table, the preferences and the instant all arrive as
 * arguments. That is what lets every rule below be asserted at a chosen hour
 * with no clock, no database and no sleep.
 *
 * ===========================================================================
 * IN-APP IS NOT IN THE PLAN, BECAUSE IT IS NOT A DECISION.
 *
 * The in-app row is written synchronously by `notify.send` before this function
 * is consulted for anything. It always lands, it cannot be opted out of, it is
 * never deferred and it never fails for a reason outside our control. This
 * function plans only the REMOTE channels — the ones that leave the process.
 *
 * So a plan with no channels at all is a perfectly ordinary outcome
 * (`streak_reminder` is in-app only), and it means "enqueue no delivery job",
 * not "this person was told nothing".
 *
 * ===========================================================================
 * QUIET HOURS DEFER. THEY DO NOT DROP.
 *
 * The naive implementation returns an empty channel list during quiet hours,
 * and it is wrong in a way that is invisible: the notification is silently
 * never emailed, and the only trace is that the person did not react to it.
 * "A notification that silently never arrives is worse than one that visibly
 * fails" applies to a suppression just as much as to a failure.
 *
 * So an ordinary kind raised at 23:00 keeps its channels and gets a `sendAfter`
 * of 07:00. The job queue holds it; the worker delivers it in the morning.
 * A security kind ignores the window entirely — see the urgency note in
 * `domain/kinds.ts` for why the three link kinds are worth waking somebody for
 * and a failed card payment is not.
 */

export interface DeliveryPlan {
  /**
   * The REMOTE channels to attempt, in preference order. Empty means no
   * delivery job is enqueued at all.
   */
  readonly channels: readonly ChannelName[];
  /**
   * Earliest instant remote delivery may be attempted. Equal to `at` unless
   * quiet hours pushed it out.
   */
  readonly sendAfter: Date;
  /** True when quiet hours moved `sendAfter`. Drives the metric and the log. */
  readonly deferred: boolean;
}

export interface PlanDeliveryInput {
  readonly kind: NotifyKind;
  readonly preferences: NotifyPreferences;
  /** The instant the notification was raised. From the INJECTED clock. */
  readonly at: Date;
  /** Overridable so a test can prove the service never names a channel. */
  readonly policy?: Readonly<Record<NotifyKind, KindPolicy>>;
}

export function planDelivery(input: PlanDeliveryInput): DeliveryPlan {
  const policy = (input.policy ?? KIND_POLICY)[input.kind];
  const { preferences, at } = input;

  // Preference FILTERS the table; it can never extend it. `in-app` cannot
  // appear here (the table holds remote channels only), so there is no
  // non-optional channel to protect at this layer — the dispatcher still
  // refuses an `in-app` opt-out on its own account.
  const channels = policy.channels.filter((channel) => !preferences.optOut.includes(channel));

  if (channels.length === 0) {
    // Nothing to schedule. Reported as "not deferred" rather than as a
    // deferral to `at`, because there is no delivery to defer and a metric
    // counting it as one would overstate how often quiet hours fire.
    return { channels, sendAfter: at, deferred: false };
  }

  const { quietHours, timezone } = preferences;

  // A security kind ignores the window, and so does a person who has turned it
  // off. Both are checked before the window is evaluated, so `quietHours` is
  // non-null from here and no branch below is unreachable.
  if (quietHours === null || policy.urgency === 'security') {
    return { channels, sendAfter: at, deferred: false };
  }

  if (!isWithinQuietHours(at, quietHours, timezone)) {
    return { channels, sendAfter: at, deferred: false };
  }

  return {
    channels,
    sendAfter: quietHoursEndAt(at, quietHours, timezone),
    deferred: true,
  };
}
