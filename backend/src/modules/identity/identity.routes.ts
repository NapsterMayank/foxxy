import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  ActiveLinkCodeResponse,
  Link,
  LinkedChildrenResponse,
  LinkResponse,
  LinkCodeResponse,
  LoginResponse,
  OkResponse,
  SignupResponse,
  UserProfile,
} from '@/shared/contracts/identity.contract';
import { createIpHasher } from './domain/token';
import {
  clearSessionCookie,
  createRequireSession,
  requireActor,
  setSessionCookie,
  type SessionCookieOptions,
} from './identity.plugin';
import { identitySchemas, parseInput } from './identity.schema';
import { SIGNUP_MESSAGE, type IdentityService } from './identity.service';
import type { LinkRecord, RequestContext, UserRecord } from './identity.types';

/**
 * HTTP only — 01-BACKEND-IMPLEMENTATION-PLAN.md §2, layer table.
 *
 * Every handler does exactly three things: validate the input, call ONE
 * service method, and format the result. There is no `if` about a business
 * rule anywhere in this file and no database access. The old repository's
 * 3,318-line route file is what happens when that discipline slips
 * (00-ARCHITECTURE.md §5, "lessons the old repo paid for").
 */

const API_PREFIX = '/api/v1';

/** The longest user-agent worth storing. Beyond this it is not diagnostic. */
const USER_AGENT_MAX_LENGTH = 512;

/**
 * Builds the per-request context.
 *
 * The IP is HASHED here and the raw value never leaves this function: it is
 * personal data, and it ends up both in `sessions.ip_hash` and in a
 * rate-limit key. The hash is SALTED — the hasher arrives with the salt already
 * bound, so no request-path code holds the secret (D-221).
 */
function buildContextOf(
  hashIdentifier: (value: string) => string,
): (request: FastifyRequest) => RequestContext {
  return function contextOf(request: FastifyRequest): RequestContext {
    const rawUserAgent = request.headers['user-agent'];
    return {
      ipHash: hashIdentifier(request.ip),
      userAgent:
        typeof rawUserAgent === 'string' ? rawUserAgent.slice(0, USER_AGENT_MAX_LENGTH) : null,
    };
  };
}

/** Maps a user record to the wire shape. Never includes the password hash. */
function toUserProfile(user: UserRecord): UserProfile {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

function toLink(link: LinkRecord): Link {
  return {
    id: link.id,
    parentUserId: link.parentUserId,
    studentUserId: link.studentUserId,
    status: link.status,
    approvedAt: link.approvedAt?.toISOString() ?? null,
    revokedAt: link.revokedAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
  };
}

const OK: OkResponse = { status: 'ok' };

export interface IdentityRoutesDeps {
  readonly service: IdentityService;
  readonly cookie: SessionCookieOptions;
  /** Where a freshly verified account is sent. */
  readonly postVerifyRedirectUrl: string;
  /** The salt for `ip_hash` and every rate-limit key derived from it — D-221. */
  readonly ipHashSalt: string;
}

export async function registerIdentityRoutes(
  app: FastifyInstance,
  deps: IdentityRoutesDeps,
): Promise<void> {
  await app.register(fastifyCookie);

  const requireSession = createRequireSession({ service: deps.service, cookie: deps.cookie });
  const authenticated = { preHandler: requireSession };
  const contextOf = buildContextOf(createIpHasher(deps.ipHashSalt));

  // ---------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------

  /**
   * §6.2. Returns 201 with a CONSTANT body.
   *
   * A brand-new signup and a signup on an address that already has an account
   * produce byte-identical responses. The branch between them lives in the
   * service and is invisible from here — which is exactly why it cannot be
   * accidentally undone by a change to this handler.
   */
  app.post(`${API_PREFIX}/auth/signup`, async (request, reply) => {
    const input = parseInput(identitySchemas.signup, request.body);
    await deps.service.signup(input, contextOf(request));
    const body: SignupResponse = { status: 'ok', message: SIGNUP_MESSAGE };
    return reply.status(201).send(body);
  });

  /**
   * D-291 — THE RESEND. ALWAYS 200, with a body identical on every branch.
   *
   * The seventh `/auth/*` route became the eighth because D-217's justification
   * for a fire-and-forget verification email depended on a resend endpoint that
   * had never been written: with mail down, signup created an account, took the
   * address, and left no way to ask for the link again.
   *
   * Shaped exactly like `forgot-password` below, deliberately — same status,
   * same constant body, same "the branch lives in the service and is invisible
   * from here". An unknown address, an unverified one and an already-verified
   * one are indistinguishable to the caller.
   */
  app.post(`${API_PREFIX}/auth/resend-verification`, async (request, reply) => {
    const input = parseInput(identitySchemas.resendVerification, request.body);
    await deps.service.resendVerification(input, contextOf(request));
    return reply.status(200).send(OK);
  });

  /**
   * §6.3. On success: set the cookie and redirect to onboarding.
   *
   * A redirect carries no body, so there is no risk of the token appearing in
   * one. The token travels in the `set-cookie` header and nowhere else.
   */
  app.get(`${API_PREFIX}/auth/verify`, async (request, reply) => {
    const { token } = parseInput(identitySchemas.verify, request.query);
    const result = await deps.service.verifyEmail(token, contextOf(request));
    setSessionCookie(reply, result.session.token, deps.cookie);
    return reply.redirect(deps.postVerifyRedirectUrl, 302);
  });

  /** §6.4. The token goes to the cookie; the body carries the profile only. */
  app.post(`${API_PREFIX}/auth/login`, async (request, reply) => {
    const input = parseInput(identitySchemas.login, request.body);
    const result = await deps.service.login(input, contextOf(request));
    setSessionCookie(reply, result.session.token, deps.cookie);
    const body: LoginResponse = { user: toUserProfile(result.user) };
    return reply.status(200).send(body);
  });

  /**
   * §6.6. Deliberately NOT behind `requireSession`: logging out with an
   * already-dead session must succeed, not 401.
   *
   * Which is precisely why it is RATE LIMITED BY IP inside the service (D-220):
   * unauthenticated and reaching the `auth` pool is the combination the bulkhead
   * exists to prevent. The context is passed for that key and no other reason.
   */
  app.post(`${API_PREFIX}/auth/logout`, async (request, reply) => {
    await deps.service.logout(request.cookies[deps.cookie.name], contextOf(request));
    clearSessionCookie(reply, deps.cookie);
    return reply.status(200).send(OK);
  });

  /** §6.6. "Sign out everywhere" — requires a live session to name the user. */
  app.post(`${API_PREFIX}/auth/logout-all`, authenticated, async (request, reply) => {
    await deps.service.logoutAll(requireActor(request));
    clearSessionCookie(reply, deps.cookie);
    return reply.status(200).send(OK);
  });

  /** §6.7. ALWAYS 200, whether or not the account exists. */
  app.post(`${API_PREFIX}/auth/forgot-password`, async (request, reply) => {
    const input = parseInput(identitySchemas.forgotPassword, request.body);
    await deps.service.requestPasswordReset(input, contextOf(request));
    return reply.status(200).send(OK);
  });

  /**
   * §6.7. Every session for the user is deleted inside the same transaction,
   * so the caller is logged out too — hence clearing the cookie here.
   */
  app.post(`${API_PREFIX}/auth/reset-password`, async (request, reply) => {
    const input = parseInput(identitySchemas.resetPassword, request.body);
    await deps.service.resetPassword(input, contextOf(request));
    clearSessionCookie(reply, deps.cookie);
    return reply.status(200).send(OK);
  });

  // ---------------------------------------------------------------------
  // Parent-child linking — §6.8
  // ---------------------------------------------------------------------

  /** Step 1: the student asks for a code. One active code per student. */
  app.post(`${API_PREFIX}/links/code`, authenticated, async (request, reply) => {
    const issued = await deps.service.generateLinkCode(requireActor(request));
    const body: LinkCodeResponse = {
      code: issued.code,
      expiresAt: issued.expiresAt.toISOString(),
    };
    return reply.status(201).send(body);
  });

  /**
   * The same code again, rather than a new one.
   *
   * Issuing is a replacement (§6.8, "one active code per student"), so a screen
   * that called POST on every render would invalidate the code the parent is
   * mid-way through typing. This is the read that makes that unnecessary.
   */
  app.get(`${API_PREFIX}/links/code`, authenticated, async (request, reply) => {
    const active = await deps.service.getActiveLinkCode(requireActor(request));
    const body: ActiveLinkCodeResponse = {
      code: active?.code ?? null,
      expiresAt: active?.expiresAt.toISOString() ?? null,
    };
    return reply.status(200).send(body);
  });

  /** Step 3: the parent submits it. Creates a `pending` link and nothing more. */
  app.post(`${API_PREFIX}/links/submit`, authenticated, async (request, reply) => {
    const input = parseInput(identitySchemas.submitLink, request.body);
    const link = await deps.service.submitLinkCode(requireActor(request), input.code);
    const body: LinkResponse = { link: toLink(link) };
    return reply.status(201).send(body);
  });

  /** Step 5: the STUDENT approves. This is where consent actually happens. */
  app.post(`${API_PREFIX}/links/:id/approve`, authenticated, async (request, reply) => {
    const { id } = parseInput(identitySchemas.linkIdParam, request.params);
    const link = await deps.service.approveLink(requireActor(request), id);
    const body: LinkResponse = { link: toLink(link) };
    return reply.status(200).send(body);
  });

  /** Step 7: either party revokes, and it takes effect on the next request. */
  app.post(`${API_PREFIX}/links/:id/revoke`, authenticated, async (request, reply) => {
    const { id } = parseInput(identitySchemas.linkIdParam, request.params);
    const link = await deps.service.revokeLink(requireActor(request), id);
    const body: LinkResponse = { link: toLink(link) };
    return reply.status(200).send(body);
  });

  /** Approved children only. A pending or revoked link never appears here. */
  app.get(`${API_PREFIX}/links/children`, authenticated, async (request, reply) => {
    const children = await deps.service.getLinkedChildren(requireActor(request));
    const body: LinkedChildrenResponse = {
      children: children.map((child) => ({
        linkId: child.linkId,
        studentUserId: child.studentUserId,
        approvedAt: child.approvedAt?.toISOString() ?? null,
      })),
    };
    return reply.status(200).send(body);
  });
}
