import { z } from 'zod';
import { GRADES, SUBJECTS, type LANGUAGES } from '../constants/curriculum';
import {
  FOXY_ACTIONS,
  FOXY_MODES,
  MAX_QUESTION_CHARS,
  type FOXY_FRAME_TYPES,
  type FoxyPlan,
} from '../constants/foxy';

/**
 * The Foxy wire contract — every request and response shape for §8.5, defined
 * once. The frontend imports the INFERRED TYPES from here
 * (00-ARCHITECTURE.md §1).
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY ABSENT.
 *
 * NO `prompt`. NO `retrieved`. NO chunk TEXT. A message carries its citations —
 * chunk id, chapter number, chapter title — and nothing that would let a client
 * reconstruct what the model was shown.
 *
 * The reason is not secrecy about the corpus, which is a published NCERT
 * textbook. It is that the assembled prompt contains the SYSTEM PROMPT, and a
 * system prompt in the browser is a system prompt that can be read and worked
 * around. The full prompt lives on `retrieval_traces`, which no route serves.
 *
 * NO `studentUserId` either. Every one of these endpoints resolves the student
 * from the SESSION; a student id on the wire is a field somebody eventually
 * tries to send.
 * ===========================================================================
 *
 * ONE TYPE PER FRAME rather than a single loose `{ type: string; ... }`, so the
 * client gets a discriminated union and an added frame is a compile error there
 * rather than a runtime surprise.
 */

const modeSchema = z.enum(FOXY_MODES);
const actionSchema = z.enum(FOXY_ACTIONS);

/** A UUID path parameter. */
export const foxySessionIdParamSchema = z.object({ id: z.string().uuid() });
export type FoxySessionIdParam = z.infer<typeof foxySessionIdParamSchema>;

/**
 * `POST /foxy/sessions`.
 *
 * The SUBJECT is required and the CHAPTER is optional, which mirrors the
 * schema: a conversation is always about a subject, and it is sometimes
 * anchored to a chapter. The GRADE is deliberately NOT here — it comes from the
 * student's profile, and a grade a caller could choose is a grade a caller
 * could choose wrongly.
 */
export const startFoxySessionRequestSchema = z.object({
  mode: modeSchema,
  subject: z.enum(SUBJECTS),
  chapterId: z.string().uuid().optional(),
});
export type StartFoxySessionRequest = z.infer<typeof startFoxySessionRequestSchema>;

/**
 * `POST /foxy/sessions/:id/messages`.
 *
 * EXACTLY ONE OF `text` OR `action`, enforced by a refine rather than by two
 * endpoints. Both present is ambiguous — which one is the turn? — and neither
 * present is an empty message. A union at the type level would be tidier and
 * would give the frontend a worse error message, which is the trade this makes.
 */
export const sendFoxyMessageRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_QUESTION_CHARS).optional(),
    action: actionSchema.optional(),
  })
  .refine(
    (value) => (value.text === undefined) !== (value.action === undefined),
    { message: 'Send exactly one of `text` or `action`.' },
  );
export type SendFoxyMessageRequest = z.infer<typeof sendFoxyMessageRequestSchema>;

export const foxySessionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type FoxySessionListQuery = z.infer<typeof foxySessionListQuerySchema>;

/** A verified citation, as the client renders it. */
export interface FoxyCitationDto {
  readonly chunkId: string;
  readonly chapterNumber: number | null;
  readonly chapterTitle: string | null;
}

export interface FoxyMessageDto {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly action: string | null;
  readonly citations: readonly FoxyCitationDto[];
  readonly abstained: boolean;
  /** ISO-8601. A STRING on the wire — see the note in `parent.contract.ts`. */
  readonly createdAt: string;
}

export interface FoxySessionDto {
  readonly id: string;
  readonly mode: (typeof FOXY_MODES)[number];
  readonly subject: (typeof SUBJECTS)[number];
  readonly chapterId: string | null;
  readonly language: (typeof LANGUAGES)[number];
  readonly startedAt: string;
  readonly lastMessageAt: string | null;
}

export interface FoxySessionResponse {
  readonly session: FoxySessionDto;
  /** Present on `GET /foxy/sessions/:id`; absent on creation. */
  readonly messages?: readonly FoxyMessageDto[];
}

export interface FoxySessionListResponse {
  readonly sessions: readonly FoxySessionDto[];
}

/**
 * What the client is allowed to render as buttons.
 *
 * Served rather than hardcoded in the frontend, so that the fixed action set has
 * ONE definition. A client with its own copy of the list will eventually show a
 * button the server does not implement — which fails at the moment a child
 * presses it.
 */
export interface FoxyCapabilitiesResponse {
  readonly modes: readonly { readonly code: string }[];
  readonly actions: readonly {
    readonly code: string;
    readonly label: { readonly en: string; readonly hi: string };
  }[];
  readonly usage: {
    readonly plan: FoxyPlan;
    readonly used: number;
    readonly limit: number;
    readonly remaining: number;
  };
}

/** The five SSE frame types, as the client's discriminated union. */
export type FoxyFrameTypeDto = (typeof FOXY_FRAME_TYPES)[number];

export type FoxyStreamFrameDto =
  | { readonly type: 'token'; readonly text: string }
  | { readonly type: 'citation'; readonly messageId: string; readonly citation: FoxyCitationDto }
  | {
      readonly type: 'abstention';
      readonly messageId: string;
      readonly reason: string;
      readonly text: string;
    }
  | { readonly type: 'done'; readonly messageId: string; readonly abstained: boolean }
  | { readonly type: 'error'; readonly code: string; readonly partial: boolean };

/** Re-exported so a client needs one import for the grade vocabulary. */
export const FOXY_GRADES = GRADES;
