/**
 * GENERATED — DO NOT EDIT.
 *
 * Source of truth: backend/src/shared/. Regenerate with
 * `npm run contracts:sync` from `frontend/`. `contracts-drift.test.ts`
 * fails when this file and its backend original disagree.
 */

import { z } from 'zod';
import { GRADES } from '../constants/curriculum';

/**
 * The parent wire contract — every request and response shape for §8.7,
 * defined once. The frontend imports the INFERRED TYPES from here
 * (00-ARCHITECTURE.md §1).
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY ABSENT, AND IS THE MOST IMPORTANT PROPERTY OF THIS FILE.
 *
 * NO SCORE. NO PERCENTAGE. NO MASTERY FIGURE. Not on the snapshot, not on the
 * digest, not on a child. §8.7 is explicit that "60 percent in Science" is
 * what a parent cannot use, and a field that exists here exists in the browser
 * — where somebody will eventually render it, because it is there.
 *
 * The snapshot carries four COUNTS and one trend word; the digest carries
 * prose. Scores are read from `practice_sessions` inside the module and never
 * leave it.
 * ===========================================================================
 *
 * BOTH LANGUAGES ON EVERY PIECE OF PROSE (P7). `bilingualTextSchema` requires
 * a non-empty `hi`, so a client cannot render an English-only digest without
 * the type telling it.
 */

export const bilingualTextSchema = z.object({
  en: z.string().min(1, 'English text is required.'),
  hi: z.string().min(1, 'Hindi text is required (P7).'),
});
export type BilingualTextWire = z.infer<typeof bilingualTextSchema>;

/** A child id in the path. Every parent endpoint but one carries it. */
export const childIdParamSchema = z.object({ id: z.string().uuid() });
export type ChildIdParam = z.infer<typeof childIdParamSchema>;

/**
 * An optional week, as `YYYY-MM-DD`.
 *
 * ANY day in the week is accepted and the server normalises it to that week's
 * Monday. A client that had to compute the Monday itself would be a second
 * implementation of the week boundary, in a different language, in a different
 * time zone — which is exactly the drift the server-side pin exists to prevent.
 */
export const weekQuerySchema = z.object({
  week: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'week must be YYYY-MM-DD.')
    .optional(),
});
export type WeekQuery = z.infer<typeof weekQuerySchema>;

/** How many transcript sessions to return. Bounded so a page cannot be unbounded. */
export const transcriptQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type TranscriptQuery = z.infer<typeof transcriptQuerySchema>;

export const parentChildSchema = z.object({
  linkId: z.string().uuid(),
  childUserId: z.string().uuid(),
  displayName: z.string(),
  /** A STRING, "6".."12". Never a number — the same rule as everywhere else. */
  grade: z.enum(GRADES),
  approvedAt: z.string().datetime().nullable(),
});

export const childrenResponseSchema = z.object({ children: z.array(parentChildSchema) });
export type ChildrenResponse = z.infer<typeof childrenResponseSchema>;

export const snapshotHeadlineSchema = z.object({
  key: z.enum(['days_practised', 'sessions', 'questions_answered', 'chapters_touched']),
  /** A COUNT. Never a score — see the header. */
  value: z.number().int().min(0),
  label: bilingualTextSchema,
});

export const snapshotResponseSchema = z.object({
  childUserId: z.string().uuid(),
  weekStart: z.string(),
  headlines: z.array(snapshotHeadlineSchema),
  trend: z.enum(['more', 'about_the_same', 'less', 'first_week']),
  summary: bilingualTextSchema,
  trendLine: bilingualTextSchema,
});
export type SnapshotResponse = z.infer<typeof snapshotResponseSchema>;

export const digestSchema = z.object({
  weekStart: z.string(),
  summary: bilingualTextSchema,
  suggestedAction: bilingualTextSchema,
  /**
   * NULL for essentially every real week today (D-077), and that is honest
   * rather than pending. A client must render the digest with no misconception
   * named, because that is the normal case.
   */
  misconceptionCode: z.string().nullable(),
  sessionsCount: z.number().int().min(0),
  questionsAnswered: z.number().int().min(0),
  daysPractised: z.number().int().min(0).max(7),
  generatedAt: z.string().datetime(),
});

/** `digest` is nullable: a GET never generates one. */
export const digestResponseSchema = z.object({ digest: digestSchema.nullable() });
export type DigestResponse = z.infer<typeof digestResponseSchema>;

export const transcriptMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['student', 'foxy']),
  text: z.string(),
  createdAt: z.string().datetime(),
});

export const transcriptSessionSchema = z.object({
  sessionId: z.string(),
  mode: z.string(),
  startedAt: z.string().datetime(),
  lastMessageAt: z.string().datetime().nullable(),
  messages: z.array(transcriptMessageSchema),
});

export const transcriptResponseSchema = z.object({
  childUserId: z.string().uuid(),
  /**
   * `not_yet_available` means the feature that would hold these has not
   * shipped; `foxy` with an empty list means there are none. A parent shown an
   * empty screen deserves to know which.
   */
  source: z.enum(['foxy', 'not_yet_available']),
  sessions: z.array(transcriptSessionSchema),
  /**
   * THE CHILD-VISIBILITY STATE — always present, never optional.
   *
   * It is the product's honesty rather than a detail: a parent reading a
   * child's conversations is separated from surveillance only by the child
   * knowing. An optional field is a field a client can forget to render.
   */
  visibility: z.object({
    parentCanView: z.boolean(),
    childIsTold: z.boolean(),
    disclosure: bilingualTextSchema,
  }),
  /** There is no write path. Stated on the wire so no client looks for one. */
  readOnly: z.literal(true),
});
export type TranscriptResponse = z.infer<typeof transcriptResponseSchema>;

export const consentResponseSchema = z.object({
  childUserId: z.string().uuid(),
  linkId: z.string().uuid(),
  status: z.literal('approved'),
  approvedAt: z.string().datetime().nullable(),
  canView: z.array(z.enum(['snapshot', 'digest', 'transcript'])),
  childIsInformed: z.boolean(),
  notice: bilingualTextSchema,
});
export type ConsentResponse = z.infer<typeof consentResponseSchema>;

export const consentRevokeResponseSchema = z.object({
  childUserId: z.string().uuid(),
  linkId: z.string().uuid(),
  status: z.literal('revoked'),
  revokedAt: z.string().datetime(),
});
export type ConsentRevokeResponse = z.infer<typeof consentRevokeResponseSchema>;
