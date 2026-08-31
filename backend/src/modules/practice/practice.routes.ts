import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type {
  HistoryResponse,
  MissionResponse,
  PracticeSessionResponse,
  ProgressResponse,
  SubmissionResponse,
} from '@/shared/contracts/practice.contract';
import { readVisitId } from '@/shared/http/visit-id';
import { parseInput, practiceSchemas } from './practice.schema';
import type { PracticeService } from './practice.service';
import type { PracticeActor } from './practice.types';

/**
 * HTTP only — §2, layer table.
 *
 * Every handler does three things: validate the input, call ONE service method,
 * format the result. There is no `if` about a business rule in this file, no
 * arithmetic, and no database access. The access checks are all in the service:
 * a route that decided access would be a second place access is decided, which
 * is the one thing §7 exists to prevent.
 *
 * THE STUDENT ID COMES FROM THE SESSION, NEVER FROM THE PATH OR THE BODY. The
 * only identifier a caller supplies is a session id, and the service resolves
 * that session's owner and tenant FROM THE ROW before it authorises. So there
 * is no field to change in order to reach somebody else's practice, and the
 * guard is still called on every one of them.
 */

const API_PREFIX = '/api/v1';

function requireActor(request: FastifyRequest): PracticeActor {
  const actor = request.actor;
  if (actor === undefined) {
    throw new Error('practice routes: missing the requireSession preHandler');
  }
  return actor;
}

export interface PracticeRoutesDeps {
  readonly service: PracticeService;
  /** Identity's session validator, injected at the composition root. */
  readonly requireSession: preHandlerAsyncHookHandler;
}

export function registerPracticeRoutes(app: FastifyInstance, deps: PracticeRoutesDeps): void {
  const authenticated = { preHandler: deps.requireSession };

  /** §8.6 — Today's Mission, with the reason it was chosen. */
  app.get(`${API_PREFIX}/practice/mission`, authenticated, async (request, reply) => {
    const mission = await deps.service.getTodaysMission(requireActor(request));
    const body: MissionResponse = { mission };
    return reply.status(200).send(body);
  });

  /** §8.6 — draws the questions and freezes their order for this session. */
  app.post(`${API_PREFIX}/practice/sessions`, authenticated, async (request, reply) => {
    const input = parseInput(practiceSchemas.startSession, request.body);
    // D-401 — the `X-Visit-Id` header, not the body. See `shared/http/visit-id`.
    const session = await deps.service.startSession(
      requireActor(request),
      input,
      readVisitId(request),
    );
    const body: PracticeSessionResponse = { session };
    return reply.status(201).send(body);
  });

  /** §8.6 — the session as the student sees it. Never carries an answer. */
  app.get(`${API_PREFIX}/practice/sessions/:id`, authenticated, async (request, reply) => {
    const params = parseInput(practiceSchemas.sessionIdParam, request.params);
    const session = await deps.service.getSession(requireActor(request), params.id);
    const body: PracticeSessionResponse = { session };
    return reply.status(200).send(body);
  });

  /**
   * §8.6 — one answer.
   *
   * 200 rather than 201: the answer is recorded onto the session that already
   * exists rather than creating a resource, and a 201 would promise one that has
   * no URL.
   *
   * A SECOND ANSWER TO THE SAME QUESTION IS A 409 from the service — D-281. It
   * used to replace the previous one, which combined with the answer key this
   * response discloses was a way to score 100% on a session answered entirely
   * wrong. The status is the same one a duplicate submit gets, for the same
   * reason: a 200 that quietly kept the first answer would let a client believe
   * the second one landed.
   */
  app.post(`${API_PREFIX}/practice/sessions/:id/answers`, authenticated, async (request, reply) => {
    const params = parseInput(practiceSchemas.sessionIdParam, request.params);
    const input = parseInput(practiceSchemas.submitAnswer, request.body);
    const result = await deps.service.submitAnswer(requireActor(request), params.id, input);
    return reply.status(200).send({ result });
  });

  /**
   * §8.6 — submission. One transaction, and refused if it has already happened.
   *
   * The duplicate is a 409 from the service, not a 200 with the previous
   * result: an idempotent-looking success would let a client believe a second
   * award landed. Nothing about the request body distinguishes the two, so the
   * status code has to.
   */
  app.post(`${API_PREFIX}/practice/sessions/:id/submit`, authenticated, async (request, reply) => {
    const params = parseInput(practiceSchemas.sessionIdParam, request.params);
    const result = await deps.service.submitSession(requireActor(request), params.id);
    const body: SubmissionResponse = { result };
    return reply.status(200).send(body);
  });

  /** §8.6 — the student's own history, newest first. */
  app.get(`${API_PREFIX}/practice/history`, authenticated, async (request, reply) => {
    const query = parseInput(practiceSchemas.historyQuery, request.query);
    const sessions = await deps.service.getHistory(requireActor(request), query.limit);
    const body: HistoryResponse = { sessions };
    return reply.status(200).send(body);
  });

  /** §8.6 — progress. Evidence labels and a ledger sum, never a percentage. */
  app.get(`${API_PREFIX}/practice/progress`, authenticated, async (request, reply) => {
    const progress = await deps.service.getProgress(requireActor(request));
    const body: ProgressResponse = progress;
    return reply.status(200).send(body);
  });
}
