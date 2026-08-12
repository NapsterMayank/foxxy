import type { Actor } from '@/platform/authz/index';
import type { BilingualText, ChannelName } from '@/platform/notify-channel/index';
import type { NotifyKind } from './domain/kinds';

/**
 * Internal types for the notify module. Nothing here is public except where
 * `index.ts` re-exports it deliberately.
 */

/** The authenticated caller: `{ userId, role, tenantId }`, never a user row. */
export type NotifyActor = Actor;

/**
 * Who a notification is for, resolved from identity.
 *
 * INJECTED, not imported — `users` is identity's table, and every cross-module
 * edge belongs in `app/routes.ts`. The same rule, for the same reason, as
 * `learner`'s `TenantReader`.
 *
 * `email` is nullable because a recipient legitimately may not have one usable:
 * an unverified address, or an account created on a parent's device. The email
 * channel reports that as an ordinary failed RESULT rather than throwing, so a
 * missing address never aborts a fan-out that still has other channels.
 */
export interface NotifyRecipient {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string | null;
}

/**
 * Reads a recipient, or null when there is no such account.
 *
 * Null rather than a throw: `send` turns it into a named error, and the caller
 * is always the system rather than a user, so there is no enumeration surface
 * to protect here.
 */
export type RecipientReader = (userId: string) => Promise<NotifyRecipient | null>;

/**
 * One notification, as the service moves it around.
 *
 * BOTH LANGUAGES, ALWAYS. `BilingualText` requires `en` and `hi`, so a
 * single-language notification does not compile — see the long note in
 * `platform/notify-channel/channel.port.ts`.
 */
export interface NotificationRecord {
  readonly id: string;
  readonly recipientUserId: string;
  readonly tenantId: string;
  readonly kind: NotifyKind;
  readonly title: BilingualText;
  readonly body: BilingualText;
  /** Client-facing payload. Internal `_`-prefixed keys are already stripped. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

/** What `send` was asked to deliver. */
export interface SendNotificationInput {
  readonly recipientUserId: string;
  readonly kind: NotifyKind;
  /** REQUIRED in both languages, at the type level. */
  readonly title: BilingualText;
  /** REQUIRED in both languages, at the type level. */
  readonly body: BilingualText;
  /** Identifiers and counts. Never prose, never PII. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Why a send produced no notification. */
export type SendSuppressionReason = 'frequency_cap';

/**
 * What `send` did.
 *
 * A RESULT rather than a bare id, because "suppressed by the daily cap" is an
 * ordinary, expected outcome that the caller may want to count — and because a
 * function that returned an id and sometimes threw would make the cap look like
 * an error condition.
 */
export interface SendResult {
  readonly notificationId: string | null;
  /** True when the in-app row was written. */
  readonly created: boolean;
  readonly suppressed?: SendSuppressionReason;
  /** The remote channels the delivery job will attempt. May be empty. */
  readonly scheduledChannels: readonly ChannelName[];
  /** When remote delivery may first be attempted. Null when there is none. */
  readonly deliverAfter: Date | null;
}

/** The payload of one `notify.deliver` job. */
export interface DeliveryJobPayload extends Record<string, unknown> {
  readonly notificationId: string;
  readonly channels: readonly ChannelName[];
}

/** What one delivery attempt concluded. */
export type DeliveryOutcome = 'delivered' | 'undelivered' | 'duplicate' | 'dead_letter';
