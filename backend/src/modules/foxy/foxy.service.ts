import { createAccessGuard } from '@/platform/authz/index';
import type { CachePort } from '@/platform/cache/index';
import type { Clock } from '@/platform/clock/index';
import { NotFoundError, RateLimitError, ValidationError } from '@/platform/errors/index';
import type { LlmProvider } from '@/platform/llm/index';
import type { Logger } from '@/platform/logger/index';
import type { Grade, LanguageCode } from '@/shared/constants/curriculum';
import { FOXY_HISTORY_TURNS, type FoxyAction, type FoxyPlan } from '@/shared/constants/foxy';
import { abstentionMessage, fromRetrievalReason, type AbstentionReason } from './domain/abstention';
import { actionMessageText, actionSpec } from './domain/actions';
import { createCitationFilter, type Citation } from './domain/citations';
import {
  PromptIdentityLeak,
  assemblePrompt,
  assertNoIdentity,
  type AssembledPrompt,
  type PromptChunk,
} from './domain/prompt';
import { classifyInput, refusalMessage } from './domain/safety';
import type { FoxyFrame } from './domain/sse';
import { USAGE_TTL_SECONDS, decideUsage, secondsUntilReset, usageCacheKey } from './domain/usage';
import type { FoxyRepository } from './foxy.repository';
import type {
  ChunkSearch,
  FoxyActor,
  LanguageReader,
  MessageRecord,
  PlanReader,
  SendMessageInput,
  SessionRecord,
  SessionWithMessages,
  StartSessionInput,
  StudentContextReader,
  TenantReader,
  TraceInput,
  UsageSummary,
} from './foxy.types';

/**
 * =============================================================================
 * THE FOXY TURN — §8.5. ONE PATH, IN THIS ORDER, WITH NO ALTERNATIVES.
 *
 *   1  authorise                        the tenant comes from the DATA
 *   2  check the usage limit            counters in platform/cache
 *   3  load grade and subjects          from `learner`
 *   4  classify the input for safety    BEFORE the model, BEFORE retrieval
 *   5  retrieval.search                 hard filtered by grade and subject
 *   6  IF IT ABSTAINS: return the abstention. THE MODEL IS NEVER CALLED.
 *   7  assemble the prompt for the mode
 *   8  stream from the llm port
 *   9  extract citations, VERIFY each against what was retrieved, and strip the
 *      fabricated ones BEFORE the text reaches the student
 *  10  persist the message and the trace, in one transaction
 *
 * THE ORDERING OF 5 AND 6 IS THE PRODUCT. Everything else could be rearranged
 * and the system would still work; if the model is called before the abstention
 * decision, this is a chatbot that happens to have a search box.
 *
 * -----------------------------------------------------------------------------
 * WHY `sendMessage` RETURNS A PROMISE OF A STREAM, RATHER THAN A STREAM.
 *
 * Steps 1-2 have real HTTP answers: 403, 404, 429. Once a single SSE byte has
 * been written the status is committed to 200 and there is no code left to
 * change — so every failure that HAS a status must happen before the stream
 * begins, and every failure after it must be a frame.
 *
 * The promise resolves once the turn is authorised, admitted and grounded. From
 * then on nothing throws to the caller: a model failure mid-stream becomes an
 * `error` frame followed by `done`, and the tokens already delivered stand.
 * That is §8.5's "graceful partial response rather than a 500", expressed as a
 * type rather than as a convention.
 *
 * -----------------------------------------------------------------------------
 * THE CLOCK IS INJECTED. There is no `new Date()` in this file and there must
 * never be one.
 * =============================================================================
 */

export interface FoxyServiceDeps {
  readonly repository: FoxyRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Already behind its bulkhead, breaker and both timeouts (§3.3, §4, §5). */
  readonly llm: LlmProvider;
  /** Usage counters. NEVER process memory — 00-ARCHITECTURE.md §7. */
  readonly cache: CachePort;
  /** `retrieval.search`, injected. The filters are supplied by this module. */
  readonly search: ChunkSearch;
  /** The RESOURCE side of the tenant comparison, read from `users` (D-091). */
  readonly readTenantOfStudent: TenantReader;
  readonly readStudentContext: StudentContextReader;
  readonly readLanguage: LanguageReader;
  /** `billing` does not exist; the composition root supplies a `free` reader. */
  readonly readPlan: PlanReader;
  /** Stamped on every trace, so a model change is attributable afterwards. */
  readonly model: string;
}

/** A turn, once it is authorised and grounded. Draining it never throws. */
export interface FoxyTurn {
  readonly frames: AsyncIterable<FoxyFrame>;
}

export interface FoxyService {
  startSession(actor: FoxyActor, input: StartSessionInput): Promise<SessionRecord>;
  sendMessage(actor: FoxyActor, sessionId: string, input: SendMessageInput): Promise<FoxyTurn>;
  getSession(actor: FoxyActor, sessionId: string): Promise<SessionWithMessages>;
  listSessions(actor: FoxyActor, limit: number): Promise<readonly SessionRecord[]>;
  getTranscript(actor: FoxyActor, sessionId: string): Promise<readonly MessageRecord[]>;
  getUsage(actor: FoxyActor): Promise<UsageSummary>;
}

/** How many sessions one list request may return when the caller does not say. */
export const SESSION_PAGE_LIMIT = 20;

const SESSION_NOT_FOUND = 'No such conversation.';

/** What a stream that produced nothing at all is stored as. */
const EMPTY_ANSWER_TEXT: Readonly<Record<LanguageCode, string>> = Object.freeze({
  en: 'I could not finish that answer. Please ask me again.',
  hi: 'मैं वह जवाब पूरा नहीं कर सका। कृपया मुझसे फिर पूछो।',
});

interface RetrievedRef {
  readonly chunkId: string;
  readonly score: number;
  readonly rank: number;
}

export function createFoxyService(deps: FoxyServiceDeps): FoxyService {
  const { repository, clock, logger } = deps;

  /**
   * Authorises one operation against one student's chat data. THE ONLY DOOR.
   *
   * `tenantId` IS A PARAMETER and every caller resolves it FROM THE DATA — the
   * session row for session-scoped methods, `users` for actor-scoped ones.
   * There is deliberately no overload that defaults it to `actor.tenantId`:
   * D-091 and D-125 are the record of what that costs, twice, and both fixes
   * were to make the value impossible to supply from the actor.
   *
   * The guard is built per call with a link reader that reports "no link". No
   * parent-facing foxy endpoint exists — a parent reads a transcript through
   * `parent`, which runs its own guard with a real reader — so a parent
   * arriving here is refused by the guard's own rule rather than by this module
   * knowing anything about links.
   */
  function authorise(
    actor: FoxyActor,
    action: 'read' | 'write',
    studentUserId: string,
    tenantId: string,
  ): void {
    const guard = createAccessGuard({ readLinkStatus: () => null });
    guard.assertCanAccess(actor, action, {
      kind: 'student-data',
      studentUserId,
      scope: 'chat',
      tenantId,
    });
  }

  /** The tenant of an ACTOR's own data, read from `users` and never claimed. */
  async function tenantOf(studentUserId: string): Promise<string> {
    return (await deps.readTenantOfStudent(studentUserId)) ?? '';
  }

  /**
   * Loads a session and authorises against THE TENANT ON THE ROW.
   *
   * That is the strongest available form of "from the data": it is the tenant
   * the session was filed under, not one looked up beside it. An unknown
   * session is a 404 after the guard has had nothing to check; a session in
   * another tenant is a contentless 403. Neither carries a payload.
   */
  async function loadSession(
    actor: FoxyActor,
    sessionId: string,
    action: 'read' | 'write',
  ): Promise<SessionRecord> {
    const session = await repository.findSession(sessionId);
    if (session === null) {
      throw new NotFoundError(SESSION_NOT_FOUND, {
        message: 'Foxy session lookup matched no row',
      });
    }
    authorise(actor, action, session.studentUserId, session.tenantId);
    return session;
  }

  /** An ABSENT subscription is `free`, not an error. Most accounts have none. */
  async function planOf(studentUserId: string): Promise<FoxyPlan> {
    return (await deps.readPlan(studentUserId)) ?? 'free';
  }

  async function readUsed(userId: string, now: Date): Promise<number> {
    const raw = await deps.cache.get(usageCacheKey(userId, now));
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    // A corrupt counter reads as ZERO rather than as NaN. NaN compares false
    // against every limit, which fails OPEN — a broken key would silently grant
    // unlimited messages, and nothing would report it.
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  /**
   * Consumes one message from today's allowance.
   *
   * INCREMENT FIRST, THEN JUDGE. Reading, deciding and then incrementing leaves
   * a window in which two concurrent requests read the same value and both
   * proceed; `incr` is atomic, so the value it returns is this request's own
   * position and no two callers can be handed the same one.
   */
  async function consumeUsage(userId: string, plan: FoxyPlan, now: Date): Promise<void> {
    const key = usageCacheKey(userId, now);
    const after = await deps.cache.incr(key);
    // Set the expiry EVERY time. `expire` on an existing key is idempotent, and
    // expiring only when `after === 1` leaves the key immortal if the process
    // dies between the increment and the expiry.
    await deps.cache.expire(key, USAGE_TTL_SECONDS);

    const decision = decideUsage(after - 1, plan);
    if (!decision.allowed) {
      throw new RateLimitError(secondsUntilReset(now), {
        message: 'Foxy daily message limit reached',
        details: { plan, limit: decision.limit },
      });
    }
  }

  /**
   * Refunds the message a REFUSED turn did not spend.
   *
   * Charging a child a message for being told to talk to a trusted adult is
   * indefensible, so a safety refusal costs nothing. An ABSTENTION still costs
   * one: it ran a retrieval, and a free abstention is an unlimited supply of
   * retrievals.
   */
  async function refundUsage(userId: string, now: Date): Promise<void> {
    const key = usageCacheKey(userId, now);
    const current = await readUsed(userId, now);
    if (current > 0) await deps.cache.set(key, String(current - 1), USAGE_TTL_SECONDS);
  }

  /**
   * A turn that ends BEFORE the model — an abstention or a safety refusal.
   *
   * IT IS A COMPLETE, SUCCESSFUL ANSWER. The student's message is stored, the
   * assistant's message is stored with `abstained = true`, a trace row is
   * written, and the frames are `abstention` then `done`. Nothing about the
   * shape of this response says "failure", because it is not one.
   */
  async function endedTurn(input: {
    readonly session: SessionRecord;
    readonly studentText: string;
    readonly action: FoxyAction | null;
    readonly answer: string;
    readonly reason: AbstentionReason;
    readonly grade: Grade;
    readonly query: string;
    readonly rewritten: string;
    readonly retrieved: readonly RetrievedRef[];
    readonly startedAtMs: number;
  }): Promise<FoxyTurn> {
    const { session } = input;
    const at = clock.now();

    await repository.insertMessage({
      sessionId: session.id,
      tenantId: session.tenantId,
      role: 'user',
      content: input.studentText,
      action: input.action,
      citations: [],
      abstained: false,
      createdAt: at,
    });

    const message = await repository.insertMessageWithTrace(
      {
        sessionId: session.id,
        tenantId: session.tenantId,
        role: 'assistant',
        content: input.answer,
        action: null,
        // NO CITATIONS ON AN ABSTENTION — also a CHECK in migration 0005. This
        // is the belt; the constraint is the braces.
        citations: [],
        abstained: true,
        createdAt: at,
      },
      (messageId): TraceInput => ({
        messageId,
        tenantId: session.tenantId,
        query: input.query,
        rewrittenQuery: input.rewritten,
        grade: input.grade,
        subject: session.subject,
        retrieved: input.retrieved,
        citations: [],
        fabricatedCitations: [],
        // EMPTY BECAUSE THERE WAS NO PROMPT. Recorded as the fact it is: this
        // turn never reached the model.
        prompt: '',
        answer: input.answer,
        abstained: true,
        abstainReason: input.reason,
        model: deps.model,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Math.max(0, clock.now().getTime() - input.startedAtMs),
      }),
    );

    await repository.touchSession(session.id, at);

    const frames: readonly FoxyFrame[] = [
      { type: 'abstention', messageId: message.id, reason: input.reason, text: input.answer },
      { type: 'done', messageId: message.id, abstained: true },
    ];

    return {
      frames: {
        [Symbol.asyncIterator]: async function* iterate(): AsyncGenerator<FoxyFrame> {
          await Promise.resolve();
          for (const frame of frames) yield frame;
        },
      },
    };
  }

  /**
   * The model path.
   *
   * ===========================================================================
   * NOTHING BELOW THIS POINT MAY THROW TO THE CALLER.
   *
   * The HTTP response is committed by the time these frames are drained. Every
   * failure becomes an `error` frame and a `done`, and every token that arrived
   * before it is kept — §8.5's "graceful partial response rather than a 500",
   * and §7's requirement that the client keep partial text.
   *
   * THE MESSAGE AND THE TRACE ARE PERSISTED EVEN WHEN THE STREAM FAILS. A half
   * answer the student was shown has to be in the transcript, or the
   * conversation they remember and the one we stored disagree — and the trace
   * is exactly what somebody will want when they ask why it stopped.
   * ===========================================================================
   */
  function streamedTurn(input: {
    readonly session: SessionRecord;
    readonly grade: Grade;
    readonly query: string;
    readonly rewritten: string;
    readonly retrieved: readonly RetrievedRef[];
    readonly chunks: readonly PromptChunk[];
    readonly prompt: AssembledPrompt;
    readonly startedAtMs: number;
  }): FoxyTurn {
    const { session, prompt } = input;

    async function* iterate(): AsyncGenerator<FoxyFrame> {
      const filter = createCitationFilter(input.chunks);
      let answer = '';
      let sentAnything = false;
      let modelFailed = false;

      try {
        const stream = deps.llm.stream({
          messages: [
            { role: 'system', content: prompt.system },
            ...prompt.messages.map((turn) => ({ role: turn.role, content: turn.content })),
          ],
          maxTokens: prompt.maxTokens,
          temperature: prompt.temperature,
        });

        for await (const chunk of stream) {
          const filtered = filter.push(chunk.text);
          if (filtered.text.length > 0) {
            answer += filtered.text;
            sentAnything = true;
            yield { type: 'token', text: filtered.text };
          }
        }

        const tail = filter.flush();
        if (tail.text.length > 0) {
          answer += tail.text;
          sentAnything = true;
          yield { type: 'token', text: tail.text };
        }
      } catch {
        // The error object is deliberately not inspected. A `code`, never a
        // message: an upstream error string can carry a URL, a key fragment, or
        // the prompt itself.
        modelFailed = true;
        logger.warn(
          { sessionId: session.id, partial: sentAnything },
          'foxy: the model stream failed',
        );
      }

      const citations = filter.citations();
      const fabricated = filter.fabricated();
      if (fabricated.length > 0) {
        // A COUNT, not the invented ids. Those are model output and belong on
        // the trace row rather than in a log line.
        logger.warn(
          { sessionId: session.id, count: fabricated.length },
          'foxy: stripped fabricated citations',
        );
      }

      const finishedAt = clock.now();
      let messageId: string;
      try {
        const message = await repository.insertMessageWithTrace(
          {
            sessionId: session.id,
            tenantId: session.tenantId,
            role: 'assistant',
            // An empty answer would violate the content CHECK, which is right —
            // a message with no text is not a message. A stream that failed
            // before its first token stores the honest sentence instead.
            content: answer.length > 0 ? answer : EMPTY_ANSWER_TEXT[prompt.language],
            action: null,
            citations,
            abstained: false,
            createdAt: finishedAt,
          },
          (id): TraceInput => ({
            messageId: id,
            tenantId: session.tenantId,
            query: input.query,
            rewrittenQuery: input.rewritten,
            grade: input.grade,
            subject: session.subject,
            retrieved: input.retrieved,
            citations,
            fabricatedCitations: fabricated,
            prompt: `${prompt.system}\n\n---\n\n${prompt.messages
              .map((turn) => `${turn.role}: ${turn.content}`)
              .join('\n')}`,
            answer,
            abstained: false,
            abstainReason: modelFailed ? 'model_failed' : null,
            model: deps.model,
            // A stream reports no usage; a completion would. Zero is the honest
            // value, and the CHECK requires non-negative rather than NULL.
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: Math.max(0, finishedAt.getTime() - input.startedAtMs),
          }),
        );
        messageId = message.id;
        await repository.touchSession(session.id, finishedAt);
      } catch {
        // Persistence failed AFTER the student saw the answer. Saying so in the
        // stream is all that is left — throwing here would produce the 500 this
        // whole design exists to avoid.
        logger.error({ sessionId: session.id }, 'foxy: failed to persist a turn');
        yield { type: 'error', code: 'internal', partial: sentAnything };
        return;
      }

      // AFTER the message exists, because §7 attaches a citation BY MESSAGE ID
      // and never by arrival position.
      for (const citation of citations) {
        yield { type: 'citation', messageId, citation };
      }
      if (modelFailed) {
        yield { type: 'error', code: 'model_unavailable', partial: sentAnything };
      }
      yield { type: 'done', messageId, abstained: false };
    }

    return { frames: { [Symbol.asyncIterator]: iterate } };
  }

  return {
    async startSession(actor: FoxyActor, input: StartSessionInput): Promise<SessionRecord> {
      const tenantId = await tenantOf(actor.userId);
      authorise(actor, 'write', actor.userId, tenantId);

      const context = await deps.readStudentContext(actor, actor.userId);
      if (!context.subjects.includes(input.subject)) {
        /**
         * REFUSED AT CREATION, not at the first message.
         *
         * A session for a subject the student is not enrolled in would abstain
         * on every turn — correctly, since retrieval is hard-filtered by
         * subject — and the student would experience that as Foxy being broken.
         * Refusing here says the true thing at the moment it is actionable.
         */
        throw new ValidationError('That subject is not on your list yet.', {
          message: 'foxy.startSession: subject is not among the student’s enrolled subjects',
        });
      }

      const language = await deps.readLanguage(actor, actor.userId);
      return await repository.createSession({
        studentUserId: actor.userId,
        // THE TENANT THE GUARD JUST PASSED ON, never the one the actor claimed.
        tenantId,
        mode: input.mode,
        subject: input.subject,
        chapterId: input.chapterId ?? null,
        language,
        startedAt: clock.now(),
      });
    },

    async sendMessage(
      actor: FoxyActor,
      sessionId: string,
      input: SendMessageInput,
    ): Promise<FoxyTurn> {
      const startedAtMs = clock.now().getTime();

      // STEP 1 — authorise, against the tenant on the row.
      const session = await loadSession(actor, sessionId, 'write');

      // STEP 2 — the usage limit. Before retrieval, before the model, before
      // anything that costs money.
      const plan = await planOf(actor.userId);
      const now = clock.now();
      await consumeUsage(actor.userId, plan, now);

      const action = input.action ?? null;
      const spec = action === null ? null : actionSpec(action);
      const language: LanguageCode = spec?.forceLanguage ?? session.language;
      const studentText =
        input.text ?? (action === null ? '' : actionMessageText(action, session.language));

      // STEP 3 — grade and subjects, loaded fresh every turn. See the schema
      // header for why the grade is not frozen on the session.
      const context = await deps.readStudentContext(actor, session.studentUserId);

      const ended = (
        answer: string,
        reason: AbstentionReason,
        retrieved: readonly RetrievedRef[],
        rewritten: string,
      ): Promise<FoxyTurn> =>
        endedTurn({
          session,
          studentText,
          action,
          answer,
          reason,
          grade: context.grade,
          query: studentText,
          rewritten,
          retrieved,
          startedAtMs,
        });

      // STEP 4 — SAFETY, BEFORE THE MODEL AND BEFORE RETRIEVAL. See
      // `domain/safety.ts` for why this side of the model rather than the other.
      const verdict = classifyInput(studentText);
      if (!verdict.allowed && verdict.category !== undefined) {
        await refundUsage(actor.userId, now);
        return await ended(
          refusalMessage(verdict.category, language),
          'refused',
          [],
          studentText,
        );
      }

      /**
       * The student's own words are checked for identity too.
       *
       * The safety classifier catches the INTENT ("what is your whatsapp"); this
       * catches the DIGITS. Refused rather than redacted — a silently stripped
       * phone number teaches nobody anything, and the student has not consented
       * to it reaching a third party either way.
       */
      try {
        assertNoIdentity(studentText);
      } catch (error) {
        if (!(error instanceof PromptIdentityLeak)) throw error;
        await refundUsage(actor.userId, now);
        return await ended(
          refusalMessage('personal_contact', language),
          'refused',
          [],
          studentText,
        );
      }

      if (!context.subjects.includes(session.subject)) {
        return await ended(
          abstentionMessage('out_of_scope', language),
          'out_of_scope',
          [],
          studentText,
        );
      }

      // STEP 5 — retrieval, hard filtered. The filters come from the session and
      // the profile; there is no argument a caller could supply to widen them.
      const retrieval = await deps.search(studentText, {
        grade: context.grade,
        subject: session.subject,
      });
      const retrieved: RetrievedRef[] = retrieval.chunks.map((chunk) => ({
        chunkId: chunk.id,
        score: chunk.score,
        rank: chunk.rank,
      }));

      // STEP 6 — THE ABSTENTION BRANCH. The model is never called below this
      // line. This is the single most important `if` in the module.
      if (retrieval.shouldAbstain || retrieval.chunks.length === 0) {
        const reason = fromRetrievalReason(retrieval.abstainReason);
        return await ended(
          abstentionMessage(reason, language),
          reason,
          retrieved,
          retrieval.normalisedQuery,
        );
      }

      // STEP 7 — the prompt. The history window is read BEFORE the student's
      // message is stored, so the question is not also in the history.
      const history = await repository.listMessages(session.id, session.tenantId);
      await repository.insertMessage({
        sessionId: session.id,
        tenantId: session.tenantId,
        role: 'user',
        content: studentText,
        action,
        citations: [],
        abstained: false,
        createdAt: now,
      });

      const chunks: PromptChunk[] = retrieval.chunks.map((chunk) => ({
        id: chunk.id,
        chunkText: chunk.chunkText,
        chapterNumber: chunk.chapterNumber,
        chapterTitle: chunk.chapterTitle,
      }));

      const prompt = assemblePrompt({
        mode: session.mode,
        ...(action === null ? {} : { action }),
        grade: context.grade,
        subject: session.subject,
        language,
        question: studentText,
        history: history.slice(-FOXY_HISTORY_TURNS).map((message) => ({
          role: message.role,
          content: message.content,
        })),
        chunks,
      });

      // STEPS 8-10.
      return streamedTurn({
        session,
        grade: context.grade,
        query: studentText,
        rewritten: retrieval.normalisedQuery,
        retrieved,
        chunks,
        prompt,
        startedAtMs,
      });
    },

    async getSession(actor: FoxyActor, sessionId: string): Promise<SessionWithMessages> {
      const session = await loadSession(actor, sessionId, 'read');
      const messages = await repository.listMessages(session.id, session.tenantId);
      return { session, messages };
    },

    async listSessions(actor: FoxyActor, limit: number): Promise<readonly SessionRecord[]> {
      const tenantId = await tenantOf(actor.userId);
      authorise(actor, 'read', actor.userId, tenantId);
      return await repository.listSessions(actor.userId, tenantId, limit);
    },

    async getTranscript(actor: FoxyActor, sessionId: string): Promise<readonly MessageRecord[]> {
      const session = await loadSession(actor, sessionId, 'read');
      return await repository.listMessages(session.id, session.tenantId);
    },

    async getUsage(actor: FoxyActor): Promise<UsageSummary> {
      const tenantId = await tenantOf(actor.userId);
      authorise(actor, 'read', actor.userId, tenantId);
      const now = clock.now();
      const plan = await planOf(actor.userId);
      const used = await readUsed(actor.userId, now);
      const decision = decideUsage(used, plan);
      return {
        plan,
        used,
        limit: decision.limit,
        // `limit - used`, NOT `decision.remaining` — the decision's figure has
        // already subtracted the prospective message it was asked about, and a
        // summary is a statement about now rather than about a message nobody
        // has sent.
        remaining: Math.max(0, decision.limit - used),
      };
    },
  };
}

export type { Citation };
