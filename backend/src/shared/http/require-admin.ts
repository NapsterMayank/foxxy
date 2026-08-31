import type { FastifyReply, FastifyRequest } from 'fastify';
import { NotFoundError } from '@/platform/errors/index';

/**
 * =============================================================================
 * THE ADMIN GATE — the only door to `/admin`.
 *
 * Composed from identity's `requireSession` rather than importing it: the
 * session validator is INJECTED at the composition root, exactly as every
 * module's routes take it, so this file adds no cross-module edge to the
 * dependency graph that `app/routes.ts` is supposed to state completely.
 *
 * -----------------------------------------------------------------------------
 * IT ANSWERS 404, NOT 403, AND THAT IS THE POINT.
 *
 * A 403 says "this route exists and you may not use it", which tells an
 * unauthenticated prober the shape of the internal surface for free: which
 * paths are real, which resource ids resolve, how the admin API is laid out.
 * The client architecture doc §13.2 names `RESOURCE_NOT_FOUND` for exactly this
 * — "use where existence should not be disclosed" — and an operations panel
 * that can read every learner's record is the strongest case for it in the
 * product.
 *
 * So to a student, a parent, and to anyone with no session at all, `/admin`
 * simply is not there. The 401 from `requireSession` still happens first for a
 * missing or dead session, because that is about the CALLER's credentials
 * rather than about the route, and a browser holding a stale cookie needs to be
 * told to stop sending it.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS GATE DOES NOT DO, STATED SO NOBODY ASSUMES OTHERWISE.
 *
 * It does not call `assertCanAccess`. It cannot: that guard's contract is
 * deny-on-tenant-mismatch, and an operations surface reads across every tenant
 * and every learner by definition. **The admin routes deliberately bypass the
 * one authorisation primitive in this codebase that is airtight**, and that is
 * the cost of the feature rather than an oversight in it.
 *
 * Three things stand in for it, and all three are load-bearing:
 *
 *   1. THIS GATE is the only door — no admin route may omit it, which
 *      `admin-routes-are-gated.test.ts` proves by walking Fastify's own route
 *      table rather than by trusting a list somebody maintains (D-075).
 *   2. EVERY READ IS AUDITED, so "who looked at that child's transcript" has an
 *      answer.
 *   3. NOTHING WRITES. The admin repository contains no insert, update or
 *      delete, and a lint rule fails the build if one appears.
 *
 * Remove any one of the three and this stops being defensible.
 * =============================================================================
 */

/** The one role that may reach `/admin`. Not a list — a list would grow. */
const ADMIN_ROLE = 'super_admin';

/**
 * The session validator as a PLAIN function, not as `preHandlerAsyncHookHandler`.
 *
 * Fastify's hook type carries a `this: FastifyInstance` binding, which is right
 * for a hook Fastify itself invokes and wrong for one this file CALLS: there is
 * no instance to bind, and typing it that way makes the call a compile error.
 * `createRequireSession` genuinely returns this shape; the hook type is what it
 * is widened to at the point of registration.
 */
export type SessionPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface RequireAdminDeps {
  /** Identity's session validator, injected at the composition root. */
  readonly requireSession: SessionPreHandler;
}

/**
 * Builds the `/admin` preHandler.
 *
 * Runs `requireSession` FIRST and lets its rejection through untouched — that
 * path clears the session cookie, and short-circuiting it here would leave a
 * browser retrying a dead token for ever.
 */
export function createRequireAdmin(deps: RequireAdminDeps): SessionPreHandler {
  return async function requireAdmin(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    await deps.requireSession(request, reply);

    if (request.actor?.role !== ADMIN_ROLE) {
      /**
       * The SAME error object a genuinely missing route would produce, with a
       * message that says nothing. A message like "admin only" would undo the
       * whole 404 by explaining it, and this is the one place where being
       * helpful to the caller is the vulnerability.
       *
       * The second argument is the LOG line, which is not sent to the caller —
       * so the operator keeps the detail the prober is denied.
       */
      throw new NotFoundError('Not found.', {
        message: `admin gate: role ${request.actor?.role ?? 'none'} is not ${ADMIN_ROLE}`,
      });
    }
  };
}
