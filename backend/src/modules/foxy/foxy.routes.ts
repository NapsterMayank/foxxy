import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type {
  FoxyCapabilitiesResponse,
  FoxyMessageDto,
  FoxySessionDto,
  FoxySessionListResponse,
  FoxySessionResponse,
} from '@/shared/contracts/foxy.contract';
import { requireActor as requireRequestActor } from '@/shared/http/require-actor';
import { listActions } from './domain/actions';
import { listModes } from './domain/modes';
import { SSE_HEADERS, encodeFrame } from './domain/sse';
import { foxySchemas, parseInput } from './foxy.schema';
import type { FoxyService } from './foxy.service';
import type { FoxyActor, MessageRecord, SessionRecord } from './foxy.types';

/**
 * HTTP only — §2, layer table.
 *
 * Every handler does three things: validate the input, call ONE service method,
 * format the result. There is no `if` about a business rule in this file, no
 * arithmetic, and no database access. The access checks are all in the service,
 * which is where §7's "there is no second place where access is decided" is
 * kept true.
 *
 * THE STUDENT ID COMES FROM THE SESSION, NEVER FROM THE PATH OR THE BODY. The
 * only identifier a caller supplies is a conversation id, and the service
 * resolves that conversation's owner and tenant FROM THE ROW before it
 * authorises.
 *
 * ===========================================================================
 * THE SSE HANDLER IS THE ONE PLACE THIS FILE IS NOT ORDINARY, SO: HOW IT WORKS.
 *
 * `service.sendMessage` returns a PROMISE of a stream. Everything that has an
 * HTTP status — 403, 404, 429, 400 — rejects that promise, and it rejects
 * BEFORE any byte is written, so the error plugin renders it as an ordinary
 * JSON error response with the right code.
 *
 * Once it resolves, the status is 200 and the headers are flushed, and from
 * that point there is no status left to change. Draining the stream cannot
 * throw — the service guarantees it — and any failure it encountered arrives as
 * an `error` FRAME with the tokens that preceded it intact. That is §8.5's
 * "graceful partial response rather than a 500".
 *
 * `reply.hijack()` hands the socket over: Fastify stops trying to serialise a
 * body, and this handler owns the response until it ends it. Without it,
 * Fastify's own serialiser races the writes.
 * ===========================================================================
 */

const API_PREFIX = '/api/v1';

/**
 * D-263 — one implementation, in `shared/http`, bound to this module's name and
 * actor type. Three other modules carried a byte-identical copy of the body.
 */
function requireActor(request: FastifyRequest): FoxyActor {
  return requireRequestActor(request, 'foxy');
}

function toSessionDto(session: SessionRecord): FoxySessionDto {
  return {
    id: session.id,
    mode: session.mode,
    subject: session.subject,
    chapterId: session.chapterId,
    language: session.language,
    // ISO STRINGS on the wire. A `Date` here would be serialised by whatever
    // JSON serialiser happened to run — the defect D-124 records for the
    // digest and transcript paths.
    startedAt: session.startedAt.toISOString(),
    lastMessageAt: session.lastMessageAt === null ? null : session.lastMessageAt.toISOString(),
  };
}

function toMessageDto(message: MessageRecord): FoxyMessageDto {
  return {
    id: message.id,
    role: message.role,
    text: message.content,
    action: message.action,
    citations: message.citations.map((citation) => ({
      chunkId: citation.chunkId,
      chapterNumber: citation.chapterNumber,
      chapterTitle: citation.chapterTitle,
    })),
    abstained: message.abstained,
    createdAt: message.createdAt.toISOString(),
  };
}

export interface FoxyRoutesDeps {
  readonly service: FoxyService;
  /** Identity's session validator, injected at the composition root. */
  readonly requireSession: preHandlerAsyncHookHandler;
}

export function registerFoxyRoutes(app: FastifyInstance, deps: FoxyRoutesDeps): void {
  const authenticated = { preHandler: deps.requireSession };

  /** §8.5 — opens a conversation. The grade comes from the profile, not here. */
  app.post(`${API_PREFIX}/foxy/sessions`, authenticated, async (request, reply) => {
    const input = parseInput(foxySchemas.startSession, request.body);
    // `exactOptionalPropertyTypes` — an absent `chapterId` is OMITTED rather
    // than passed as `undefined`. The two are different facts to the type
    // system, and "present and undefined" is the shape that would eventually
    // write a NULL nobody intended.
    const session = await deps.service.startSession(requireActor(request), {
      mode: input.mode,
      subject: input.subject,
      ...(input.chapterId === undefined ? {} : { chapterId: input.chapterId }),
    });
    const body: FoxySessionResponse = { session: toSessionDto(session) };
    return reply.status(201).send(body);
  });

  /** §8.5 — one turn, streamed as server-sent events. See the header. */
  app.post(
    `${API_PREFIX}/foxy/sessions/:id/messages`,
    authenticated,
    async (request, reply): Promise<void> => {
      const params = parseInput(foxySchemas.sessionIdParam, request.params);
      const input = parseInput(foxySchemas.sendMessage, request.body);

      // Rejects BEFORE any byte is written. The error plugin renders it.
      const turn = await deps.service.sendMessage(requireActor(request), params.id, {
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.action === undefined ? {} : { action: input.action }),
      });

      await streamTurn(reply, turn.frames);
    },
  );

  /** §8.5 — the student's own conversations, newest first. */
  app.get(`${API_PREFIX}/foxy/sessions`, authenticated, async (request, reply) => {
    const query = parseInput(foxySchemas.listQuery, request.query);
    const sessions = await deps.service.listSessions(requireActor(request), query.limit);
    const body: FoxySessionListResponse = { sessions: sessions.map(toSessionDto) };
    return reply.status(200).send(body);
  });

  /** §8.5 — one conversation and its full transcript. */
  app.get(`${API_PREFIX}/foxy/sessions/:id`, authenticated, async (request, reply) => {
    const params = parseInput(foxySchemas.sessionIdParam, request.params);
    const result = await deps.service.getSession(requireActor(request), params.id);
    const body: FoxySessionResponse = {
      session: toSessionDto(result.session),
      messages: result.messages.map(toMessageDto),
    };
    return reply.status(200).send(body);
  });

  /**
   * The fixed action set, the modes, and today's remaining allowance.
   *
   * SERVED rather than hardcoded in the client, so the guided interface has ONE
   * definition. A client with its own copy of the list eventually renders a
   * button the server does not implement, and that fails at the moment a child
   * presses it.
   */
  app.get(`${API_PREFIX}/foxy/capabilities`, authenticated, async (request, reply) => {
    const usage = await deps.service.getUsage(requireActor(request));
    const body: FoxyCapabilitiesResponse = {
      modes: listModes().map((mode) => ({ code: mode.code })),
      actions: listActions().map((action) => ({ code: action.code, label: action.label })),
      usage,
    };
    return reply.status(200).send(body);
  });
}

/**
 * Writes a frame stream to the socket, and ends it exactly once.
 *
 * Extracted so the handler above stays three lines and so this — the only piece
 * of genuinely delicate transport code in the module — is readable on its own.
 */
async function streamTurn(reply: FastifyReply, frames: AsyncIterable<FoxyFrameLike>): Promise<void> {
  reply.raw.writeHead(200, { ...SSE_HEADERS });
  // Fastify must stop managing this response: it owns the socket from here.
  reply.hijack();

  try {
    for await (const frame of frames) {
      reply.raw.write(encodeFrame(frame));
    }
  } catch {
    // The service guarantees the stream does not throw, so reaching this is a
    // defect rather than a failure mode. Even so it must not become an
    // unhandled rejection on a hijacked socket, which would leave the client
    // waiting forever — a frame and a clean end is the honest ending.
    reply.raw.write(encodeFrame({ type: 'error', code: 'internal', partial: true }));
  } finally {
    reply.raw.end();
  }
}

/** Structural, so this transport helper needs no import from the domain. */
type FoxyFrameLike = Parameters<typeof encodeFrame>[0];
