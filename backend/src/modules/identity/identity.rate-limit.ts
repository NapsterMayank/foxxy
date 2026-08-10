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
  forgotByIp: (ipHash: string): string => `${RATE_LIMIT_KEY_PREFIX}:forgot:ip:${ipHash}`,
  forgotByEmail: (emailHash: string): string =>
    `${RATE_LIMIT_KEY_PREFIX}:forgot:email:${emailHash}`,
  tokenEndpointByIp: (ipHash: string): string => `${RATE_LIMIT_KEY_PREFIX}:token:ip:${ipHash}`,
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
  linkSubmitByParent: (parentUserId: string): string =>
    `${RATE_LIMIT_KEY_PREFIX}:link-submit:${parentUserId}`,
  authenticatedByUser: (userId: string): string => `${RATE_LIMIT_KEY_PREFIX}:auth:${userId}`,
} as const;

export type RateLimiterDeps = Omit<PlatformRateLimiterDeps, 'fallbackMetric'>;

/** The platform limiter, with identity's metric name bound. */
export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  return createPlatformRateLimiter({ ...deps, fallbackMetric: RATE_LIMIT_FALLBACK_METRIC });
}
