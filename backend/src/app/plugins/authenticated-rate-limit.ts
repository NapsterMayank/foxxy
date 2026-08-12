import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import type { RateLimiter } from '../../platform/rate-limit/index';
import { AUTHENTICATED_RATE_LIMIT } from '../../shared/constants/rate-limits';
import type { RateLimitRule } from '../../shared/constants/rate-limits';

/**
 * THE GLOBAL AUTHENTICATED RATE LIMIT — 01-BACKEND-IMPLEMENTATION-PLAN.md §6.9,
 * last row. 100 requests per minute, keyed by user id.
 *
 * ===========================================================================
 * IT WAS DECLARED FOR TWO BUILD CYCLES AND ENFORCED NOWHERE.
 *
 * `AUTHENTICATED_RATE_LIMIT` has existed in `shared/constants/rate-limits.ts`
 * since the identity module landed, deferred on "a second module having routes".
 * There are now three, and until this file existed `/me/*` and `/content/*` were
 * completely unthrottled for any caller holding a session — the per-endpoint
 * limits all sit on UNAUTHENTICATED auth routes.
 *
 * ===========================================================================
 * IT IS A BACKSTOP, NOT A POLICY, AND IT DOES NOT DOUBLE-COUNT.
 *
 * The per-endpoint limits (signup 3/h, login 5/15m, link submit 5/h, link code
 * 5/h) are stricter and are what actually protect those endpoints. This one
 * exists so that an endpoint nobody thought about is bounded BY DEFAULT rather
 * than unbounded by default.
 *
 * Its counters live under their own key namespace (`rl:global:authenticated:`),
 * separate from identity's `rl:identity:`. One request therefore increments this
 * counter exactly once and the per-endpoint counter exactly once — never one
 * twice, and never one instead of the other. The stricter limit is the one that
 * fires first, because it is the one that runs out first.
 *
 * ===========================================================================
 * REGISTERED VIA `onRoute`, AND THE REASON IS NOT STYLE.
 *
 * The key is the USER ID, so this hook must run AFTER session validation. That
 * rules out every application-level hook Fastify offers: `onRequest`,
 * `preParsing`, `preValidation` and app-level `preHandler` all run BEFORE a
 * route's own `preHandler`, which is where `requireSession` lives and where
 * `request.actor` is attached. An app-level hook would see `actor` undefined on
 * every single request and silently throttle nothing — a limiter that looks
 * installed and enforces zero, which is worse than no limiter at all because
 * nobody looks at it again.
 *
 * So the plugin listens for `onRoute` and APPENDS itself to each route's
 * `preHandler` chain, after whatever the module declared. That gets the
 * ordering, and it gets the property that matters more: EVERY FUTURE MODULE
 * INHERITS IT WITHOUT OPTING IN. A throttle each module has to remember is a
 * throttle the twelfth module forgets — the same reasoning as the origin check
 * in `origin-check.ts`.
 *
 * The consequence to know about: this must be registered BEFORE any routes are.
 * `onRoute` fires as routes are added, so a route registered earlier never sees
 * it. `createServer` registers it before both the health routes and the modules,
 * and a test drives a real module route to prove the wiring rather than
 * asserting on the hook.
 *
 * ===========================================================================
 * AN UNAUTHENTICATED REQUEST IS NOT THROTTLED HERE.
 *
 * No actor means no user id means no key. Those routes are covered by the
 * per-endpoint limits, which are keyed by IP precisely because there is nobody
 * to key by. Falling back to an IP key here would be worse than nothing: it
 * would put every student in a school behind one NAT into a single 100/min
 * bucket.
 */

/** Separate from identity's `rl:identity:` namespace. See the note above. */
export const GLOBAL_RATE_LIMIT_KEY_PREFIX = 'rl:global:authenticated';

export function authenticatedRateLimitKey(userId: string): string {
  return `${GLOBAL_RATE_LIMIT_KEY_PREFIX}:${userId}`;
}

export interface AuthenticatedRateLimitOptions {
  readonly limiter: RateLimiter;
  /** Defaults to §6.9's 100/minute. A parameter so a test need not send 101. */
  readonly rule?: RateLimitRule;
}

export function registerAuthenticatedRateLimit(
  app: FastifyInstance,
  options: AuthenticatedRateLimitOptions,
): void {
  const rule = options.rule ?? AUTHENTICATED_RATE_LIMIT;

  async function throttle(request: FastifyRequest): Promise<void> {
    const actor = request.actor;
    // Unauthenticated: the per-endpoint IP limits own this request.
    if (actor === undefined) return;
    await options.limiter.consume(authenticatedRateLimitKey(actor.userId), rule);
  }

  app.addHook('onRoute', (routeOptions: RouteOptions) => {
    const existing = routeOptions.preHandler;

    // APPENDED, never prepended. Prepending would run this before
    // `requireSession` and `request.actor` would always be undefined — the
    // silent no-op described at the top of this file.
    if (existing === undefined) {
      routeOptions.preHandler = [throttle];
      return;
    }
    routeOptions.preHandler = Array.isArray(existing)
      ? [...existing, throttle]
      : [existing, throttle];
  });
}
