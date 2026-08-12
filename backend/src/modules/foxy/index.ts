import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { CachePort } from '@/platform/cache/index';
import type { Clock } from '@/platform/clock/index';
import type { LlmProvider } from '@/platform/llm/index';
import type { Logger } from '@/platform/logger/index';
import { createFoxyRepository, type FoxyDbHandle } from './foxy.repository';
import { registerFoxyRoutes } from './foxy.routes';
import { createFoxyService, type FoxyService } from './foxy.service';
import type {
  ChunkSearch,
  LanguageReader,
  PlanReader,
  StudentContextReader,
  TenantReader,
} from './foxy.types';

/**
 * ============================================================================
 * foxy — THE PUBLIC SURFACE.
 *
 * This is the only file another module may import (00-ARCHITECTURE.md,
 * Foundation 1, enforced by ESLint `no-restricted-imports`). Everything else in
 * this directory is private.
 *
 * Owns: chat sessions, modes, prompt assembly, citations and traces (plan
 * §8.5). Calls no other module — the student's grade and subjects, the account
 * tenant, the subscription plan and the retrieval itself all arrive as injected
 * functions, so every cross-module edge lives in `app/routes.ts` and nowhere
 * else.
 * ============================================================================
 *
 * ===========================================================================
 * FOXY IS A GUIDED INTERFACE, NOT AN OPEN CHATBOT. THAT IS THE DESIGN, AND IT
 * IS THE THING MOST LIKELY TO BE UNDONE BY SOMEBODY BEING HELPFUL.
 *
 * Three modes and six actions, both closed sets in `shared/constants/foxy.ts`,
 * both TOTAL over a `Record` so a new value cannot reach the prompt assembler
 * without a label, an instruction, a token budget and a translation.
 *
 * The temptation is always the same: "let the student type anything, the model
 * will cope". A fixed action set is what makes this system EVALUABLE — a bounded
 * number of prompt shapes, each reviewable once and testable forever. With open
 * chat, "is the tutor safe" stops being a question anybody can answer and
 * becomes a question about whatever a child happened to type.
 * ===========================================================================
 *
 * THE SEVEN THINGS ABOUT THIS MODULE MOST LIKELY TO BE UNDONE BY ACCIDENT.
 *
 * 1. ABSTENTION NEVER CALLS THE MODEL. `retrieval.search` decides, and the
 *    branch that returns the abstention is above every line that touches
 *    `deps.llm`. A test asserts the model recorded ZERO calls. If that test is
 *    ever changed to assert something weaker, this module has become a chatbot
 *    with a search box attached.
 *
 * 2. ABSTENTION IS A SUCCESSFUL ANSWER. 200, an `abstention` frame, a stored
 *    message with `abstained = true`, and a trace. Not an error, not a 4xx, not
 *    an empty response. The client renders it with no retry button, because
 *    retrying cannot change the textbook.
 *
 * 3. EVERY CITATION IS VERIFIED AGAINST WHAT WAS RETRIEVED, AND THE STRIPPING
 *    HAPPENS MID-STREAM. `domain/citations.ts` is an incremental filter for
 *    exactly this reason: verifying at the end would mean a fabricated marker
 *    had already been shown to the student, which makes "stripped before the
 *    response is sent" false in the one place it matters most.
 *
 * 4. THE RESOURCE TENANT IS READ FROM `users`, NEVER OFF THE ACTOR (D-091,
 *    D-125). Session-scoped methods take it from the ROW, which is stronger
 *    still. `foxy.authz-mutation.test.ts` installs each mistake deliberately and
 *    proves the suite goes red.
 *
 * 5. THE SAFETY CLASSIFIER RUNS BEFORE THE MODEL, not after. A classifier on
 *    the output is a filter; one on the input is a boundary — and the harm case
 *    must be answered by a fixed sentence naming a helpline, never by a model
 *    improvising under a tutoring persona.
 *
 * 6. USAGE COUNTERS LIVE IN `platform/cache`, NEVER IN PROCESS MEMORY. An
 *    in-memory counter stops working the moment a second instance runs and it
 *    fails SILENTLY — the limit reads as enforced and is not.
 *
 * 7. THE SYSTEM PROMPT REACHES THE MODEL, AND THE TRACE RECORDS WHAT WAS SENT.
 *    `toLlmRequest` is the only builder of the request and `renderSentPrompt`
 *    the only renderer of the trace's `prompt` column, from that same object.
 *    An audit once dropped the system message and set temperature 1.5 at the
 *    call site and every test stayed green — `assemblePrompt` is tested as a
 *    pure function, so all of it was asserted on a value nobody had to send.
 *    Worse, the trace was re-derived from the assembler, so the forensic record
 *    claimed a prompt the model never received. Assertions on
 *    `recorder.requests` in `foxy.service.test.ts` are what keep this true.
 */

export interface FoxyModuleDeps {
  /**
   * §3.1: the `ai` pool — `container.poolFor('foxy')`.
   *
   * NOT `core`. A Foxy turn is a retrieval plus a model call, and a slow one
   * holding a `core` connection would put every login and every chapter listing
   * behind it. The pool follows the CALLER's cost profile.
   */
  readonly db: FoxyDbHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Guarded by the composition root. Never a bare adapter. */
  readonly llm: LlmProvider;
  /** Usage counters. Never process memory — 00-ARCHITECTURE.md §7. */
  readonly cache: CachePort;
  /** Identity's session validator, passed in rather than imported. */
  readonly requireSession: preHandlerAsyncHookHandler;

  /** `retrieval.search`. Filters are supplied by this module, never by a caller. */
  readonly search: ChunkSearch;
  /** `users.tenant_id`, read from the DATA and never echoed off the actor. */
  readonly readTenantOfStudent: TenantReader;
  /** learner's profile and subjects, read fresh on every turn. */
  readonly readStudentContext: StudentContextReader;
  readonly readLanguage: LanguageReader;
  /**
   * `billing.getEntitlements`, translated into an allowance.
   *
   * ==========================================================================
   * REQUIRED, NOT OPTIONAL, AND THAT IS THE STRUCTURAL HALF OF D-257.
   *
   * It was optional, defaulting to a reader that reported no subscription —
   * i.e. the free tier — and `app/routes.ts` then ALSO passed an explicit
   * `() => null` with a comment saying billing was a later build step. Billing
   * shipped; neither line was revisited; every paying customer kept the
   * 20-message free cap and nothing anywhere reported it.
   *
   * An optional dependency whose default is "the cheapest tier" is a silent
   * revenue defect waiting for somebody to forget one line. Making it required
   * means a construction site that has not answered the question DOES NOT
   * COMPILE — which is the only form of "don't forget" this codebase trusts.
   * ==========================================================================
   */
  readonly readPlan: PlanReader;
  /**
   * The model id stamped on every trace row.
   *
   * From configuration, because the model is an environment variable — so
   * "which model produced this answer" is not derivable from the code at any
   * later date, and stamping it per row is the only thing that makes a
   * regression after a model change attributable.
   */
  readonly model: string;
}

export interface FoxyModule {
  readonly service: FoxyService;
  /** Registers the five `/foxy/…` endpoints under `/api/v1`. */
  registerRoutes(app: FastifyInstance): void;
}

export function createFoxyModule(deps: FoxyModuleDeps): FoxyModule {
  const service = createFoxyService({
    repository: createFoxyRepository(deps.db),
    clock: deps.clock,
    logger: deps.logger,
    llm: deps.llm,
    cache: deps.cache,
    search: deps.search,
    readTenantOfStudent: deps.readTenantOfStudent,
    readStudentContext: deps.readStudentContext,
    readLanguage: deps.readLanguage,
    readPlan: deps.readPlan,
    model: deps.model,
  });

  return {
    service,
    registerRoutes(app: FastifyInstance): void {
      registerFoxyRoutes(app, { service, requireSession: deps.requireSession });
    },
  };
}

/**
 * ---------------------------------------------------------------------------
 * The use-cases, as named in §8.5. Each is reached through `module.service`,
 * and each calls `assertCanAccess` BEFORE it touches anything.
 *
 *   startSession    Opens a conversation in one mode about one subject. The
 *                   grade comes from the profile; the subject is checked against
 *                   the student's enrolment at creation rather than left to
 *                   abstain on every turn.
 *   sendMessage     One turn. Returns a PROMISE of a frame stream: everything
 *                   with an HTTP status happens before the first byte, and
 *                   everything after it is a frame.
 *   getSession      One conversation and its full transcript.
 *   listSessions    The student's own conversations, newest first.
 *   getTranscript   The messages alone, for a caller that already has the
 *                   session.
 *   getUsage        Today's plan, count and remaining allowance.
 * ---------------------------------------------------------------------------
 */
export type { FoxyService, FoxyTurn } from './foxy.service';
export { SESSION_PAGE_LIMIT } from './foxy.service';

/** The fixed action set and the three modes, with their prompt shapes. */
export { ACTION_SPECS, actionMessageText, actionSpec, listActions } from './domain/actions';
export type { ActionSpec } from './domain/actions';
export { MODE_SPECS, listModes, modeSpec } from './domain/modes';
export type { ModeSpec } from './domain/modes';

/** Abstention — a first-class answer, with its fixed bilingual wording. */
export {
  ABSTENTION_REASONS,
  abstentionMessage,
  abstentionMessages,
  fromRetrievalReason,
} from './domain/abstention';
export type { AbstentionReason } from './domain/abstention';

/** Citation extraction and the verification that makes a citation real. */
export {
  CITATION_OPEN,
  MAX_CITATION_ID_CHARS,
  createCitationFilter,
  verifyCitations,
} from './domain/citations';
export type { CitableChunk, Citation, CitationFilter } from './domain/citations';

/** The safety classifier, its categories and its fixed refusals. */
export {
  MAX_QUESTION_CHARS,
  SAFETY_CATEGORIES,
  classifyInput,
  refusalMessage,
  refusalMessages,
} from './domain/safety';
export type { SafetyCategory, SafetyVerdict } from './domain/safety';

/**
 * Prompt assembly, the identity guard that runs on every fragment of it, and the
 * ONE builder of the request that is actually sent (`toLlmRequest`) plus the one
 * renderer of what was sent for the trace (`renderSentPrompt`).
 */
export {
  FOXY_MAX_TEMPERATURE,
  PromptIdentityLeak,
  PromptSafetyViolation,
  assemblePrompt,
  assertNoIdentity,
  renderSentPrompt,
  toLlmRequest,
} from './domain/prompt';
export type { AssembledPrompt, PromptChunk, PromptInput, PromptTurn } from './domain/prompt';

/** The SSE wire format, shared with the frontend's streaming client (§7). */
export { SSE_HEADERS, encodeFrame, isFrameOfType } from './domain/sse';
export type {
  AbstentionFrame,
  CitationFrame,
  DoneFrame,
  ErrorFrame,
  FoxyFrame,
  TokenFrame,
} from './domain/sse';

/** The usage rule. Pure; the counter it judges lives in `platform/cache`. */
export {
  USAGE_TTL_SECONDS,
  decideUsage,
  secondsUntilReset,
  usageCacheKey,
  usageDayKey,
} from './domain/usage';
export type { UsageDecision } from './domain/usage';

/** The injected-dependency shapes `app/routes.ts` has to satisfy. */
export type {
  ChunkSearch,
  FoxyActor,
  LanguageReader,
  MessageRecord,
  PlanReader,
  RetrievalView,
  RetrievedChunkView,
  SendMessageInput,
  SessionRecord,
  SessionWithMessages,
  StartSessionInput,
  StudentContext,
  StudentContextReader,
  TenantReader,
  UsageSummary,
} from './foxy.types';
