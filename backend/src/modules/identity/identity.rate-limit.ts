import {
  createRateLimiter as createPlatformRateLimiter,
  type RateLimiterDeps as PlatformRateLimiterDeps,
  type RateLimiter,
} from '@/platform/rate-limit/index';

/**
 * Identity's rate-limit POLICY — 01-BACKEND-IMPLEMENTATION-PLAN.md §6.9.
 *
 * ===========================================================================
 * THE MECHANISM MOVED; THE POLICY DID NOT — D-080.
 *
 * The fixed-window counter, its cache backing and its in-process fallback used
 * to live in this file, because identity was the only module with routes. They
 * now live in `platform/rate-limit`, unchanged, because the GLOBAL authenticated
 * limit (§6.9's last row) is registered in `app/plugins` for every module and
 * `app/` may not import a module's internals. The alternative was a second copy
 * of the same window arithmetic with its own fallback and its own bugs.
 *
 * WHAT STAYED HERE IS WHAT IS ACTUALLY IDENTITY'S: the key namespace, the key
 * builders (including the decision to hash an email before it becomes a cache
 * key), and the metric name that says WHICH limiter degraded. `platform/` holds
 * no business rules, and "an email is hashed before it is used as a key" is one.
 *
 * `createRateLimiter` is re-exported rather than replaced so that every existing
 * caller and test is untouched, and so that identity's metric name is bound in
 * exactly one place instead of at each call site.
 */

export type { MetricsSink, RateLimiter } from '@/platform/rate-limit/index';
export { InProcessRateLimitCounters } from '@/platform/rate-limit/index';

/** Emitted on every activation. Alert on it: it means the cache is down. */
export const RATE_LIMIT_FALLBACK_METRIC = 'identity.rate_limit.in_process_fallback';

/** Namespaced so identity counters cannot collide with any other cache use. */
export const RATE_LIMIT_KEY_PREFIX = 'rl:identity';

export const rateLimitKeys = {
  signupByIp: (ipHash: string): string => `${RATE_LIMIT_KEY_PREFIX}:signup:ip:${ipHash}`,
  loginByIp: (ipHash: string): string => `${RATE_LIMIT_KEY_PREFIX}:login:ip:${ipHash}`,
  /**
   * Keyed by the email, HASHED.
   *
   * Two reasons it is hashed rather than used raw. It keeps a plaintext list of
   * every address that has attempted a login out of the cache, which is a store
   * with a weaker access model than the database. And it bounds the key length
   * regardless of the address.
   */
  loginByEmail: (emailHash: string): string => `${RATE_LIMIT_KEY_PREFIX}:login:email:${emailHash}`,
  /**
   * Logout, keyed by IP — D-220.
   *
   * Its own namespace rather than sharing `login:ip:`, because a shared counter
   * would let a flood of anonymous logouts spend the budget a real user needs to
   * sign IN. Throttling the cheap unauthenticated endpoint must never be able to
   * lock anybody out of the expensive authenticated one.
   */
  logoutByIp: (ipHash: string): string => `${RATE_LIMIT_KEY_PREFIX}:logout:ip:${ipHash}`,
  forgotByIp: (ipHash: string): string => `${RATE_LIMIT_KEY_PREFIX}:forgot:ip:${ipHash}`,
  forgotByEmail: (emailHash: string): string =>
    `${RATE_LIMIT_KEY_PREFIX}:forgot:email:${emailHash}`,
  tokenEndpointByIp: (ipHash: string): string => `${RATE_LIMIT_KEY_PREFIX}:token:ip:${ipHash}`,
  /**
   * change-password, keyed by the authenticated USER rather than by IP.
   *
   * Every other password counter here is per-IP, and this one must not be: the
   * caller is authenticated, so the user id is the honest identity, and an IP
   * counter would let one attacker on a shared network exhaust the budget for
   * everybody behind it — a school or an internet cafe, which is this product's
   * normal deployment.
   */
  changePasswordByUser: (userId: string): string =>
    `${RATE_LIMIT_KEY_PREFIX}:change-password:user:${userId}`,
  /**
   * Resend-verification, keyed by the EMAIL, hashed — D-291.
   *
   * The IP side of this endpoint rides `tokenEndpointByIp` with the other two
   * token endpoints. This second counter is what stops the endpoint being a MAIL
   * BOMB aimed at one address: every accepted resend sends an email, so an
   * attacker rotating IPs against one victim would otherwise be bounded only by
   * how many hosts they have. Exactly the reasoning behind `forgotByEmail`, and
   * its own namespace for exactly the same reason — a shared counter would let
   * one person's resends spend another's budget.
   */
  resendVerificationByEmail: (emailHash: string): string =>
    `${RATE_LIMIT_KEY_PREFIX}:resend-verification:email:${emailHash}`,
  /**
   * The STUDENT minting a code — open item 2, 5 per hour.
   *
   * A separate namespace from `linkSubmitByParent` below, and the separation is
   * the point: issuing and submitting are different actions by different people
   * with different failure modes, and a shared key would let a student's minting
   * consume a parent's submit budget.
   */
  linkCodeByStudent: (studentUserId: string): string =>
    `${RATE_LIMIT_KEY_PREFIX}:link-code:${studentUserId}`,
  /** link OTP request, keyed by the parent — every accepted call sends an email. */
  linkOtpByParent: (parentUserId: string): string =>
    `${RATE_LIMIT_KEY_PREFIX}:link-otp:parent:${parentUserId}`,
  /** link OTP redeem, keyed by the parent. The per-challenge cap does the real work. */
  linkRedeemByParent: (parentUserId: string): string =>
    `${RATE_LIMIT_KEY_PREFIX}:link-redeem:parent:${parentUserId}`,
  linkSubmitByParent: (parentUserId: string): string =>
    `${RATE_LIMIT_KEY_PREFIX}:link-submit:${parentUserId}`,
  authenticatedByUser: (userId: string): string => `${RATE_LIMIT_KEY_PREFIX}:auth:${userId}`,
} as const;

export type RateLimiterDeps = Omit<PlatformRateLimiterDeps, 'fallbackMetric'>;

/** The platform limiter, with identity's metric name bound. */
export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  return createPlatformRateLimiter({ ...deps, fallbackMetric: RATE_LIMIT_FALLBACK_METRIC });
}
