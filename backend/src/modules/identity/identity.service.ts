import {
  AUDIT_ACTIONS,
  AUDIT_RESOURCES,
  createNoopAudit,
  type AuditPort,
} from '@/platform/audit/index';
import { createAccessGuard, type Actor } from '@/platform/authz/index';
import type { CachePort } from '@/platform/cache/index';
import type { Clock } from '@/platform/clock/index';
import {
  AppError,
  DependencyError,
  ERROR_CODES,
  ForbiddenError,
  UnauthenticatedError,
  ValidationError,
  type ErrorCode,
  isAppError,
} from '@/platform/errors/index';
import type { Logger } from '@/platform/logger/index';
import type { MailMessage, MailPort } from '@/platform/mail/index';
import {
  FORGOT_PASSWORD_RATE_LIMIT,
  LINK_CODE_RATE_LIMIT,
  LINK_SUBMIT_RATE_LIMIT,
  LOGIN_RATE_LIMIT,
  LOGOUT_RATE_LIMIT,
  SIGNUP_RATE_LIMIT,
  TOKEN_ENDPOINT_RATE_LIMIT,
} from '@/shared/constants/rate-limits';
import type {
  ForgotPasswordRequest,
  LoginRequest,
  ResetPasswordRequest,
  SignupRequest,
} from '@/shared/contracts/identity.contract';
import {
  LINK_CODE_TTL_MS,
  generateLinkCode as buildLinkCode,
  isValidLinkCode,
  normaliseLinkCode,
  type RandomInt,
} from './domain/link-code';
import { checkPasswordStrength, normaliseEmail } from './domain/password';
import {
  EMAIL_VERIFICATION_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  SESSION_IDLE_TTL_MS,
  createIpHasher,
  expiryFrom,
  generateToken,
  hashToken,
  isExpired,
  isPastAbsoluteLifetime,
  sessionDeadline,
  shouldRenewSession,
  type RandomBytes,
} from './domain/token';
import {
  createRateLimiter,
  rateLimitKeys,
  type MetricsSink,
  type RateLimiter,
} from './identity.rate-limit';
import type { IdentityRepository } from './identity.repository';
import type {
  AuthenticatedResult,
  LinkRecord,
  LinkedChildRecord,
  PasswordHasher,
  RequestContext,
  SessionActor,
  UserRecord,
} from './identity.types';

/**
 * The identity use-cases — 01-BACKEND-IMPLEMENTATION-PLAN.md §6.
 *
 * This layer ORCHESTRATES. It loads data, calls domain functions, persists,
 * and sends mail. It performs no calculation of its own: every rule with a
 * decision in it — password strength, expiry, code alphabet, renewal — lives
 * in `domain/` and is unit-tested without a database.
 *
 * The clock is injected. There is no `new Date()` anywhere in this file, and
 * there must never be one: every deadline in the module is testable only
 * because time arrives as a dependency.
 */

/**
 * 403 with a machine-readable reason (§6.4, step 5).
 *
 * The frontend needs to distinguish "wrong password" from "correct password,
 * unverified address" so it can offer to resend the email. `AppError.code` is
 * closed over the eight platform codes on purpose, so the extra detail rides
 * as a narrower `reason` field on the payload instead of widening that enum.
 *
 * This leaks nothing an attacker does not already have: reaching it requires
 * the correct password for the account.
 */
export class EmailNotVerifiedError extends AppError {
  readonly code: ErrorCode = ERROR_CODES.FORBIDDEN;
  readonly httpStatus = 403;
  readonly safeMessage = 'Verify your email address before signing in.';

  constructor() {
    super('Login rejected: email not verified');
  }

  override toClientPayload(): {
    error: { code: ErrorCode; message: string; reason: 'EMAIL_NOT_VERIFIED' };
  } {
    return {
      error: { code: this.code, message: this.safeMessage, reason: 'EMAIL_NOT_VERIFIED' },
    };
  }
}

/**
 * The single failure message for login (§6.4).
 *
 * ONE message, for every cause: no such account, wrong password, malformed
 * stored hash. "No such user" and "wrong password" are the same leak that the
 * identical signup response closes, delivered on a different endpoint.
 */
const LOGIN_FAILURE_MESSAGE = 'Invalid email or password.';

/**
 * The single failure message for any token redemption.
 *
 * Unknown, already consumed and expired are indistinguishable, so a stolen or
 * guessed token yields no information about which of the three it was.
 */
const TOKEN_FAILURE_MESSAGE = 'This link is invalid or has expired.';

/** The constant signup response body. Identical for new and existing. */
export const SIGNUP_MESSAGE = 'Check your email to finish setting up your account.';

/**
 * Emitted when a mail send failed with `DependencyError` and was dropped rather
 * than failing the request. ALERT ON IT: it means outbound email is degraded and
 * users are completing signups whose verification link never arrived.
 */
export const MAIL_DEFERRED_METRIC = 'identity.mail.deferred';

/**
 * Emitted when a mail send failed with something that is NOT a
 * `DependencyError` — i.e. a programming error, not an outage.
 *
 * A SEPARATE metric from the one above, and that separation is the whole point.
 * "The mail provider is down" and "we constructed a message the mailer cannot
 * accept" are different pages in a runbook, and folding the second into the
 * first is how a permanent bug hides inside a transient-failure dashboard.
 */
export const MAIL_FAILED_METRIC = 'identity.mail.unexpected_failure';

export interface IdentityServiceDeps {
  readonly repository: IdentityRepository;
  /**
   * Rate-limit counters ONLY (§6.9).
   *
   * Link codes used to live here too. They do not any more — see
   * `generateLinkCode` and D-012. Nothing in this module may store anything in
   * the cache whose loss changes what a user is allowed to do.
   */
  readonly cache: CachePort;
  readonly hasher: PasswordHasher;
  readonly mail: MailPort;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly randomBytes: RandomBytes;
  readonly randomInt: RandomInt;
  /**
   * Where the rate-limit fallback metric goes. Optional only because no
   * metrics port exists yet — see `identity.rate-limit.ts` and D-034.
   */
  readonly metrics?: MetricsSink;
  /**
   * THE APPEND-ONLY RECORD OF PRIVILEGED ACTIONS — 05-ROADMAP.md §8.
   *
   * Four actions in this module qualify and all four are wired: password reset,
   * logout-all, link approval and link revocation. What they have in common is
   * that each CHANGES SECURITY STATE and each is something a parent, a school
   * or a regulator could reasonably ask about afterwards.
   *
   * Ordinary activity deliberately does not appear. A successful login is not
   * an audit event: it happens hundreds of times a day per user and would bury
   * these four under a million rows, and an audit log that is expensive to read
   * is an audit log nobody reads.
   *
   * Optional, defaulting to the no-op, so that the existing harnesses keep
   * working unchanged — the same pattern as `metrics` above. `app/routes.ts`
   * always supplies the real one, and a test asserts that it does.
   */
  readonly audit?: AuditPort;
  /**
   * THE TENANT THIS DEPLOYMENT SERVES - D-073.
   *
   * Signup is the only insert path in the product with no authenticated actor
   * to inherit a tenant from, so this is where the value has to come from. It
   * comes from CONFIGURATION and never from the request: a `tenantId` in a
   * signup body would let anyone choose which school's data namespace to join,
   * which is the whole boundary handed away through the front door. The signup
   * contract does not declare the field, Zod strips unknown keys, and a test
   * drives a body carrying one and asserts the row still lands in this tenant.
   *
   * When multi-tenancy arrives this becomes a per-request resolution (subdomain
   * -> tenant), and it becomes that HERE, in one place, rather than in every
   * insert path.
   */
  readonly defaultTenantId: string;
  /**
   * THE ABSOLUTE session lifetime, from config — the ceiling, not the window.
   *
   * `created_at + sessionTtlDays` is the instant a session dies no matter how
   * often it is used. The SLIDING window inside it is `SESSION_IDLE_TTL_MS`.
   * See D-219 and the two bounds documented on `domain/token.ts`.
   */
  readonly sessionTtlDays: number;
  /**
   * THE SALT FOR EVERY IDENTIFIER HASH IN THIS MODULE — D-221.
   *
   * Required, not optional. Threaded from the composition edge rather than
   * defaulted anywhere, because a default salt is the same as no salt: it would
   * be in the source, and the digest it produces would be the one an attacker
   * precomputed. See `hashIp`.
   */
  readonly ipHashSalt: string;
  /** Where the links in outbound email point. */
  readonly urls: {
    /** Backend origin — the verify endpoint lives here. */
    readonly apiBaseUrl: string;
    /** Frontend origin — where a verified user lands. */
    readonly appBaseUrl: string;
  };
}

export interface IdentityService {
  signup(input: SignupRequest, context: RequestContext): Promise<void>;
  verifyEmail(token: string, context: RequestContext): Promise<AuthenticatedResult>;
  login(input: LoginRequest, context: RequestContext): Promise<AuthenticatedResult>;
  /**
   * Rate limited by IP, and the context is REQUIRED for that reason (D-220).
   * An optional context would make the limit optional at every call site.
   */
  logout(token: string | undefined, context: RequestContext): Promise<void>;
  logoutAll(actor: SessionActor): Promise<number>;
  validateSession(token: string | undefined): Promise<SessionActor>;
  requestPasswordReset(input: ForgotPasswordRequest, context: RequestContext): Promise<void>;
  resetPassword(input: ResetPasswordRequest, context: RequestContext): Promise<void>;
  generateLinkCode(actor: SessionActor): Promise<{ code: string; expiresAt: Date }>;
  getActiveLinkCode(actor: SessionActor): Promise<{ code: string; expiresAt: Date } | null>;
  submitLinkCode(actor: SessionActor, rawCode: string): Promise<LinkRecord>;
  approveLink(actor: SessionActor, linkId: string): Promise<LinkRecord>;
  revokeLink(actor: SessionActor, linkId: string): Promise<LinkRecord>;
  getLinkedChildren(actor: SessionActor): Promise<LinkedChildRecord[]>;
  isLinkApproved(parentUserId: string, studentUserId: string): Promise<boolean>;
  /**
   * The tenant a user's account belongs to, or null when there is no such user.
   *
   * The cross-module entry point for the RESOURCE side of the tenant comparison
   * (D-073). `learner` and every module after it calls this rather than reading
   * `users` itself, for the same reason it calls `isLinkApproved` rather than
   * reading `parent_child_links`.
   *
   * Returns null rather than throwing for a missing user: the caller feeds it to
   * `assertCanAccess`, which turns "no tenant" into a deny, so that "no such
   * account" and "an account in another tenant" are indistinguishable.
   */
  getTenantOfUser(userId: string): Promise<string | null>;
  /**
   * Everything `notify` needs to reach one person: their tenant and their
   * email address, or null when there is no such account.
   *
   * The cross-module entry point for notification RECIPIENTS, and it exists for
   * the same reason `getTenantOfUser` does — `users` is this module's table,
   * and a second module querying it directly would put identity's schema behind
   * somebody else's queries.
   *
   * THE ADDRESS IS ONLY RETURNED ONCE THE EMAIL IS VERIFIED. An unverified
   * address is an address somebody TYPED, not one they proved they control, and
   * mailing product notifications to it turns a typo in signup into unsolicited
   * mail to a stranger. `null` there is not an error: the email channel reports
   * a missing address as an ordinary failed RESULT and the in-app notification
   * lands regardless.
   */
  getNotificationRecipient(userId: string): Promise<NotificationRecipient | null>;
  assertParentCanReadChild(actor: SessionActor, studentUserId: string): Promise<void>;
}

/** What `notify` is handed for one recipient. Never the whole user row. */
export interface NotificationRecipient {
  readonly userId: string;
  readonly tenantId: string;
  /** Null when unverified or absent — see `getNotificationRecipient`. */
  readonly email: string | null;
}

export function createIdentityService(deps: IdentityServiceDeps): IdentityService {
  const { repository, cache, hasher, mail, clock, logger, urls } = deps;
  const limiter: RateLimiter = createRateLimiter({
    cache,
    clock,
    logger,
    ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
  });
  /** The ABSOLUTE ceiling. The sliding window is `SESSION_IDLE_TTL_MS`. */
  const absoluteSessionTtlMs = deps.sessionTtlDays * 24 * 60 * 60 * 1000;
  const audit: AuditPort = deps.audit ?? createNoopAudit();
  const metrics: MetricsSink = deps.metrics ?? { increment: (): void => undefined };
  /** Every identifier hash in this module. Salted once, here — D-221. */
  const hashIdentifier = createIpHasher(deps.ipHashSalt);

  /**
   * ============================================================================
   * MAIL LEAVES THE REQUEST PATH — D-217 and D-218, two defects, one shape.
   *
   * `mail.send` used to be awaited bare at three call sites, with the user row
   * already committed. Two things followed from that, and both were live:
   *
   *  1. A PROVIDER BLIP MADE SIGNUP RETURN 500 *AFTER* CREATING THE ACCOUNT.
   *     The address was then taken, so the user could neither sign in nor sign
   *     up again — the single worst outcome in the funnel. `guarded-mail.ts` and
   *     `container.ts` both state the contract in as many words ("a mail outage
   *     must degrade to 'verification queued', never 'signup fails'") and BOTH
   *     described a catch that was never written. The comments were the whole
   *     implementation.
   *
   *  2. IT WAS A LATENCY ORACLE. `requestPasswordReset` returned immediately for
   *     an unknown address and did an SMTP round trip for a known one. The two
   *     response BODIES are byte-identical — a test asserts it — and the TIMING
   *     was not, which defeats the enumeration defence the endpoint exists to
   *     provide. Signup had the same asymmetry.
   *
   * Deferring closes both at once, and closes the second one properly: the send
   * no longer contributes to the response time of EITHER branch, so there is
   * nothing left to equalise.
   *
   * WHAT "DEFERRED" MEANS HERE, precisely, because it is weaker than a queue and
   * should not be mistaken for one: the send is started and not awaited, and the
   * process may exit before it completes. That is acceptable because the
   * RECOVERY PATH ALREADY EXISTS AND DOES NOT DEPEND ON IT — the verification and
   * reset tokens are committed rows, so a resend re-mails the token that is
   * already persisted. Losing a send costs one email, never an account.
   * `platform/jobs` is the right home the day a resend endpoint is not enough;
   * that is a cross-module change and is reported rather than smuggled in here.
   *
   * A NON-`DependencyError` IS NOT SWALLOWED. `DependencyError` means the
   * provider failed — expected, transient, `warn`. Anything else is a
   * programming error in OUR message, and it is logged at `error` under its own
   * metric so it surfaces as a bug rather than as weather. It cannot surface as
   * a 500 any more, because nothing is waiting for it; that is the price of
   * taking mail off the request path and it is paid deliberately.
   */
  function deferMail(message: MailMessage, event: string): void {
    void mail.send(message).then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof DependencyError) {
          logger.warn(
            // NEVER the recipient and never `message.data` — the data carries
            // the verification token, which is a live credential.
            { event, template: message.template, dependency: error.dependency },
            'mail send failed; the request completed and the token is persisted for a resend',
          );
          metrics.increment(MAIL_DEFERRED_METRIC, { template: message.template });
          return;
        }
        logger.error(
          {
            event,
            template: message.template,
            err: error instanceof Error ? error.message : 'non-error thrown by the mail port',
          },
          'mail send failed for a reason that is not a dependency outage',
        );
        metrics.increment(MAIL_FAILED_METRIC, { template: message.template });
      },
    );
  }

  /**
   * Builds the access guard for ONE decision, with the link status read now.
   *
   * §7 rule 3: link status is read at query time and never cached in the
   * session, so a revocation takes effect on the next request rather than at
   * the next login. `createAccessGuard` takes a SYNCHRONOUS reader, so the
   * status is fetched here and handed to it — the read still happens per
   * decision, which is what the rule actually requires.
   */
  async function guardFor(
    actor: Actor,
    studentUserId: string,
  ): Promise<ReturnType<typeof createAccessGuard>> {
    const status =
      actor.role === 'parent' ? await repository.findLinkStatus(actor.userId, studentUserId) : null;
    return createAccessGuard({ readLinkStatus: () => status });
  }

  /**
   * THE RESOURCE SIDE of the tenant comparison - D-073.
   *
   * It is read from the DATA, never copied from the actor. Handing
   * `actor.tenantId` to `assertCanAccess` as the resource tenant would compare a
   * value with itself: a check that can never fail, written in the shape of one
   * that sometimes does. That is the exact failure mode D-073 was raised about,
   * and it would be invisible at every call site.
   *
   * The caller's OWN tenant is short-circuited rather than queried. It is the
   * same value by definition (the session carries it), and issuing a query for
   * it would put a database round trip on the hot path of every authenticated
   * request in the product.
   */
  async function tenantOfStudent(actor: Actor, studentUserId: string): Promise<string | null> {
    if (studentUserId === actor.userId) return actor.tenantId;
    return repository.findUserTenant(studentUserId);
  }

  /** Issues a session and returns the raw token exactly once. */
  async function issueSession(
    user: UserRecord,
    context: RequestContext,
  ): Promise<AuthenticatedResult> {
    const now = clock.now();
    // §6.10, session fixation: a FRESH token on every login. Nothing is reused.
    const { token, hash } = generateToken(deps.randomBytes);
    // `now` is also the row's `created_at` (the insert below carries no explicit
    // one, and the column defaults to the transaction clock), so at issue time
    // the sliding window is the binding bound and the ceiling is 30 days out.
    const expiresAt = sessionDeadline(now, now, SESSION_IDLE_TTL_MS, absoluteSessionTtlMs);

    await repository.createSession({
      userId: user.id,
      tokenHash: hash,
      expiresAt,
      lastUsedAt: now,
      createdAt: now,
      ipHash: context.ipHash,
      userAgent: context.userAgent,
    });

    return { user, session: { token, expiresAt } };
  }

  return {
    /**
     * §6.2 — signup.
     *
     * THE ENUMERATION DEFENCE, which is the whole shape of this method: an
     * address that already has an account produces the IDENTICAL 201 and the
     * identical body as a brand-new signup. The existing account is emailed
     * "someone tried to sign up with your address" instead. Same user
     * experience, leak closed.
     *
     * There is deliberately NO pre-existence check. The UNIQUE constraint is
     * the real protection against two simultaneous signups (§6.2, step 5), and
     * a pre-check would additionally create a code path whose timing differs
     * between the two cases.
     */
    async signup(input: SignupRequest, context: RequestContext): Promise<void> {
      await limiter.consume(rateLimitKeys.signupByIp(context.ipHash), SIGNUP_RATE_LIMIT);

      const email = normaliseEmail(input.email);

      const strength = checkPasswordStrength(input.password);
      if (!strength.ok) {
        throw new ValidationError(strength.message, {
          message: `Signup rejected: password ${strength.reason}`,
        });
      }

      // Hashing happens on BOTH paths and before the branch, so the existing
      // and new cases do the same expensive work in the same order.
      const passwordHash = await hasher.hash(input.password);

      let user: UserRecord;
      try {
        user = await repository.createUser({
          email,
          passwordHash,
          role: input.role,
          // From configuration, NEVER from `input`. See `defaultTenantId`.
          tenantId: deps.defaultTenantId,
        });
      } catch (error) {
        if (isAppError(error) && error.code === ERROR_CODES.CONFLICT) {
          // The address is taken. Tell its owner, tell the caller nothing.
          //
          // DEFERRED, exactly like the branch below. If this one waited for the
          // mailer and the other did not, the identical-body defence would be
          // undone by the clock — see `deferMail`.
          deferMail(
            {
              to: email,
              template: 'signup-attempt-on-existing-account',
              data: { appUrl: urls.appBaseUrl },
            },
            'signup.existing_address_mail_failed',
          );
          logger.info(
            { event: 'signup.existing_address' },
            'signup attempted on an existing address',
          );
          return;
        }
        throw error;
      }

      const now = clock.now();
      const { token, hash } = generateToken(deps.randomBytes);
      await repository.createEmailVerificationToken({
        userId: user.id,
        tokenHash: hash,
        expiresAt: expiryFrom(now, EMAIL_VERIFICATION_TTL_MS),
      });

      // The token row is COMMITTED above, so a send that never happens is
      // recoverable by a resend. That ordering is what makes deferring safe.
      deferMail(
        {
          to: email,
          template: 'email-verification',
          data: {
            verifyUrl: `${urls.apiBaseUrl}/api/v1/auth/verify?token=${encodeURIComponent(token)}`,
          },
        },
        'signup.verification_mail_failed',
      );

      logger.info({ event: 'signup.created', role: input.role }, 'account created');
    },

    /**
     * §6.3 — email verification.
     *
     * The token is single use and is consumed in the SAME TRANSACTION that
     * sets `email_verified_at` (see the repository). Doing it in two
     * statements leaves a window in which a replayed link verifies twice, and
     * on a slow day that window is wide enough to matter.
     */
    async verifyEmail(token: string, context: RequestContext): Promise<AuthenticatedResult> {
      await limiter.consume(
        rateLimitKeys.tokenEndpointByIp(context.ipHash),
        TOKEN_ENDPOINT_RATE_LIMIT,
      );

      const userId = await repository.consumeEmailVerificationToken(hashToken(token), clock.now());
      if (userId === null) {
        throw new ValidationError(TOKEN_FAILURE_MESSAGE, {
          message: 'Verification token unknown, consumed, or expired',
        });
      }

      const user = await repository.findUserById(userId);
      if (user === null) {
        throw new ValidationError(TOKEN_FAILURE_MESSAGE, {
          message: 'Verification token resolved to a user that no longer exists',
        });
      }

      logger.info({ event: 'verify.succeeded' }, 'email verified');
      return issueSession(user, context);
    },

    /**
     * §6.4 — login.
     *
     * Step order is load-bearing and is the reason this reads the way it does:
     *
     *  1. RATE LIMIT BEFORE ANY DATABASE WORK. Both counters — IP and email.
     *     An attacker rotating IPs against one account must be stopped by the
     *     email counter; an attacker spraying many accounts from one host must
     *     be stopped by the IP counter. Either alone leaves a hole.
     *  2. Look up the user.
     *  3. IF NO USER EXISTS, STILL RUN A DUMMY ARGON2 VERIFICATION. Argon2id
     *     at these parameters takes tens of milliseconds; skipping it would
     *     make "no such account" measurably faster than "wrong password" from
     *     anywhere on the internet.
     *  4. Verify.
     *  5. Unverified email -> 403 EMAIL_NOT_VERIFIED.
     *  6. Fresh token, cookie set by the route.
     *
     * The route never puts the token in the body — that would defeat httpOnly
     * entirely (§6.4, step 7).
     */
    async login(input: LoginRequest, context: RequestContext): Promise<AuthenticatedResult> {
      const email = normaliseEmail(input.email);
      const emailKey = hashIdentifier(email);

      await limiter.consume(rateLimitKeys.loginByIp(context.ipHash), LOGIN_RATE_LIMIT);
      await limiter.consume(rateLimitKeys.loginByEmail(emailKey), LOGIN_RATE_LIMIT);

      const user = await repository.findUserByEmail(email);

      if (user === null) {
        // The timing defence. The result is discarded — it is always false —
        // but the WORK is what matters, and it must not be optimised away.
        await hasher.verify(await hasher.dummyHash(), input.password);
        throw new UnauthenticatedError(LOGIN_FAILURE_MESSAGE, {
          message: 'Login failed: no account for that address',
        });
      }

      const passwordMatches = await hasher.verify(user.passwordHash, input.password);
      if (!passwordMatches) {
        throw new UnauthenticatedError(LOGIN_FAILURE_MESSAGE, {
          message: 'Login failed: password mismatch',
        });
      }

      if (user.emailVerifiedAt === null) {
        throw new EmailNotVerifiedError();
      }

      // Only a SUCCESSFUL login clears the counters. Clearing them on any
      // completed attempt would let an attacker reset their own budget.
      await limiter.reset(rateLimitKeys.loginByIp(context.ipHash));
      await limiter.reset(rateLimitKeys.loginByEmail(emailKey));

      logger.info({ event: 'login.succeeded', role: user.role }, 'login succeeded');
      return issueSession(user, context);
    },

    /**
     * §6.6 — logout deletes the session row. The route clears the cookie.
     *
     * Deliberately silent when the token is absent or unknown: logout is
     * idempotent, and reporting "that session did not exist" would turn the
     * endpoint into a token oracle.
     *
     * RATE LIMITED BY IP, AND THE ORDER OF THE NEXT FOUR LINES IS THE FIX —
     * D-220. This is the only endpoint that is both unauthenticated (by design:
     * logging out of a dead session must succeed, not 401) and able to reach the
     * database, and the database it reaches is the `auth` POOL — the one pool
     * §3.1's bulkhead exists to keep free so that login always has a connection.
     * Unthrottled, a loop from one host with no credentials starved the pool
     * that authentication depends on.
     *
     * The limiter runs FIRST and the empty-token return runs SECOND, so a flood
     * is counted whether or not it carries a cookie. The empty-token return is
     * before any repository call, so a cookie-less request touches the cache and
     * NOTHING ELSE — it consumes no `auth` connection at all. A test asserts
     * exactly that, against a repository that fails on any call.
     */
    async logout(token: string | undefined, context: RequestContext): Promise<void> {
      await limiter.consume(rateLimitKeys.logoutByIp(context.ipHash), LOGOUT_RATE_LIMIT);
      if (token === undefined || token.length === 0) return;
      await repository.deleteSessionByTokenHash(hashToken(token));
    },

    /** §6.6 — "sign out everywhere". Required after a password change. */
    async logoutAll(actor: SessionActor): Promise<number> {
      const removed = await repository.deleteAllSessionsForUser(actor.userId);
      logger.info({ event: 'logout_all', sessions: removed }, 'all sessions revoked');

      // AFTER the action succeeds, and outside its transaction. A crash in
      // between loses the row; an audit failure never loses the logout. See the
      // `platform/audit` header for why that trade goes this way.
      //
      // `sessions` is a COUNT. It is the one fact worth having later — "I was
      // signed out of six devices I did not recognise" is the shape of the
      // support conversation this row exists to answer — and a count identifies
      // nobody.
      await audit.record({
        actor: { userId: actor.userId, role: actor.role },
        action: AUDIT_ACTIONS.LOGOUT_ALL,
        resourceType: AUDIT_RESOURCES.SESSION,
        resourceId: actor.userId,
        metadata: { sessions: removed },
      });

      return removed;
    },

    /**
     * §6.5 — session validation.
     *
     * Returns `{ userId, role }` and NOTHING ELSE. Never the whole user row:
     * routes start reading fields off it, and control over what gets loaded is
     * lost one convenient property at a time.
     *
     * Sliding renewal INSIDE an absolute ceiling (D-219): when the session has
     * not been touched for 24 hours its idle deadline is pushed out, so an
     * active user is never logged out — but the push is clamped to
     * `created_at + 30 days`, and that ceiling is checked independently on every
     * request. A credential that is used constantly still dies on schedule.
     */
    async validateSession(token: string | undefined): Promise<SessionActor> {
      if (token === undefined || token.length === 0) {
        throw new UnauthenticatedError('Authentication required.', {
          message: 'No session cookie present',
        });
      }

      const found = await repository.findSessionByTokenHash(hashToken(token));
      if (found === null) {
        throw new UnauthenticatedError('Authentication required.', {
          message: 'Session token not recognised',
        });
      }

      const now = clock.now();

      /**
       * TWO BOUNDS, AND THE SECOND ONE IS THE FIX — D-219.
       *
       *   the SLIDING bound   `expires_at`, which renewal below pushes forward.
       *   the ABSOLUTE bound  `created_at + 30 days`, which nothing moves.
       *
       * Only the sliding bound existed. Renewal replaced `expires_at` with
       * `now + 30 days` and no code path ever read `created_at`, so a stolen
       * token used once per 24-hour renewal interval was a PERMANENT credential
       * — while the comment three lines above claimed "an abandoned session
       * still dies on the 30-day ceiling". The ceiling was never checked.
       *
       * The absolute check is first and is evaluated independently of
       * `expires_at`, because every session issued before this fix carries an
       * unclamped `expires_at` that may sit past its own ceiling. Clamping the
       * write alone would leave those rows immortal.
       */
      const pastCeiling = isPastAbsoluteLifetime(found.session.createdAt, now, absoluteSessionTtlMs);
      if (pastCeiling || isExpired(found.session.expiresAt, now)) {
        // Reap it rather than leave a dead row that will be looked up again.
        await repository.deleteSessionByTokenHash(hashToken(token));
        throw new UnauthenticatedError('Authentication required.', {
          // Log-side only. Which bound fired is a real operational difference —
          // "signed out after two weeks idle" and "signed out at 30 days" are
          // different support conversations — and neither reaches the client.
          message: pastCeiling
            ? 'Session past its absolute lifetime'
            : 'Session expired (idle window)',
        });
      }

      if (shouldRenewSession(found.session.lastUsedAt, now)) {
        // CLAMPED to the ceiling. Renewal may extend the idle window; it may
        // never extend the lifetime.
        await repository.renewSession(
          found.session.id,
          now,
          sessionDeadline(found.session.createdAt, now, SESSION_IDLE_TTL_MS, absoluteSessionTtlMs),
        );
      }

      return { userId: found.userId, role: found.role, tenantId: found.tenantId };
    },

    /**
     * §6.7 — forgot password. ALWAYS returns without error, whether or not the
     * account exists. Same enumeration reasoning as signup.
     *
     * The rate limit is keyed by IP and by email so that this cannot be turned
     * into a mail bomb aimed at one address.
     *
     * IT WAS A LATENCY ORACLE — D-218. The bodies were byte-identical (a test
     * asserts it) and the TIMING was not: an unknown address returned after one
     * indexed SELECT, a known one after a token insert AND a synchronous SMTP
     * round trip. Hundreds of milliseconds, measurable from anywhere, on the
     * exact question the identical body exists to hide.
     *
     * Two changes close it, in order of how much they matter:
     *
     *  1. THE SEND IS OFF THE REQUEST PATH (`deferMail`). It was the dominant
     *     term by two orders of magnitude, and equalising it was never possible
     *     — there is no address to mail on the unknown branch.
     *  2. THE TOKEN IS GENERATED ON BOTH BRANCHES, before the branch, in the
     *     same spirit as login's dummy Argon2 verification. It costs one
     *     `randomBytes` call and one SHA-256 either way.
     *
     * What remains is ONE indexed INSERT on the known branch — sub-millisecond,
     * and far below the jitter of any network an attacker would measure across.
     * A median-ratio test pins the property the same way login's does.
     */
    async requestPasswordReset(
      input: ForgotPasswordRequest,
      context: RequestContext,
    ): Promise<void> {
      const email = normaliseEmail(input.email);
      const emailKey = hashIdentifier(email);

      await limiter.consume(rateLimitKeys.forgotByIp(context.ipHash), FORGOT_PASSWORD_RATE_LIMIT);
      await limiter.consume(rateLimitKeys.forgotByEmail(emailKey), FORGOT_PASSWORD_RATE_LIMIT);

      const now = clock.now();
      // BEFORE the lookup's branch, on both paths. See point 2 above.
      const { token, hash } = generateToken(deps.randomBytes);

      const user = await repository.findUserByEmail(email);
      if (user === null) {
        logger.info({ event: 'forgot_password.unknown_address' }, 'reset requested for no account');
        return;
      }

      await repository.createPasswordResetToken({
        userId: user.id,
        tokenHash: hash,
        expiresAt: expiryFrom(now, PASSWORD_RESET_TTL_MS),
      });

      deferMail(
        {
          to: email,
          template: 'password-reset',
          data: { resetUrl: `${urls.appBaseUrl}/reset-password?token=${encodeURIComponent(token)}` },
        },
        'forgot_password.mail_failed',
      );

      logger.info({ event: 'forgot_password.sent' }, 'reset email queued');
    },

    /**
     * §6.7 — reset. Verify, hash, update, DELETE EVERY SESSION, consume the
     * token. All in one transaction (see the repository).
     *
     * The session deletion is the point of the exercise. If the reset was
     * triggered by a compromise, leaving the attacker's session alive means
     * the password change achieved nothing.
     */
    async resetPassword(input: ResetPasswordRequest, context: RequestContext): Promise<void> {
      await limiter.consume(
        rateLimitKeys.tokenEndpointByIp(context.ipHash),
        TOKEN_ENDPOINT_RATE_LIMIT,
      );

      const strength = checkPasswordStrength(input.password);
      if (!strength.ok) {
        throw new ValidationError(strength.message, {
          message: `Reset rejected: password ${strength.reason}`,
        });
      }

      const newPasswordHash = await hasher.hash(input.password);
      const userId = await repository.resetPasswordWithToken({
        tokenHash: hashToken(input.token),
        newPasswordHash,
        now: clock.now(),
      });

      if (userId === null) {
        throw new ValidationError(TOKEN_FAILURE_MESSAGE, {
          message: 'Reset token unknown, consumed, or expired',
        });
      }

      logger.info({ event: 'password_reset.completed' }, 'password reset, all sessions revoked');

      // The actor is the USER whose password changed, not the caller — a reset
      // is performed by whoever holds the token, and the whole point of the row
      // is to record whose credentials moved.
      //
      // NOTHING ABOUT THE TOKEN AND NOTHING ABOUT THE EMAIL. The token is a
      // live credential until it is consumed, and an email address is PII; the
      // scrubber would drop both, but a payload that relies on the scrubber is
      // a payload written by someone who did not think about it.
      await audit.record({
        actor: { userId, role: null },
        action: AUDIT_ACTIONS.PASSWORD_RESET,
        resourceType: AUDIT_RESOURCES.USER,
        resourceId: userId,
        metadata: { sessionsRevoked: true, via: 'reset_token' },
      });
    },

    /**
     * §6.8, step 1 — the student requests a code. Resolves D-012.
     *
     * THE CODE IS A ROW, NOT A CACHE ENTRY. It used to live in `platform/cache`
     * under a 15-minute expiring key, which bought "one active code per
     * student" and the expiry for free and gave away durability in exchange: a
     * cache restart silently invalidated every outstanding code, so a parent
     * entering a code their child had just read aloud was told it was invalid.
     * Intermittent, unreproducible, and in the middle of the onboarding funnel.
     *
     * ONE ACTIVE CODE PER STUDENT is now a PARTIAL UNIQUE INDEX on
     * `student_user_id WHERE consumed_at IS NULL`. There is deliberately no
     * application-level emulation of it here — no "look up the previous code
     * and delete it" pass. `issueLinkCode` retires the outstanding row and
     * inserts the new one in ONE transaction, and if two requests race, the
     * index rejects the loser with a constraint violation that surfaces as a
     * 409. A check-then-write in this method could only ever be a slower way of
     * being wrong (D-021).
     *
     * The 15-minute expiry is unchanged and every comparison against it goes
     * through the injected clock.
     */
    async generateLinkCode(actor: SessionActor): Promise<{ code: string; expiresAt: Date }> {
      if (actor.role !== 'student') {
        throw new ForbiddenError({ message: 'Only a student may issue a link code' });
      }

      /**
       * 5 PER HOUR, KEYED BY THE STUDENT - open item 2, previously unbounded.
       *
       * A student session could mint codes without limit. The interesting harm
       * is not brute force (the parent-side submit limit covers that) but the
       * two failures below, and the second is the one that lasts:
       *
       *   - EVERY MINT RETIRES THE PREVIOUS CODE. A screen or a script issuing
       *     in a loop therefore invalidates the code the parent is part-way
       *     through typing - a student denying their own onboarding, which is
       *     the one funnel the product cannot afford to lose.
       *   - `link_codes` GROWS WITHOUT BOUND. Rows are never deleted (they are
       *     the audit trail of which code produced which link, D-012), so an
       *     unbounded mint rate is an unbounded table.
       *
       * BEFORE the insert, so a rejected request costs a cache round trip and
       * nothing else. Keyed by the student's user id and not by IP: the actor is
       * authenticated, so the account is the thing to limit, and an IP key would
       * throttle a whole school behind one NAT.
       */
      await limiter.consume(rateLimitKeys.linkCodeByStudent(actor.userId), LINK_CODE_RATE_LIMIT);

      const now = clock.now();
      const issued = await repository.issueLinkCode({
        studentUserId: actor.userId,
        code: buildLinkCode(deps.randomInt),
        expiresAt: expiryFrom(now, LINK_CODE_TTL_MS),
        now,
      });

      logger.info({ event: 'link_code.issued' }, 'link code issued');
      return { code: issued.code, expiresAt: issued.expiresAt };
    },

    /**
     * The student's outstanding code, if they still have one.
     *
     * Exists because of the failure D-012 describes from the other direction: a
     * screen that re-issues on every render would invalidate the very code the
     * parent is part-way through typing. With a read, the app can show the same
     * code again instead of minting a replacement.
     *
     * An expired-but-unconsumed row is not an active code, and the comparison
     * is against the injected clock.
     */
    async getActiveLinkCode(actor: SessionActor): Promise<{ code: string; expiresAt: Date } | null> {
      if (actor.role !== 'student') {
        throw new ForbiddenError({ message: 'Only a student has a link code' });
      }

      const active = await repository.findActiveLinkCodeForStudent(actor.userId, clock.now());
      return active === null ? null : { code: active.code, expiresAt: active.expiresAt };
    },

    /**
     * §6.8, steps 3 and 4 — the parent submits the code.
     *
     * THE TRAP, called out in the plan and worth repeating at the call site:
     * it is tempting to grant access the moment the code is entered. This
     * method creates a `pending` row and NOTHING ELSE. No read is possible
     * until the student approves.
     *
     * Rate limited at 5 per hour per parent account before any lookup — a
     * 6-character code is brute-forceable without it.
     */
    async submitLinkCode(actor: SessionActor, rawCode: string): Promise<LinkRecord> {
      if (actor.role !== 'parent') {
        throw new ForbiddenError({ message: 'Only a parent may submit a link code' });
      }

      await limiter.consume(rateLimitKeys.linkSubmitByParent(actor.userId), LINK_SUBMIT_RATE_LIMIT);

      const code = normaliseLinkCode(rawCode);

      // A malformed code and an unknown code fail identically. Distinguishing
      // them would tell a brute-forcer which guesses were well-formed.
      const invalid = new ValidationError('That code is invalid or has expired.', {
        message: 'Link code rejected',
      });

      if (!isValidLinkCode(code)) throw invalid;

      // SINGLE USE, and the consume is what makes it single use: unknown,
      // already-spent and expired all come back null from the same locked
      // read-and-update, so two parents racing on one code cannot both win and
      // a brute-forcer learns nothing from which of the three it hit.
      //
      // Expiry is compared inside that statement against the clock passed in
      // here — there is no second, cache-shaped copy of the deadline any more.
      const consumed = await repository.consumeLinkCode({ code, now: clock.now() });
      if (consumed === null) throw invalid;

      // The database also carries a CHECK that the two ids differ; this makes
      // the failure a clean 400 rather than a constraint violation. Reaching it
      // requires one account to be both parent and student, which the role
      // column forbids — it is a belt on top of braces.
      if (consumed.studentUserId === actor.userId) throw invalid;

      /**
       * A CROSS-TENANT LINK IS REFUSED HERE, AND THIS IS THE ONE PLACE IT CAN
       * BE - D-073.
       *
       * `parent_child_links` is the only cross-user data path in the product: it
       * is the row whose entire function is to let one account read another's.
       * Every other tenant decision is made by `assertCanAccess` at READ time,
       * but a link row spans two users, so it carries ONE tenant and the two
       * parties must agree on it before it is written. There is no read-time
       * check that could repair a row filed under the wrong one.
       *
       * The refusal is the SAME `invalid` error as an unknown or expired code.
       * Distinguishing them would tell a parent in tenant A that a given code
       * belongs to a real student in tenant B - the existence disclosure a
       * white-labelled deployment cannot afford, delivered by a helpful error
       * message.
       *
       * The code is already consumed at this point and stays consumed. That is
       * correct: it was presented to the wrong tenant and must not be reusable.
       */
      const studentTenantId = await repository.findUserTenant(consumed.studentUserId);
      if (studentTenantId === null || studentTenantId !== actor.tenantId) throw invalid;

      const link = await repository.upsertPendingLink({
        parentUserId: actor.userId,
        studentUserId: consumed.studentUserId,
        linkCode: code,
        tenantId: actor.tenantId,
      });

      logger.info({ event: 'link.submitted', status: link.status }, 'link request created');
      return link;
    },

    /**
     * §6.8, steps 5 and 6 — THE STUDENT APPROVES, IN THE APP.
     *
     * This is what makes consent real, and it is what you point at when a
     * parent, a school, or a regulator asks how consent is obtained. A code
     * alone never grants access.
     *
     * A non-student actor, or a student who is not the subject of this link,
     * gets an identical contentless 403 — the response must not reveal that
     * the link id exists.
     */
    async approveLink(actor: SessionActor, linkId: string): Promise<LinkRecord> {
      if (actor.role !== 'student') {
        throw new ForbiddenError({ message: 'Only the student may approve a link' });
      }

      const approved = await repository.approveLink(linkId, actor.userId, clock.now());
      if (approved === null) {
        // Unknown id, someone else's link, or not pending — one response for
        // all three (§7, rule 2: no payload on a deny).
        throw new ForbiddenError({ message: 'Link approval refused' });
      }

      logger.info({ event: 'link.approved' }, 'link approved by student');

      // THE CONSENT RECORD, and it is the most important audit row in the
      // product today.
      //
      // §6.8 step 5: the student approves, in the app, and a code alone never
      // grants access. This row is what you point at when a parent, a school or
      // a regulator asks HOW consent was obtained and WHEN — a question about a
      // minor's data that "the link row has status approved" answers only
      // weakly, because that column is current state and can change again.
      //
      // Identifiers only: which parent, which student, which link. No names.
      await audit.record({
        actor: { userId: actor.userId, role: actor.role },
        action: AUDIT_ACTIONS.LINK_APPROVED,
        resourceType: AUDIT_RESOURCES.PARENT_CHILD_LINK,
        resourceId: approved.id,
        metadata: {
          parentUserId: approved.parentUserId,
          studentUserId: approved.studentUserId,
        },
      });

      return approved;
    },

    /**
     * §6.8, step 7 — either party may revoke, and revocation is IMMEDIATE.
     *
     * Immediate because nothing about link state is cached in the session:
     * every parent read calls `findLinkStatus` at query time, so the next
     * request after this one is already denied.
     *
     * Authorization is expressed inside the UPDATE's WHERE clause rather than
     * as a prior SELECT, so there is no window between the check and the write.
     * `platform/authz` has no rule for "membership of a link" — its table
     * covers a parent READING child data, which is a different question — so
     * this is the one place in the module where a participation rule is
     * enforced directly. It is deliberately not routed through the guard,
     * because bending an access rule to fit a case it was not written for is
     * how access-control bugs are born.
     */
    async revokeLink(actor: SessionActor, linkId: string): Promise<LinkRecord> {
      const revoked = await repository.revokeLink(linkId, actor.userId, clock.now());
      if (revoked === null) {
        throw new ForbiddenError({ message: 'Link revocation refused' });
      }

      logger.info({ event: 'link.revoked', by: actor.role }, 'link revoked');

      // The other half of the consent trail. `revokedBy` is recorded because
      // EITHER party may revoke (§6.8 step 7), and "the parent withdrew" and
      // "the child withdrew" are very different facts to a school — and the
      // link row itself records only that it happened, not who did it.
      await audit.record({
        actor: { userId: actor.userId, role: actor.role },
        action: AUDIT_ACTIONS.LINK_REVOKED,
        resourceType: AUDIT_RESOURCES.PARENT_CHILD_LINK,
        resourceId: revoked.id,
        metadata: {
          parentUserId: revoked.parentUserId,
          studentUserId: revoked.studentUserId,
          revokedByRole: actor.role,
        },
      });

      return revoked;
    },

    /**
     * A parent's approved children. Pending and revoked links are not children
     * and never appear here.
     */
    async getLinkedChildren(actor: SessionActor): Promise<LinkedChildRecord[]> {
      if (actor.role !== 'parent') {
        throw new ForbiddenError({ message: 'Only a parent has linked children' });
      }
      return repository.listApprovedChildren(actor.userId);
    },

    /**
     * The predicate other modules ask before serving a child's data.
     *
     * Read at query time, every time. Never memoised, never put in the session.
     */
    async isLinkApproved(parentUserId: string, studentUserId: string): Promise<boolean> {
      const status = await repository.findLinkStatus(parentUserId, studentUserId);
      return status === 'approved';
    },

    getTenantOfUser(userId: string): Promise<string | null> {
      return repository.findUserTenant(userId);
    },

    async getNotificationRecipient(userId: string): Promise<NotificationRecipient | null> {
      const user = await repository.findUserById(userId);
      if (user === null) return null;
      return {
        userId: user.id,
        tenantId: user.tenantId,
        // Verified addresses only. See the note on the interface.
        email: user.emailVerifiedAt === null ? null : user.email,
      };
    },

    /**
     * THE cross-module entry point to the access boundary.
     *
     * `learner`, `practice`, `foxy` and `parent` call this before serving
     * anything belonging to a student. It resolves the link status now and
     * hands it to `platform/authz`, which throws a contentless
     * `ForbiddenError` when the answer is no.
     */
    async assertParentCanReadChild(actor: SessionActor, studentUserId: string): Promise<void> {
      const guard = await guardFor(actor, studentUserId);
      const tenantId = await tenantOfStudent(actor, studentUserId);
      guard.assertCanAccess(actor, 'read', {
        kind: 'student-data',
        studentUserId,
        scope: 'profile',
        /**
         * An unknown student resolves to the empty string, which
         * `assertCanAccess` treats as "no tenant" and DENIES.
         *
         * Deliberately routed through the guard rather than thrown here. There
         * is one place a 403 is shaped (rule 2 of section 7) and one place
         * access is decided, and "the student does not exist" must produce
         * byte-identical output to "the student is in another tenant" - which it
         * only does if both go down the same path.
         */
        tenantId: tenantId ?? '',
      });
    },
  };
}
