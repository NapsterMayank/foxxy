import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityService } from './identity.service';
import type { SessionActor } from './identity.types';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The authenticated caller, attached by `requireSession`.
     *
     * `{ userId, role }` and NOTHING ELSE (§6.5, step 5). It is deliberately
     * not the user row: routes start reading fields off it, and control over
     * what gets loaded is lost one convenient property at a time.
     */
    actor?: SessionActor;
  }
}

export interface SessionCookieOptions {
  readonly name: string;
  readonly ttlDays: number;
  /**
   * `secure` is false only for local http development. Everywhere else the
   * cookie must not travel over plaintext.
   */
  readonly secure: boolean;
}

export interface SessionPluginDeps {
  readonly service: IdentityService;
  readonly cookie: SessionCookieOptions;
}

/**
 * The cookie policy — §6.1, transport row.
 *
 * | Attribute  | Value | Why |
 * |------------|-------|-----|
 * | `httpOnly` | true  | JavaScript cannot read it, so an XSS bug cannot steal the session |
 * | `secure`   | true  | never sent over plaintext |
 * | `sameSite` | lax   | CSRF defence; `lax` rather than `strict` so that following the verification link from an email arrives authenticated |
 * | `path`     | /     | the whole API |
 * | `maxAge`   | 30 d  | the ABSOLUTE session lifetime — see below |
 *
 * WHICH DEADLINE `maxAge` IS, now that there are two — D-219.
 *
 * The server keeps a SLIDING idle deadline (`sessions.expires_at`, 14 days,
 * pushed forward on use) inside an ABSOLUTE ceiling (`created_at + 30 days`,
 * which nothing moves). The cookie carries the ABSOLUTE one, and it must:
 * a cookie set to the idle deadline would be discarded by the browser two weeks
 * in, logging out an active user whose server-side session was alive and
 * renewing. The cookie has to outlive every renewal; it must not outlive the
 * ceiling. `maxAge = ttlDays` is exactly that, and the two therefore AGREE —
 * `expires_at` is clamped to the same ceiling, so it is never later than
 * `maxAge`.
 *
 * THE SERVER IS AUTHORITATIVE REGARDLESS. `maxAge` is a hint to the browser and
 * nothing more; a client that keeps a stale cookie gains nothing, because
 * `validateSession` checks both bounds against the database on every request.
 */
export function buildCookieOptions(options: SessionCookieOptions): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: options.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: options.ttlDays * 24 * 60 * 60,
  };
}

/**
 * Sets the session cookie.
 *
 * This is the ONLY place a raw session token is written to a response, and it
 * writes it to a header, never to a body. Putting the token in a body would
 * defeat `httpOnly` entirely (§6.4, step 7).
 */
export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  options: SessionCookieOptions,
): void {
  void reply.setCookie(options.name, token, buildCookieOptions(options));
}

/** Clears the session cookie on logout and on a rejected session. */
export function clearSessionCookie(reply: FastifyReply, options: SessionCookieOptions): void {
  void reply.clearCookie(options.name, { path: '/' });
}

/**
 * Session validation as a Fastify preHandler — §6.5.
 *
 * Registered per-route rather than globally, so that a route is authenticated
 * because someone wrote it down, not because it happened to sit under a prefix
 * where a hook was installed. A missing `preHandler` is visible in the route
 * definition; a route accidentally outside a global hook's scope is not.
 *
 * On rejection the cookie is CLEARED (§6.5, step 3), so a browser holding a
 * dead token stops sending it instead of retrying forever.
 */
export function createRequireSession(
  deps: SessionPluginDeps,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function requireSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = request.cookies[deps.cookie.name];
    try {
      request.actor = await deps.service.validateSession(token);
    } catch (error) {
      clearSessionCookie(reply, deps.cookie);
      throw error;
    }
  };
}

/**
 * Reads the actor a `requireSession` preHandler attached.
 *
 * Throws rather than returning undefined: reaching a handler without an actor
 * means the preHandler was omitted, which is a wiring bug that must fail
 * loudly rather than degrade into an unauthenticated read.
 */
export function requireActor(request: FastifyRequest): SessionActor {
  const actor = request.actor;
  if (actor === undefined) {
    throw new Error('requireActor: route is missing the requireSession preHandler');
  }
  return actor;
}
