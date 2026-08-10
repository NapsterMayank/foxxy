import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { parentSchemas, parseInput } from './parent.schema';
import type { ParentService } from './parent.service';
import type { ParentActor } from './parent.types';

/**
 * HTTP only — §2, layer table.
 *
 * Every handler does three things: validate the input, call ONE service method,
 * format the result. There is no `if` about a business rule in this file, no
 * arithmetic, and no database access.
 *
 * ===========================================================================
 * THE ACCESS DECISION IS NOT MADE HERE, AND THAT IS THE POINT.
 *
 * A child id arrives in the path on five of these six endpoints — this is the
 * only module in the product where a caller names somebody else's data — and
 * not one handler below looks at it before passing it on. Every check is in the
 * service, which is where §7's "there is no second place where access is
 * decided" is kept true.
 *
 * The parent id is taken from the SESSION, never from the path, the query or
 * the body. There is no field a caller could send to read another parent's
 * children.
 * ===========================================================================
 *
 * ALL SIX RESPOND IDENTICALLY ON A DENY: the error plugin renders every
 * `ForbiddenError` as the same contentless 403 body. A deny for "not linked",
 * "no such child", "pending" and "another tenant" is therefore byte-identical,
 * which `parent.routes.test.ts` asserts by comparing the raw payloads.
 */

const API_PREFIX = '/api/v1';

function requireActor(request: FastifyRequest): ParentActor {
  const actor = request.actor;
  if (actor === undefined) {
    throw new Error('parent routes: missing the requireSession preHandler');
  }
  return actor;
}

/** `?week=YYYY-MM-DD` — any day in the week; the service normalises it. */
function weekFrom(query: { readonly week?: string | undefined }): Date | undefined {
  return query.week === undefined ? undefined : new Date(`${query.week}T00:00:00.000Z`);
}

export interface ParentRoutesDeps {
  readonly service: ParentService;
  /** Identity's session validator, injected at the composition root. */
  readonly requireSession: preHandlerAsyncHookHandler;
}

export function registerParentRoutes(app: FastifyInstance, deps: ParentRoutesDeps): void {
  const authenticated = { preHandler: deps.requireSession };

  /** §8.7 — the parent's approved children. The id comes from the session. */
  app.get(`${API_PREFIX}/parent/children`, authenticated, async (request, reply) => {
    const children = await deps.service.getChildren(requireActor(request));
    return reply.status(200).send({ children });
  });

  /** §8.7 — four headline numbers and one trend, for one week. */
  app.get(`${API_PREFIX}/parent/children/:id/snapshot`, authenticated, async (request, reply) => {
    const params = parseInput(parentSchemas.childIdParam, request.params);
    const query = parseInput(parentSchemas.weekQuery, request.query);
    const result = await deps.service.getSnapshot(
      requireActor(request),
      params.id,
      weekFrom(query),
    );
    return reply.status(200).send({ childUserId: result.childUserId, ...result.snapshot });
  });

  /**
   * §8.7 — the stored digest for a week, or null.
   *
   * 200 WITH `digest: null`, not a 404. "This week's digest has not been
   * produced yet" is an ordinary state of an existing resource, and a 404 here
   * would be indistinguishable from the 404 an unknown child would deserve —
   * which is exactly the oracle every deny path in this module avoids.
   */
  app.get(`${API_PREFIX}/parent/children/:id/digest`, authenticated, async (request, reply) => {
    const params = parseInput(parentSchemas.childIdParam, request.params);
    const query = parseInput(parentSchemas.weekQuery, request.query);
    const digest = await deps.service.getDigest(requireActor(request), params.id, weekFrom(query));
    return reply.status(200).send({ digest });
  });

  /** §8.7 — the child's Foxy conversations. Read-only, and the child knows. */
  app.get(`${API_PREFIX}/parent/children/:id/transcript`, authenticated, async (request, reply) => {
    const params = parseInput(parentSchemas.childIdParam, request.params);
    const query = parseInput(parentSchemas.transcriptQuery, request.query);
    const transcript = await deps.service.getChildTranscript(
      requireActor(request),
      params.id,
      query.limit,
    );
    return reply.status(200).send(transcript);
  });

  /** §8.7 — what this parent may see, and that the child was asked first. */
  app.get(`${API_PREFIX}/parent/children/:id/consent`, authenticated, async (request, reply) => {
    const params = parseInput(parentSchemas.childIdParam, request.params);
    const consent = await deps.service.getConsentState(requireActor(request), params.id);
    return reply.status(200).send(consent);
  });

  /**
   * §8.7 — the parent withdraws their own access.
   *
   * POST rather than DELETE: the link row is not deleted, it moves to
   * `revoked`, and the record that access once existed is part of what a
   * consent trail is for.
   */
  app.post(
    `${API_PREFIX}/parent/children/:id/consent/revoke`,
    authenticated,
    async (request, reply) => {
      const params = parseInput(parentSchemas.childIdParam, request.params);
      const result = await deps.service.revokeConsent(requireActor(request), params.id);
      return reply.status(200).send(result);
    },
  );
}
