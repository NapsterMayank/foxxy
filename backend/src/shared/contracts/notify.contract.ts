import { z } from 'zod';

/**
 * The notify wire contract — every request and response shape for the notify
 * module, defined once.
 *
 * 00-ARCHITECTURE.md §1: the frontend imports the INFERRED TYPES from here.
 * Never hand-write a type on the frontend that the backend already defines.
 *
 * ===========================================================================
 * BOTH LANGUAGES ARE REQUIRED, ON THE WIRE AS WELL AS IN THE TYPES.
 *
 * `bilingualTextSchema` demands a non-empty `en` AND a non-empty `hi`. That is
 * the third layer of the same rule:
 *
 *   TYPE       `BilingualText` in `platform/notify-channel` — a single-language
 *              message does not compile.
 *   DATABASE   four NOT NULL columns with a non-empty CHECK on `notifications`
 *              — catches a raw INSERT, an import script, a psql session.
 *   WIRE       this schema — catches a response assembled by hand, and gives
 *              the frontend a type in which `hi` is not optional, so a client
 *              cannot render an English-only notification without noticing.
 *
 * The layers are not redundant. Each one catches a class of mistake the others
 * structurally cannot see.
 *
 * ===========================================================================
 * THE RESPONSE CARRIES BOTH LANGUAGES RATHER THAN THE RENDERED ONE.
 *
 * A notification row is READ LATER — potentially after the user changed their
 * language preference. Rendering at write time would freeze the language and
 * make a preference change apply only to future notifications, which is the
 * kind of half-working behaviour that produces a bug report nobody can
 * reproduce. The client picks; the server ships both.
 */

export const bilingualTextSchema = z.object({
  en: z.string().min(1, 'English text is required.'),
  /** REQUIRED. See the block comment above before making this optional. */
  hi: z.string().min(1, 'Hindi text is required (P7).'),
});
export type BilingualTextPayload = z.infer<typeof bilingualTextSchema>;

/**
 * The message kinds the MVP ships.
 *
 * A closed set on the wire, deliberately. The kind drives channel routing, the
 * frequency cap and the quiet-hours decision, so a kind the server does not
 * recognise is a message nobody has decided how to deliver.
 *
 * It is written out here as a `z.enum` tuple rather than derived from the
 * module's own constant because `shared/` may not import from `modules/` — the
 * two are pinned to each other by a test (`notify.contract.test.ts`), which is
 * the mechanism that stops them drifting.
 */
export const NOTIFY_KIND_VALUES = [
  'digest_ready',
  'link_requested',
  'link_approved',
  'link_revoked',
  'payment_failed',
  'streak_reminder',
] as const;

export const notifyKindSchema = z.enum(NOTIFY_KIND_VALUES);
export type NotifyKindPayload = z.infer<typeof notifyKindSchema>;

export const notificationSchema = z.object({
  id: z.string().uuid(),
  kind: notifyKindSchema,
  title: bilingualTextSchema,
  body: bilingualTextSchema,
  /**
   * Identifiers and counts for the client to act on. Never prose, never PII —
   * scrubbed through `platform/pii` on the way in, and internal delivery
   * bookkeeping (any key starting `_`) is stripped on the way out.
   */
  data: z.record(z.unknown()),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Notification = z.infer<typeof notificationSchema>;

/**
 * Keyset pagination, not offset.
 *
 * `before` is the `createdAt` of the oldest row the client already has. Offset
 * pagination over a list that grows at the HEAD silently repeats and skips
 * rows: a notification arriving between page one and page two shifts every
 * later row down by one. The read index is `(recipient_user_id, created_at
 * desc)`, so a keyset scan is also the only shape that stays cheap.
 */
export const listNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.string().datetime().optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const listNotificationsResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  /** The cursor for the next page, or null when this is the last one. */
  nextBefore: z.string().datetime().nullable(),
  unreadCount: z.number().int().min(0),
});
export type ListNotificationsResponse = z.infer<typeof listNotificationsResponseSchema>;

export const unreadCountResponseSchema = z.object({
  unreadCount: z.number().int().min(0),
});
export type UnreadCountResponse = z.infer<typeof unreadCountResponseSchema>;

/**
 * Marking read is IDEMPOTENT and always 200.
 *
 * `changed: false` means it was already read. Not a 404 and not a 409: a client
 * that taps a notification twice, or replays a request after a dropped
 * connection, has done nothing wrong and must not be shown an error.
 */
export const markReadResponseSchema = z.object({
  changed: z.boolean(),
  unreadCount: z.number().int().min(0),
});
export type MarkReadResponse = z.infer<typeof markReadResponseSchema>;

export const markAllReadResponseSchema = z.object({
  marked: z.number().int().min(0),
  unreadCount: z.number().int().min(0),
});
export type MarkAllReadResponse = z.infer<typeof markAllReadResponseSchema>;
