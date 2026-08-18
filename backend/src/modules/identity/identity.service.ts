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
  RateLimitError,
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
  CHANGE_PASSWORD_RATE_LIMIT,
  LINK_OTP_RATE_LIMIT,
  LINK_REDEEM_RATE_LIMIT,
  TOKEN_ENDPOINT_RATE_LIMIT,
} from '@/shared/constants/rate-limits';
import type {
  ChangePasswordRequest,
  ForgotPasswordRequest,
  LinkOtpRedeem,
  LinkOtpRequest,
  LoginRequest,
  ResendVerificationRequest,
  ResetPasswordRequest,
  SignupRequest,
} from '@/shared/contracts/identity.contract';
import {
  generateLinkCode as buildLinkCode,
  isValidLinkCode,
  normaliseLinkCode,
  type RandomInt,
} from './domain/link-code';
import {
  LINK_OTP_LOCK_MS,
  LINK_OTP_MAX_ATTEMPTS,
  LINK_OTP_TTL_MS,
  generateLinkOtp,
  hashLinkOtp,
  isLinkOtpExpired,
  isLinkOtpLocked,
  isResendTooSoon,
  verifyLinkOtp,
} from './domain/link-otp';
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

/**
 * ONE MESSAGE FOR "wrong current password" AND FOR "the session's user is gone".
 *
 * Both are a failed credential from the caller's point of view and there is
 * nothing useful to tell them apart with. Naming which one happened would say
 * whether the account still exists to somebody holding a stale cookie.
 */
const CHANGE_PASSWORD_FAILURE_MESSAGE = 'That password is not correct.';

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
   * A v4 UUID, injected like every other source of nondeterminism here.
   *
   * The OTP digest is salted with the challenge id, so the id must exist before
   * the hash — it cannot come from a database default, and a test needs it
   * predictable.
   */
  readonly randomUuid: () => string;
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
  /**
   * Re-mails a verification link — D-291, the recovery path D-217 assumed.
   *
   * Returns `void` on every branch and reveals nothing: unknown address,
   * already-verified address and awaiting-verification address are
   * indistinguishable to the caller.
   */
  resendVerification(input: ResendVerificationRequest, context: RequestContext): Promise<void>;
  verifyEmail(token: string, context: RequestContext): Promise<AuthenticatedResult>;
  login(input: LoginRequest, context: RequestContext): Promise<AuthenticatedResult>;
  /**
   * Rate limited by IP, and the context is REQUIRED for that reason (D-220).
   * An optional context would make the limit optional at every call site.
   */
  logout(token: string | undefined, context: RequestContext): Promise<void>;
  logoutAll(actor: SessionActor): Promise<number>;
  validateSession(token: string | undefined): Promise<SessionActor>;
  /**
   * ==========================================================================
   * THE FRONTEND'S BOOTSTRAP — 02-FRONTEND-IMPLEMENTATION-PLAN.md §5.5.
   *
   * The session lives in an httpOnly cookie, so the browser CANNOT READ IT.
   * "Am I signed in, and as whom" therefore has exactly one answer in the whole
   * product: ask the API. §5.5 names one endpoint for it and forbids any other
   * route to that question, because a second one is a second thing to keep
   * consistent and the symptom of inconsistency is auth flicker on every page
   * load.
   *
   * §5.5 named `GET /me/profile` for this and that route CANNOT serve it. It
   * returns a STUDENT profile — a parent has no `students` row, so a signed-in
   * parent gets 404, and an un-onboarded student gets the same 404 for an
   * entirely different reason. It also carries no role and no email, and §5.5
   * requires the role in the bootstrap response in order to choose navigation
   * and theme. Any frontend built on it would have to read "authenticated" out
   * of a 404, which is how a logged-in user gets bounced to login.
   *
   * So the bootstrap is here, on the module that owns sessions, and it returns
   * THE SAME SHAPE AS LOGIN. One parser on the frontend, one contract, and the
   * refresh path cannot diverge from the sign-in path.
   *
   * ---------------------------------------------------------------------------
   * A MISSING USER IS `UnauthenticatedError`, NOT `NotFoundError`.
   *
   * The actor came from a validated session, so reaching this with no row means
   * the account was deleted underneath a live session. 404 would tell the
   * frontend "you are signed in and the thing you asked for is gone", and it
   * would keep the dead session. 401 is what the whole client already knows how
   * to handle — clear the context, clear the query cache, go to login.
   * ==========================================================================
   */
  getCurrentUser(actor: SessionActor): Promise<UserRecord>;
  requestPasswordReset(input: ForgotPasswordRequest, context: RequestContext): Promise<void>;
  /**
   * A signed-in user rotating their own password.
   *
   * Returns nothing and REVOKES EVERY SESSION, the caller's included, so the
   * route must clear the cookie — see the implementation.
   */
  changePassword(actor: SessionActor, input: ChangePasswordRequest): Promise<void>;
  resetPassword(input: ResetPasswordRequest, context: RequestContext): Promise<void>;
  generateLinkCode(actor: SessionActor): Promise<{ code: string; expiresAt: Date | null }>;
  getActiveLinkCode(actor: SessionActor): Promise<{ code: string; expiresAt: Date | null } | null>;
  /**
   * Step 1 of guardian linking — migration 0007. Emails an OTP to the PARENT.
   *
   * Returns nothing and reveals nothing: a code that matched no student and a
   * code that matched one produce identical responses.
   */
  requestLinkOtp(actor: SessionActor, input: LinkOtpRequest): Promise<void>;
  /** Step 2 — the code plus the OTP. Creates the link ALREADY APPROVED. */
  redeemLinkCode(actor: SessionActor, input: LinkOtpRedeem): Promise<LinkRecord>;
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
   * The verification message, built in ONE place — D-291.
   *
   * Signup and the resend endpoint must produce the SAME link, against the same
   * endpoint, with the same encoding. Two copies of a URL template is two things
   * that can disagree, and the way they disagree is that one of them stops
   * verifying accounts — which is precisely the failure the resend endpoint was
   * added to repair.
   */
  function verificationMail(to: string, token: string): MailMessage {
    return {
      to,
      template: 'email-verification',
      data: {
        verifyUrl: `${urls.apiBaseUrl}/api/v1/auth/verify?token=${encodeURIComponent(token)}`,
      },
    };
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
      // recoverable by a resend. That ordering is what makes deferring safe —
      // and as of D-291 the resend it refers to is a real endpoint.
      deferMail(verificationMail(email, token), 'signup.verification_mail_failed');

      logger.info({ event: 'signup.created', role: input.role }, 'account created');
    },

    /**
     * THE RECOVERY PATH — D-291. `POST /api/v1/auth/resend-verification`.
     *
     * ========================================================================
     * WHY IT EXISTS. D-217 made signup survive a mail outage by taking the send
     * off the request path, and justified the fire-and-forget send with a
     * recovery path stated as already existing: "the verification and reset
     * tokens are committed rows, so a resend re-mails the token that is already
     * persisted." There were seven `/auth/*` routes and none of them resent
     * anything. An auditor confirmed it against a real server: with mail down, a
     * signup returned 201, the user row was created, no job was queued, and the
     * account was unverifiable and its address permanently taken. The account
     * survived the outage exactly as designed and was useless anyway.
     *
     * ========================================================================
     * THE RESPONSE IS CONSTANT ACROSS THREE BRANCHES, not two, and the third is
     * the one specific to this endpoint: unknown address, address awaiting
     * verification, and address ALREADY VERIFIED all return the same thing. A
     * distinct answer for "already verified" would leak both that the account
     * exists AND what state it is in — a strictly worse oracle than the one
     * `signup` and `forgot-password` are shaped to close.
     *
     * The structure is D-218's, applied to a third endpoint:
     *
     *  1. BOTH rate-limit counters are consumed before anything else, so a
     *     rejected request costs a cache round trip and no database work.
     *  2. THE TOKEN IS GENERATED BEFORE THE BRANCH, on every path, in the same
     *     spirit as login's dummy Argon2 verification. It costs one
     *     `randomBytes` and one SHA-256 whether or not it is ever stored.
     *  3. THE SEND IS DEFERRED, so it contributes to no branch's latency. It was
     *     the only term large enough to be measured from the internet.
     *
     * What remains on the mailing branch is ONE small transaction — sub-
     * millisecond, far below the jitter of any network an attacker could measure
     * across, and the same residual `requestPasswordReset` carries.
     *
     * ========================================================================
     * A NOTE ON "REUSES THE PERSISTED TOKEN", because the obvious reading of that
     * requirement is not implementable and silence about it would look like an
     * oversight. `email_verification_tokens` stores a SHA-256 OF the token and
     * never the token (§6.1) — that is the whole point of the column — so there
     * is nothing to re-mail from a surviving row. A resend must therefore mint a
     * fresh token, and the honest version of "or issues a fresh one and consumes
     * the old" is what happens on every call: `reissueEmailVerificationToken`
     * retires every outstanding row for the user and inserts the new one in ONE
     * transaction, so there is never more than one live link and never zero.
     */
    async resendVerification(
      input: ResendVerificationRequest,
      context: RequestContext,
    ): Promise<void> {
      const email = normaliseEmail(input.email);
      const emailKey = hashIdentifier(email);

      // BOTH counters, and before any lookup. The IP counter shares the token
      // endpoints' budget; the email counter is what stops this being a mail
      // bomb aimed at one address by a caller with many hosts.
      await limiter.consume(
        rateLimitKeys.tokenEndpointByIp(context.ipHash),
        TOKEN_ENDPOINT_RATE_LIMIT,
      );
      await limiter.consume(
        rateLimitKeys.resendVerificationByEmail(emailKey),
        TOKEN_ENDPOINT_RATE_LIMIT,
      );

      const now = clock.now();
      // BEFORE the branch, on all three paths. See point 2 above.
      const { token, hash } = generateToken(deps.randomBytes);

      const user = await repository.findUserByEmail(email);
      if (user === null) {
        logger.info(
          { event: 'resend_verification.unknown_address' },
          'verification resend requested for no account',
        );
        return;
      }

      if (user.emailVerifiedAt !== null) {
        // Nothing to resend, and nothing said about it. A verified account that
        // receives no email is the correct outcome: the link would grant a
        // session for an address whose owner did not ask for one.
        logger.info(
          { event: 'resend_verification.already_verified' },
          'verification resend requested for an already-verified account',
        );
        return;
      }

      await repository.reissueEmailVerificationToken({
        userId: user.id,
        tokenHash: hash,
        expiresAt: expiryFrom(now, EMAIL_VERIFICATION_TTL_MS),
        now,
      });

      // Committed above, then deferred — the same ordering as signup, and for
      // the same reason: a send that never happens costs one email, and the
      // caller can ask again.
      deferMail(verificationMail(email, token), 'resend_verification.mail_failed');

      logger.info({ event: 'resend_verification.sent' }, 'verification email queued');
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
     * The frontend bootstrap. See the interface for why it lives here and not
     * on `learner`.
     *
     * It re-reads the row rather than projecting the actor, and that is the
     * point: the actor carries `userId`, `role` and `tenantId` and nothing a
     * person sees. The email and the verification timestamp decide whether the
     * client shows a resend-verification affordance, and they can change during
     * a session — a row read answers as of now, a session projection answers as
     * of sign-in.
     */
    async getCurrentUser(actor: SessionActor): Promise<UserRecord> {
      const user = await repository.findUserById(actor.userId);
      if (user === null) {
        // 401, never 404. See the interface.
        throw new UnauthenticatedError('Authentication required.', {
          message: 'Session valid but user row absent',
          details: { userId: actor.userId },
        });
      }
      return user;
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
    /**
     * ========================================================================
     * CHANGE PASSWORD — a signed-in user rotating their own credential.
     *
     * THE CURRENT PASSWORD IS VERIFIED EVEN THOUGH THE SESSION IS VALID.
     *
     * A cookie proves the browser was signed in; it does not prove the person
     * at the keyboard is the account holder. Shared family devices are the
     * normal case here — the entire parent-child link design assumes them — so
     * changing a password on cookie possession alone would let whoever finds
     * the laptop open lock the owner out of their own account.
     *
     * ------------------------------------------------------------------------
     * EVERY SESSION IS REVOKED, THE CALLER'S INCLUDED.
     *
     * The tempting alternative is to keep the current session so the user is
     * not signed out of the device they are holding. It was rejected: `Actor`
     * carries no session identity (userId, role, tenantId and nothing else), so
     * sparing "this one" would mean threading the raw cookie token down into
     * the service — putting a live credential into a signature that has never
     * needed one — and the security argument runs the other way anyway. Somebody
     * changes their password BECAUSE they think someone else has it; a change
     * that leaves the other party's session alive does not do the one thing it
     * was asked to do.
     *
     * `resetPassword` already revokes everything for the same reason, so this
     * is the existing rule rather than a new one. The cost is one re-login.
     * ========================================================================
     */
    async changePassword(actor: SessionActor, input: ChangePasswordRequest): Promise<void> {
      /*
       * Keyed by USER, not by IP — this endpoint is an online guessing oracle
       * against `currentPassword`, and the caller is authenticated so the user
       * id is the honest identity. An IP counter would also punish everybody
       * behind a school's single address.
       */
      await limiter.consume(
        rateLimitKeys.changePasswordByUser(actor.userId),
        CHANGE_PASSWORD_RATE_LIMIT,
      );

      const user = await repository.findUserById(actor.userId);
      if (user === null) {
        // A valid session for a user row that no longer exists. Treated as a
        // failed credential rather than a 404: there is nothing to disclose.
        throw new ValidationError(CHANGE_PASSWORD_FAILURE_MESSAGE, {
          message: 'change-password: session user no longer exists',
        });
      }

      const currentOk = await hasher.verify(user.passwordHash, input.currentPassword);
      if (!currentOk) {
        throw new ValidationError(CHANGE_PASSWORD_FAILURE_MESSAGE, {
          message: 'change-password: current password did not verify',
        });
      }

      /*
       * THE SAME PASSWORD IS REFUSED, and the check is a `verify` against the
       * stored hash rather than a string comparison of the two inputs — Argon2
       * salts every hash, so the stored value cannot be compared any other way.
       * Accepting it would report success while changing nothing, which is the
       * worst possible answer to somebody who believes they have just secured
       * their account.
       */
      const unchanged = await hasher.verify(user.passwordHash, input.newPassword);
      if (unchanged) {
        throw new ValidationError('Choose a password you have not used here before.', {
          message: 'change-password: new password matches the current one',
        });
      }

      const strength = checkPasswordStrength(input.newPassword);
      if (!strength.ok) {
        throw new ValidationError(strength.message, {
          message: `change-password rejected: password ${strength.reason}`,
        });
      }

      const newPasswordHash = await hasher.hash(input.newPassword);
      await repository.changePassword({ userId: actor.userId, newPasswordHash });

      logger.info(
        { event: 'password_change.completed' },
        'password changed, all sessions revoked',
      );

      // AFTER the write, and carrying neither the old nor the new password.
      // `PASSWORD_CHANGED` rather than `PASSWORD_RESET`: this one was performed
      // by somebody who PROVED they had the credential, and "was this a takeover
      // or the owner tidying up" is the question the trail is read to answer.
      await audit.record({
        actor: { userId: actor.userId, role: actor.role },
        action: AUDIT_ACTIONS.PASSWORD_CHANGED,
        resourceType: AUDIT_RESOURCES.USER,
        resourceId: actor.userId,
        metadata: { sessionsRevoked: true, via: 'current_password' },
      });
    },

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
    async generateLinkCode(
      actor: SessionActor,
    ): Promise<{ code: string; expiresAt: Date | null }> {
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
      /*
       * NO EXPIRY — migration 0007. A fifteen-minute code required the parent
       * to be beside the child while it was generated, which is not how a code
       * reaches a parent: it is read out on a phone call, or sent home on a
       * slip. The code is still single-use and still one-per-student, and what
       * bounds an attacker who learns it is the OTP to the parent's own
       * mailbox, not a countdown.
       */
      const issued = await repository.issueLinkCode({
        studentUserId: actor.userId,
        code: buildLinkCode(deps.randomInt),
        expiresAt: null,
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
    async getActiveLinkCode(
      actor: SessionActor,
    ): Promise<{ code: string; expiresAt: Date | null } | null> {
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
    /**
     * ========================================================================
     * STEP 1 — THE PARENT SUBMITS THE CODE AND WE EMAIL THEM AN OTP.
     *
     * This replaces the consent model `submitLinkCode` below implements. That
     * one created a `pending` row for the STUDENT to approve, and the approval
     * step was unreachable: no endpoint exists through which a student can
     * discover a pending link's id, so every parent stayed pending forever.
     * The defect only appeared when the flow was walked end to end.
     *
     * The consent now lives where it already was in practice — the student
     * reading their code aloud is a deliberate act — and the second factor
     * protects the PARENT'S account instead of asking the student twice. A code
     * overheard in a classroom is not enough; you must also hold the mailbox.
     *
     * ------------------------------------------------------------------------
     * IT RETURNS THE SAME THING WHETHER OR NOT THE CODE EXISTS.
     *
     * Every early exit below is a silent success. The endpoint takes a short
     * code, so a truthful "no such student" would turn a 31^6 search into an
     * enumeration of children. The cost is a worse experience on a typo, and
     * that is the right trade on this particular list.
     * ========================================================================
     */
    async requestLinkOtp(actor: SessionActor, input: LinkOtpRequest): Promise<void> {
      if (actor.role !== 'parent') {
        throw new ForbiddenError({ message: 'Only a parent may link to a student' });
      }

      /*
       * Keyed by the PARENT, and it is the only limit that fires before any
       * database work. Every accepted request sends an email, so this is the
       * counter that stops the endpoint being a mail bomb aimed at whichever
       * address the caller is signed in as.
       */
      await limiter.consume(rateLimitKeys.linkOtpByParent(actor.userId), LINK_OTP_RATE_LIMIT);

      const code = normaliseLinkCode(input.code);
      // A malformed code is indistinguishable from an unknown one, on purpose.
      if (!isValidLinkCode(code)) return;

      const now = clock.now();
      // PEEK, not consume. The code must survive to be spent in step 2 — see
      // the repository note.
      const found = await repository.peekLinkCode({ code, now });
      if (found === null) return;
      if (found.studentUserId === actor.userId) return;

      /*
       * The cross-tenant refusal from `submitLinkCode`, applied one step
       * earlier and silently. Telling a parent in tenant A that a code belongs
       * to a real student in tenant B is the existence disclosure a
       * white-labelled deployment cannot afford (D-073).
       */
      const studentTenantId = await repository.findUserTenant(found.studentUserId);
      if (studentTenantId === null || studentTenantId !== actor.tenantId) return;

      const existing = await repository.findLinkOtpChallenge(actor.userId, code);
      /*
       * A LOCKED CHALLENGE IS NOT RE-SENT. Otherwise the lock protects only the
       * verify endpoint, and the way around it is to ask for a fresh secret.
       */
      if (existing !== null && isLinkOtpLocked(existing.lockedUntil, now)) return;
      // Resend cooldown, so the button cannot be leaned on.
      if (existing !== null && isResendTooSoon(existing.lastSentAt, now)) return;

      /*
       * The address comes from the ACCOUNT, never from the request — there is no
       * field on this endpoint that could redirect the OTP. It is also only
       * returned once verified, which is what stops an unverified typo at signup
       * from receiving somebody else's linking code.
       */
      const recipient = await repository.findUserById(actor.userId);
      if (recipient?.emailVerifiedAt == null) return;

      const student = await repository.findLearnerDisplayName(found.studentUserId);

      const challengeId = deps.randomUuid();
      const otp = generateLinkOtp(deps.randomInt);
      await repository.upsertLinkOtpChallenge({
        id: challengeId,
        parentUserId: actor.userId,
        studentUserId: found.studentUserId,
        code,
        otpHash: hashLinkOtp(otp, challengeId),
        expiresAt: new Date(now.getTime() + LINK_OTP_TTL_MS),
        now,
      });

      /*
       * DEFERRED, like every other send in this module. A mail outage must not
       * fail the request — the parent can press resend, and the challenge row is
       * already durable. `deferMail` logs the failure under a named event.
       */
      deferMail(
        {
          to: recipient.email,
          template: 'guardian-link-otp',
          data: { otp, studentName: student ?? 'your child' },
        },
        'link_otp.mail_failed',
      );

      logger.info({ event: 'link_otp.requested' }, 'guardian link OTP issued');
    },

    /**
     * ========================================================================
     * STEP 2 — THE CODE AND THE OTP. The link is created ALREADY APPROVED.
     *
     * Unlike step 1 this one DOES report failure, and it has to: a parent who
     * mistypes six digits must be told, or the screen is unusable. What it never
     * reports is WHICH thing was wrong — no challenge, wrong OTP, expired and
     * locked are one message, because the alternative tells an attacker whether
     * a given code has a live challenge against it.
     *
     * The exception is the LOCK, which is surfaced as a distinct error. A person
     * locked out for an hour who is told only "that code is wrong" will keep
     * trying, and every attempt after the cap is a request that can never
     * succeed. That is a support ticket, not a security gain.
     * ========================================================================
     */
    async redeemLinkCode(actor: SessionActor, input: LinkOtpRedeem): Promise<LinkRecord> {
      if (actor.role !== 'parent') {
        throw new ForbiddenError({ message: 'Only a parent may link to a student' });
      }

      await limiter.consume(
        rateLimitKeys.linkRedeemByParent(actor.userId),
        LINK_REDEEM_RATE_LIMIT,
      );

      const code = normaliseLinkCode(input.code);
      const invalid = new ValidationError('That code or verification code is not correct.', {
        message: 'Link redeem rejected',
      });

      if (!isValidLinkCode(code)) throw invalid;

      const now = clock.now();
      const challenge = await repository.findLinkOtpChallenge(actor.userId, code);
      if (challenge === null) throw invalid;

      /*
       * THE LOCK IS CHECKED BEFORE THE OTP AND DOES NOT SPEND AN ATTEMPT.
       * Checking it after would let a locked-out caller keep incrementing the
       * counter, and a lock that extends itself on every rejected request is a
       * permanent lock.
       */
      if (isLinkOtpLocked(challenge.lockedUntil, now)) {
        throw new RateLimitError(
          Math.ceil(((challenge.lockedUntil?.getTime() ?? now.getTime()) - now.getTime()) / 1000),
          { message: 'Link redeem locked after too many wrong codes' },
        );
      }

      if (isLinkOtpExpired(challenge.expiresAt, now)) throw invalid;

      if (!verifyLinkOtp(challenge.otpHash, input.otp, challenge.id)) {
        const willReachCap = challenge.attempts + 1 >= LINK_OTP_MAX_ATTEMPTS;
        await repository.recordLinkOtpFailure({
          id: challenge.id,
          lockedUntil: willReachCap ? new Date(now.getTime() + LINK_OTP_LOCK_MS) : null,
        });
        logger.warn({ event: 'link_otp.wrong_code' }, 'guardian link OTP rejected');
        throw invalid;
      }

      /*
       * SPEND THE CODE ONLY NOW. Both factors have been shown, so this is the
       * first moment at which burning it is correct: the same locked
       * read-and-update as before, so two parents racing on one code cannot both
       * win.
       */
      const consumed = await repository.consumeLinkCode({ code, now });
      if (consumed === null) throw invalid;
      if (consumed.studentUserId !== challenge.studentUserId) throw invalid;

      // Re-checked after consuming, because a tenant can change between the two
      // steps and this row spans both parties (D-073).
      const studentTenantId = await repository.findUserTenant(consumed.studentUserId);
      if (studentTenantId === null || studentTenantId !== actor.tenantId) throw invalid;

      const link = await repository.createApprovedLink({
        parentUserId: actor.userId,
        studentUserId: consumed.studentUserId,
        linkCode: code,
        tenantId: actor.tenantId,
        now,
      });

      // A SPENT CHALLENGE IS DELETED. A second factor that survives its own use
      // is replayable, and the row has no further purpose.
      await repository.deleteLinkOtpChallenge(challenge.id);

      logger.info({ event: 'link.redeemed' }, 'guardian linked');

      /*
       * The audit row records the STUDENT as having approved, because the act
       * being recorded is the code hand-off. `LINK_APPROVED` and not a new
       * action: from a school's or a regulator's point of view this is the same
       * event the old flow recorded, reached by a different route, and `metadata`
       * carries which one.
       */
      await audit.record({
        actor: { userId: consumed.studentUserId, role: 'student' },
        action: AUDIT_ACTIONS.LINK_APPROVED,
        resourceType: AUDIT_RESOURCES.PARENT_CHILD_LINK,
        resourceId: link.id,
        metadata: { via: 'link_code_otp', parentUserId: actor.userId },
      });

      return link;
    },

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
