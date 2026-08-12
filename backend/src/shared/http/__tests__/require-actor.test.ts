import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { requireActor } from '../require-actor';

/**
 * =============================================================================
 * D-263 — THE ONE `requireActor`, WHICH FOUR MODULES USED TO CARRY A COPY OF.
 *
 * `notify`, `parent`, `billing` and `foxy` each held a byte-identical fourteen
 * lines, differing only in the module name inside the error string. The risk of
 * that duplication is not the duplication: it is that FOUR copies can diverge,
 * and the direction one of them would plausibly diverge in is "return
 * `undefined` instead of throwing, because a 500 looked unfriendly" — which
 * turns a wiring defect into an unauthenticated read that nothing reports.
 *
 * So the behaviour is pinned here, once, rather than trusted to four route
 * suites that each only exercise the happy path.
 * =============================================================================
 */

/** Just enough of a request. The function reads exactly one property. */
function requestWith(actor: FastifyRequest['actor']): FastifyRequest {
  return { actor } as FastifyRequest;
}

const ACTOR = {
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'student',
  tenantId: '22222222-2222-4222-8222-222222222222',
} as const;

describe('requireActor', () => {
  it('returns the actor the session preHandler attached', () => {
    expect(requireActor(requestWith(ACTOR), 'notify')).toBe(ACTOR);
  });

  it('THROWS when the preHandler was not registered, rather than returning undefined', () => {
    // The whole point. A missing actor means the route is assembled wrong; the
    // tempting alternatives are worse than a 500. Returning `undefined` makes
    // every call site responsible for a null check, and answering 401 makes an
    // unauthenticated route look like an authentication failure and stay
    // unauthenticated forever, because nothing ever reports it.
    expect(() => requireActor(requestWith(undefined), 'notify')).toThrow();
  });

  it('NAMES THE MODULE, because the message is only actionable if it does', () => {
    // "missing the requireSession preHandler" without a module name tells an
    // operator that something is misconfigured and nothing about where.
    for (const moduleName of ['notify', 'parent', 'billing', 'foxy']) {
      expect(() => requireActor(requestWith(undefined), moduleName)).toThrow(
        `${moduleName} routes: missing the requireSession preHandler`,
      );
    }
  });
});
