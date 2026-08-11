import type { Actor } from '@/platform/authz/index';
import type { Grade, LanguageCode, Subject } from '@/shared/constants/curriculum';
import type { FoxyAction, FoxyMode, FoxyPlan } from '@/shared/constants/foxy';
import type { AbstentionReason } from './domain/abstention';
import type { Citation } from './domain/citations';

/**
 * Internal types for `foxy`, plus THE SHAPES OF ITS FIVE INJECTED DEPENDENCIES.
 *
 * ===========================================================================
 * FIVE EDGES, ALL INJECTED, NONE IMPORTED.
 *
 *   readStudentContext   the grade and enrolled subjects, from `learner`
 *   readTenantOfStudent  `users.tenant_id`, from `identity`
 *   search               the hybrid retrieval, from `retrieval`
 *   readPlan             the subscription plan, from `billing` — resolved from
 *                        `getEntitlements` and the `foxy.unlimited` CAPABILITY,
 *                        never from a plan name. Takes the ACTOR; see the type.
 *   requireSession       identity's session validator, as a preHandler
 *
 * Every one of them is a FUNCTION TYPE declared here and bound in
 * `app/routes.ts`, so that file stays the complete cross-module dependency
 * graph (D-051). `foxy` imports no other module.
 * ===========================================================================
 *
 * THE RETRIEVAL EDGE IS ONE FUNCTION, NOT THE SERVICE. `retrieval`'s public
 * surface is a single `search`, so the distinction costs nothing today — but a
 * module handed a service acquires every method that service ever grows, and
 * this is the module with a live student request attached to it.
 */

/** Only ever `{ userId, role, tenantId }`. Never the whole user row (§6.5). */
export type FoxyActor = Actor;

/** `users.tenant_id`, read from the DATA and never echoed off the actor (D-091). */
export type TenantReader = (studentUserId: string) => Promise<string | null>;

/** The student's grade and the subjects they are enrolled in. */
export interface StudentContext {
  readonly grade: Grade;
  readonly subjects: readonly string[];
}

export type StudentContextReader = (
  actor: FoxyActor,
  studentUserId: string,
) => Promise<StudentContext>;

/** The student's preferred language, from their `learner` profile. */
export type LanguageReader = (actor: FoxyActor, studentUserId: string) => Promise<LanguageCode>;

/**
 * THE BILLING EDGE — `billing.getEntitlements`, translated at the composition
 * root into the one word this module reasons about.
 *
 * ===========================================================================
 * IT TAKES AN ACTOR, AND THAT IS THE WHOLE OF D-257.
 *
 * This signature used to be `(studentUserId) => Promise<FoxyPlan | null>` — no
 * actor — while `billing.getEntitlements(actor, subjectUserId)` requires one
 * and runs `authoriseSubscription` on it. The mismatch was recorded in a
 * comment and then never resolved, so `app/routes.ts` wired a reader returning
 * `null` FOREVER and every paying customer silently received the 20-message
 * free cap.
 *
 * There were two honest ways to close it: give this reader an actor, or invent
 * a system actor at the composition root whose authority is narrow and named.
 * THE ACTOR WINS, because it is the one that needs no new authority at all.
 * Foxy only ever asks about the plan of the student who is making the request —
 * both call sites pass `actor.userId` — so the caller IS the subject, billing's
 * ownership rule is satisfied by the real session actor, and no code anywhere
 * gains the ability to read a third party's entitlements. A system actor would
 * have been a new principal that can read anybody's billing, minted to answer a
 * question that never needed it.
 *
 * ===========================================================================
 * THE COMPOSITION ROOT ASKS ABOUT A CAPABILITY, NOT A PLAN NAME.
 *
 * `hasFeature(entitlements, 'foxy.unlimited')` — never `planCode === 'monthly'`.
 * A plan is a commercial artefact that marketing renames; a capability is what
 * this code actually depends on. `FoxyPlan` stays a two-value vocabulary
 * (`free` | `plus`) because that is what `FOXY_DAILY_MESSAGE_LIMIT` is keyed
 * by, and the translation from grant to allowance happens in exactly one line,
 * in `app/routes.ts`, where every other cross-module edge already lives.
 *
 * NULL still means "this account has no paid grant", which the service reads as
 * `free`. It is returned for the overwhelmingly common case of an account that
 * never subscribed, and an absent subscription is not a failure.
 */
export type PlanReader = (actor: FoxyActor, studentUserId: string) => Promise<FoxyPlan | null>;

/** One chunk as `retrieval` hands it back. Text plus citation fields. */
export interface RetrievedChunkView {
  readonly id: string;
  readonly chunkText: string;
  readonly chapterNumber: number | null;
  readonly chapterTitle: string | null;
  readonly score: number;
  readonly rank: number;
}

/** What `retrieval.search` returns, narrowed to what this module uses. */
export interface RetrievalView {
  readonly chunks: readonly RetrievedChunkView[];
  readonly shouldAbstain: boolean;
  readonly confidence: number;
  readonly normalisedQuery: string;
  /** `'no-candidates' | 'below-threshold' | null` — retrieval's spelling. */
  readonly abstainReason: string | null;
}

/**
 * THE INJECTED RETRIEVAL EDGE.
 *
 * The FILTERS are supplied by this module from the session and the student's
 * profile — never by the caller. §8.4's own header says a retrieval endpoint
 * would let a caller choose a grade the student is not in; the same is true of
 * a service method that took the grade from a request body.
 */
export type ChunkSearch = (
  query: string,
  filters: { readonly grade: Grade; readonly subject: string },
) => Promise<RetrievalView>;

/** A conversation, as stored. */
export interface SessionRecord {
  readonly id: string;
  readonly studentUserId: string;
  readonly tenantId: string;
  readonly mode: FoxyMode;
  readonly subject: Subject;
  readonly chapterId: string | null;
  readonly language: LanguageCode;
  readonly startedAt: Date;
  readonly lastMessageAt: Date | null;
}

/** One turn, as stored. */
export interface MessageRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly action: FoxyAction | null;
  readonly citations: readonly Citation[];
  readonly abstained: boolean;
  readonly createdAt: Date;
}

/**
 * THE TRACE — one row per turn, §8.5's "the only way a bad answer will ever be
 * debugged".
 *
 * Every field answers a question somebody will ask about one specific bad
 * answer: what was asked, what was searched, what was found and how well, what
 * the model was actually told, what it said, which of its citations survived,
 * which did not, how long it took, what it cost and which model produced it.
 *
 * NO STUDENT IDENTIFIER. It is reachable from the message it explains and holds
 * no identifier of its own — see the header of `platform/db/schema/foxy.ts`.
 */
export interface TraceInput {
  readonly messageId: string;
  readonly tenantId: string;
  readonly query: string;
  readonly rewrittenQuery: string;
  readonly grade: Grade;
  readonly subject: string;
  readonly retrieved: readonly { readonly chunkId: string; readonly score: number; readonly rank: number }[];
  readonly citations: readonly Citation[];
  readonly fabricatedCitations: readonly string[];
  readonly prompt: string;
  readonly answer: string;
  readonly abstained: boolean;
  readonly abstainReason: string | null;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

/** What `startSession` takes. The grade is NOT here — see the contract. */
export interface StartSessionInput {
  readonly mode: FoxyMode;
  readonly subject: Subject;
  readonly chapterId?: string;
}

/** What `sendMessage` takes. Exactly one of the two is present. */
export interface SendMessageInput {
  readonly text?: string;
  readonly action?: FoxyAction;
}

/** A session plus its transcript. */
export interface SessionWithMessages {
  readonly session: SessionRecord;
  readonly messages: readonly MessageRecord[];
}

/** The usage counters, as `getCapabilities` reports them. */
export interface UsageSummary {
  readonly plan: FoxyPlan;
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
}

export type { AbstentionReason, Citation };
