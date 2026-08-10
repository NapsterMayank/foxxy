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
 * | `maxAge`   | 30 d  | matches the absolute session lifetime in the database |
 *
 * `maxAge` on the cookie is a convenience for the browser and NOTHING MORE.
 * The authority on whether a session is alive is `sessions.expires_at` in the
 * database, checked on every request. A client that keeps a stale cookie gains
 * nothing.
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
