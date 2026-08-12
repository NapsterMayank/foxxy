import type { ChannelName, ChannelPolicy } from '@/platform/notify-channel/index';

/**
 * THE ROUTING TABLE. Channel selection is DATA, not a chain of `if`s.
 *
 * ===========================================================================
 * WHY THIS FILE IS A TABLE AND NOT A FUNCTION WITH BRANCHES.
 *
 * 05-ROADMAP.md §4 puts the WhatsApp parent digest in Phase 2, on the grounds
 * that "parents open WhatsApp; they do not open email" — and expects that one
 * channel to move parent engagement more than any in-app work. The question
 * this file answers is what that change costs when it arrives.
 *
 * With a `switch (kind)` in the service, it costs: a new branch per kind, a new
 * preference check, a new "what if WhatsApp fails but email has not been tried"
 * decision — each one written slightly differently, and the differences are
 * where the bugs live.
 *
 * With this table, it costs ONE ROW EDIT: `'digest_ready'` gains `'whatsapp'`
 * in its `channels` array. The service never names a channel, the dispatcher
 * already fans out over whatever list it is given, and the adapter is looked up
 * by name from a map the composition root owns. There is a test
 * (`notify.service.test.ts`, "a channel the service has never heard of")
 * that proves it by registering a fake channel and delivering through it
 * without touching the service.
 *
 * ===========================================================================
 * `in-app` IS NOT IN ANY ROW, AND THAT IS THE ONE SURPRISING THING HERE.
 *
 * These rows list the REMOTE channels only — the ones that leave the process
 * and can fail for a reason outside our control.
 *
 * In-app is not a routing choice. It is the durable record that the system
 * decided to tell this person something, it is written SYNCHRONOUSLY by
 * `notify.send` before any remote channel is attempted, and it cannot be opted
 * out of (opting out of an in-app notification is opting out of a page in the
 * application). Listing it here would make it look optional and would give the
 * worker a second chance to write the same row.
 *
 * So: every notification lands in-app, always. This table decides who else
 * hears about it, and how loudly.
 */

/** §8.9 plus the four the MVP flows actually raise. */
export const NOTIFY_KINDS = [
  'digest_ready',
  'link_requested',
  'link_approved',
  'link_revoked',
  'payment_failed',
  'streak_reminder',
] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set<string>(NOTIFY_KINDS);

export function isNotifyKind(value: string): value is NotifyKind {
  return KIND_SET.has(value);
}

/**
 * How urgent a kind is, which is the ONLY thing quiet hours consults.
 *
 *   security   Reaches the person immediately, at any hour. Reserved for
 *              messages about WHO CAN SEE A CHILD'S DATA. A parent-link request
 *              arriving at 23:00 that the student only learns about at 07:00 is
 *              eight hours in which somebody may have gained access to a
 *              minor's records unremarked; that is not a trade worth making for
 *              a quieter phone.
 *   ordinary   Everything else. Deferred to the end of quiet hours rather than
 *              dropped — see `delivery-plan.ts`.
 *
 * `payment_failed` is deliberately ORDINARY. It is account-critical, not
 * account-SECURITY: nobody's data is at risk, the grace period is measured in
 * days, and waking a parent at 02:00 about a card decline is how a product
 * teaches people to mute its notifications.
 */
export type NotifyUrgency = 'security' | 'ordinary';

export interface KindPolicy {
  /**
   * The REMOTE channels, in preference order. See the header for why `in-app`
   * is absent. ADD A CHANNEL BY EDITING THIS ARRAY — nothing else changes.
   */
  readonly channels: readonly ChannelName[];
  readonly urgency: NotifyUrgency;
  /**
   * The most of this kind one person may receive in a UTC day.
   *
   * A cap, not a rate limit: it exists so that a loop in a caller costs a
   * handful of rows rather than ten thousand, and so that a person who has
   * already been told something six times is not told it a seventh. Counted in
   * `platform/cache`, per (user, kind, UTC date).
   */
  readonly dailyCap: number;
}

/**
 * ===========================================================================
 * THE TABLE. One row per kind. Adding WhatsApp in Phase 2 edits `channels`.
 * ===========================================================================
 */
export const KIND_POLICY: Readonly<Record<NotifyKind, KindPolicy>> = {
  /** "Your weekly summary is ready." Phase 2 adds 'whatsapp' to this row. */
  digest_ready: { channels: ['email'], urgency: 'ordinary', dailyCap: 1 },

  /** A parent submitted this student's link code. Consent decision pending. */
  link_requested: { channels: ['email'], urgency: 'security', dailyCap: 5 },

  /** The student consented. THIS is the event that granted access. */
  link_approved: { channels: ['email'], urgency: 'security', dailyCap: 5 },

  /** Either party ended the link. Access stopped on the next request. */
  link_revoked: { channels: ['email'], urgency: 'security', dailyCap: 5 },

  /** A recurring charge failed. The grace period is running. */
  payment_failed: { channels: ['email'], urgency: 'ordinary', dailyCap: 3 },

  /**
   * IN-APP ONLY — an empty remote list, which is a legitimate row and not an
   * oversight. A streak nudge is worth a badge and is not worth an email; a
   * daily email about a missed streak is the fastest way to be marked as spam.
   *
   * An empty list also means `send` enqueues NO delivery job for this kind,
   * so the cheapest notification in the product costs one INSERT.
   */
  streak_reminder: { channels: [], urgency: 'ordinary', dailyCap: 1 },
};

/**
 * The table, in the shape `platform/notify-channel`'s dispatcher takes.
 *
 * The dispatcher holds the MECHANISM (fan out, honour preferences, record
 * outcomes, never let one channel's failure hide another's) and takes the
 * POLICY as data. This function is the handover the dispatcher's own header
 * anticipated: "`notify` will own that map."
 */
export function toChannelPolicy(
  policy: Readonly<Record<NotifyKind, KindPolicy>> = KIND_POLICY,
): ChannelPolicy {
  const entries = NOTIFY_KINDS.map((kind) => [kind, policy[kind].channels] as const);
  return Object.fromEntries(entries);
}

/**
 * The metric names this module emits.
 *
 * Constants rather than literals at the call site, because a metric name is an
 * API — dashboards and alerts are written against it, and a typo produces a
 * metric that is silently never emitted, which looks exactly like the healthy
 * case.
 */
export const NOTIFY_METRICS = {
  /** A notification was created. Tags: kind. */
  CREATED: 'notify.created',
  /** A send was refused before anything was written. Tags: kind, reason. */
  SUPPRESSED: 'notify.suppressed',
  /** Remote delivery was pushed past quiet hours. Tags: kind. */
  DEFERRED: 'notify.deferred',
  /** A delivery job ran for a notification already delivered. Tags: kind. */
  DUPLICATE: 'notify.delivery.duplicate',
  /**
   * Remote delivery exhausted its attempts and will not be retried.
   *
   * THIS ONE DESERVES AN ALERT. A notification that silently never arrives is
   * worse than one that visibly fails, and this counter is the difference.
   */
  DEAD_LETTER: 'notify.delivery.dead_letter',
  /** A weekly digest was enqueued for one parent. Tags: none. */
  DIGEST_ENQUEUED: 'notify.digest.enqueued',
  /** A due parent produced no digest content. Tags: reason. */
  DIGEST_SKIPPED: 'notify.digest.skipped',
} as const;
