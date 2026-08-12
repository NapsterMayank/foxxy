import type { FastifyRequest } from 'fastify';

/**
 * =============================================================================
 * ONE `requireActor`, FOR THE FOUR MODULES THAT HAD FOUR OF THEM — D-263.
 *
 * `notify`, `parent`, `billing` and `foxy` each carried a byte-identical
 * fourteen-line copy of this function, differing only in the module name inside
 * the error string. `content`, `learner` and `practice` carry a fifth, sixth and
 * seventh; `identity` exports an eighth from `identity.plugin.ts`. THIS FILE
 * CONSOLIDATES THE FOUR IT IS ENTITLED TO and no more — the other four belong to
 * changes in flight, and are reported rather than edited.
 *
 * -----------------------------------------------------------------------------
 * WHY `shared/` AND NOT `identity`'s EXPORTED COPY.
 *
 * `identity.plugin.ts` already exports exactly this function. Importing it would
 * be four new cross-module edges, and 00-ARCHITECTURE.md Foundation 1 —
 * "a module is reached only through its index, and every cross-module dependency
 * is INJECTED rather than imported" — is what keeps `app/routes.ts` the complete
 * dependency graph. Deduplicating by adding hidden edges to the graph would cost
 * more than the duplication does.
 *
 * `shared/` is the one place all four may import from that is not another
 * module. It holds no business rules and no state; this function reads one
 * property and throws, which is exactly that kind of thing.
 *
 * -----------------------------------------------------------------------------
 * IT THROWS, AND IT MUST NEVER STOP THROWING.
 *
 * Reaching a handler with no actor means the `requireSession` preHandler was not
 * registered on the route. That is a WIRING DEFECT, not a user condition — and
 * the tempting alternatives are both worse than a 500: returning `undefined`
 * makes every call site responsible for a null check, and returning a 401 makes
 * an unauthenticated route look like an authentication failure and stay
 * unauthenticated forever, because nothing ever reports it.
 *
 * A plain `Error` rather than one of `platform/errors`' typed errors, on
 * purpose: those are for conditions with an HTTP answer. This one has no honest
 * status other than "the server is assembled wrong".
 * =============================================================================
 */

/**
 * The actor the session preHandler attached, or a thrown wiring error.
 *
 * The return type is read off the Fastify request declaration rather than
 * restated, so a change to what a session produces cannot leave a second,
 * narrower copy of that type in this file quietly disagreeing with it.
 */
export type RequestActor = NonNullable<FastifyRequest['actor']>;

/**
 * @param moduleName Named in the error, because "missing the requireSession
 * preHandler" is only actionable if it says which routes are missing it.
 */
export function requireActor(request: FastifyRequest, moduleName: string): RequestActor {
  const actor = request.actor;
  if (actor === undefined) {
    throw new Error(`${moduleName} routes: missing the requireSession preHandler`);
  }
  return actor;
}
