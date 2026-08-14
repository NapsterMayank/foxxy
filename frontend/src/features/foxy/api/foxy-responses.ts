import { z } from 'zod';
import { FOXY_MODES } from '@/lib/api/generated/constants/foxy';
import { LANGUAGES, SUBJECTS } from '@/lib/api/generated/constants/curriculum';
import type {
  FoxyCapabilitiesResponse,
  FoxySessionListResponse,
  FoxySessionResponse,
} from '@/lib/api/generated/contracts/foxy.contract';

/**
 * ===========================================================================
 * THE FOXY RESPONSE SCHEMAS — build-order step 9.
 *
 * `foxy.contract.ts` declares its responses as INTERFACES and not as Zod
 * schemas, unlike `identity.contract.ts`. That is not an oversight in the
 * backend: those shapes are assembled by `toSessionDto`/`toMessageDto` and
 * never parsed on the server, so there was never a schema to generate.
 *
 * `apiRequest` validates every response against a schema, deliberately — §5.2,
 * "a response that does not match the contract is a failed request". So the
 * schemas have to exist somewhere, and this is the only honest place.
 *
 * ---------------------------------------------------------------------------
 * EVERY SCHEMA HERE IS PINNED TO THE GENERATED TYPE WITH `satisfies`.
 *
 * That is what stops this file from becoming §12's forbidden "hand-written type
 * for data the backend already defines". It is not a second definition — it is
 * a RUNTIME CHECK OF THE GENERATED ONE, and if the backend adds, removes or
 * retypes a field, `contracts:sync` rewrites the interface and this file fails
 * `npm run typecheck` at the `satisfies` line rather than at a screen.
 *
 * The vocabularies (`FOXY_MODES`, `SUBJECTS`, `LANGUAGES`) come from the
 * generated constants for the same reason, so a mode the backend adds cannot be
 * rejected here as unparseable.
 * ===========================================================================
 */

const citationSchema = z.object({
  chunkId: z.string(),
  chapterNumber: z.number().nullable(),
  chapterTitle: z.string().nullable(),
});

const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  action: z.string().nullable(),
  citations: z.array(citationSchema),
  abstained: z.boolean(),
  createdAt: z.string(),
});

const sessionSchema = z.object({
  id: z.string(),
  mode: z.enum(FOXY_MODES),
  subject: z.enum(SUBJECTS),
  chapterId: z.string().nullable(),
  language: z.enum(LANGUAGES),
  startedAt: z.string(),
  lastMessageAt: z.string().nullable(),
});

/**
 * `messages` is OPTIONAL on purpose and the contract says why: it is present on
 * `GET /foxy/sessions/:id` and absent on creation. One schema for both, because
 * two schemas that differ by one optional field drift the moment a session gains
 * a property.
 */
export const foxySessionResponseSchema = z.object({
  session: sessionSchema,
  messages: z.array(messageSchema).optional(),
}) satisfies z.ZodType<FoxySessionResponse>;

export const foxySessionListResponseSchema = z.object({
  sessions: z.array(sessionSchema),
}) satisfies z.ZodType<FoxySessionListResponse>;

/**
 * `modes` and `actions` carry `code: string` — a PLAIN STRING and not the
 * generated enum, matching the contract exactly.
 *
 * That is the contract's decision, not a looseness this file introduced, and it
 * is the right one: the whole point of serving the action list is that the
 * server owns it. A client that narrowed these to its own copy of
 * `FOXY_ACTIONS` would reject a newly-shipped action as invalid data and break
 * the screen — the precise failure serving the list exists to prevent.
 */
export const foxyCapabilitiesResponseSchema = z.object({
  modes: z.array(z.object({ code: z.string() })),
  actions: z.array(
    z.object({
      code: z.string(),
      label: z.object({ en: z.string(), hi: z.string() }),
    }),
  ),
  usage: z.object({
    plan: z.enum(['free', 'plus']),
    used: z.number(),
    limit: z.number(),
    remaining: z.number(),
  }),
}) satisfies z.ZodType<FoxyCapabilitiesResponse>;
