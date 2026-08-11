/**
 * GENERATED — DO NOT EDIT.
 *
 * Source of truth: backend/src/shared/. Regenerate with
 * `npm run contracts:sync` from `frontend/`. `contracts-drift.test.ts`
 * fails when this file and its backend original disagree.
 */

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
 * Offset pagination over a list that grows at the HEAD silently repeats and
 * skips rows: a notification arriving between page one and page two shifts every
 * later row down by one. The read index is `(recipient_user_id, created_at
 * desc)`, so a keyset scan is also the only shape that stays cheap.
 *
 * ===========================================================================
 * THE CURSOR IS COMPOSITE — `(before, beforeId)` — AND D-259 IS WHY.
 *
 * It used to be `before` alone, a `created_at`, while the server's ORDER BY was
 * and always has been `(created_at desc, id desc)`. A cursor that names fewer
 * columns than the sort DOES NOT IDENTIFY A POSITION IN THAT SORT. Two rows
 * sharing a timestamp straddle the page boundary: the first page ends on one of
 * them, the next page asks for rows STRICTLY OLDER than that timestamp, and its
 * twin — which sorts after it and was never returned — is skipped. Permanently,
 * and with no error anywhere.
 *
 * Identical timestamps are not exotic. A bulk send writes a batch inside one
 * statement, and the whole test suite runs on an INJECTED CLOCK that returns the
 * same instant until it is advanced, so ties are the normal case rather than the
 * rare one.
 *
 * ---------------------------------------------------------------------------
 * BOTH FIELDS OR NEITHER, ENFORCED HERE AS A 400.
 *
 * A client that remembered to send `before` and forgot `beforeId` would be
 * asking the exact question that skipped rows. The refinement makes that a loud
 * validation error at the edge instead of a quiet wrong answer from the
 * database — a half-supplied cursor is not a cursor.
 *
 * (The considered alternative was one opaque base64 token, which cannot be
 * half-supplied at all. It was not taken because an operator reading an access
 * log or reproducing a report by hand can read an ISO timestamp and a uuid, and
 * cannot read a token; the refinement buys the same guarantee at the boundary.)
 */
export const listNotificationsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /** The `createdAt` of the oldest row the client already has. */
    before: z.string().datetime().optional(),
    /** That same row's `id` — the tiebreaker. See the block above. */
    beforeId: z.string().uuid().optional(),
  })
  .refine((query) => (query.before === undefined) === (query.beforeId === undefined), {
    message: 'A page cursor needs both `before` and `beforeId`, or neither.',
    path: ['beforeId'],
  });
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const listNotificationsResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  /**
   * The cursor for the next page, or null when this is the last one.
   *
   * BOTH HALVES ARE NULL TOGETHER, always — they are one value rendered as two
   * fields, and the query schema above refuses a request that carries only one.
   */
  nextBefore: z.string().datetime().nullable(),
  nextBeforeId: z.string().uuid().nullable(),
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
