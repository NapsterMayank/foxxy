/**
 * The rate-limit table — 01-BACKEND-IMPLEMENTATION-PLAN.md §6.9.
 *
 * Transcribed literally so the policy is readable in one place rather than
 * scattered as magic numbers through the service.
 *
 * Counters live in `platform/cache` under an expiring key, NEVER in process
 * memory: in-memory counters stop working the moment a second instance runs,
 * and they fail silently (00-ARCHITECTURE.md §7).
 */

const HOUR_SECONDS = 3600;
const FIFTEEN_MINUTES_SECONDS = 900;

export interface RateLimitRule {
  /** Requests permitted inside one window. */
  readonly limit: number;
  /** Window length in seconds. */
  readonly windowSeconds: number;
}

/** signup — 3 / hour, keyed by IP. */
export const SIGNUP_RATE_LIMIT: RateLimitRule = { limit: 3, windowSeconds: HOUR_SECONDS };

/** login — 5 / 15 min, keyed by IP **and** by email. Both counters apply. */
export const LOGIN_RATE_LIMIT: RateLimitRule = {
  limit: 5,
  windowSeconds: FIFTEEN_MINUTES_SECONDS,
};

/** forgot-password — 3 / hour, keyed by IP **and** by email. */
export const FORGOT_PASSWORD_RATE_LIMIT: RateLimitRule = { limit: 3, windowSeconds: HOUR_SECONDS };

/**
 * logout — 30 / hour, keyed by IP. D-220.
 *
 * `POST /auth/logout` is deliberately NOT behind `requireSession` (logging out
 * with an already-dead session must succeed, not 401), which for two build
 * cycles also meant it was the ONE unauthenticated, UNTHROTTLED endpoint that
 * reached the database — and the database it reached is the `auth` pool, the
 * pool §3.1's bulkhead exists to keep free for login. Anyone could empty it from
 * one host with a loop and no credentials.
 *
 * 30/hour rather than the 5 or the 3 above: logout is an ordinary action a real
 * browser performs, a shared NAT multiplies it, and unlike login there is
 * nothing to guess here — the limit is a flood bound, not a brute-force bound.
 * A caller who exceeds it is not a user signing out.
 */
export const LOGOUT_RATE_LIMIT: RateLimitRule = { limit: 30, windowSeconds: HOUR_SECONDS };

/** verify and reset — 10 / hour, keyed by IP. */
export const TOKEN_ENDPOINT_RATE_LIMIT: RateLimitRule = { limit: 10, windowSeconds: HOUR_SECONDS };

/**
 * link-code ISSUE — 5 / hour, keyed by the STUDENT user id.
 *
 * Open item 2. A student session could previously mint codes without bound.
 * Brute force is not the risk here — that is the submit limit's job, below —
 * the risks are that every mint RETIRES the previous code (so a loop denies the
 * student their own onboarding, by invalidating the code the parent is typing)
 * and that `link_codes` rows are never deleted, so an unbounded mint rate is an
 * unbounded table.
 *
 * The same 5/hour as submit, and deliberately so: a student who needs a sixth
 * code in an hour is not in a flow the product supports, they are in a loop.
 */
export const LINK_CODE_RATE_LIMIT: RateLimitRule = { limit: 5, windowSeconds: HOUR_SECONDS };

/**
 * link-code submit — 5 / hour, keyed by the parent user id.
 *
 * A 6-character code is brute-forceable without this. It is one of the four
 * defences on link codes, alongside short expiry, one active code per student,
 * and mandatory student approval (§6.10).
 */
export const LINK_SUBMIT_RATE_LIMIT: RateLimitRule = { limit: 5, windowSeconds: HOUR_SECONDS };

/**
 * all other authenticated requests — 100 / min, keyed by user id.
 *
 * APPLIED as of this wave, by `app/plugins/authenticated-rate-limit.ts`. It was
 * declared here and enforced nowhere for two build cycles, deferred on "a second
 * module having routes"; there are now three, and `/me/*` and `/content/*` were
 * unthrottled for any logged-in caller.
 *
 * It is a BACKSTOP, not a policy. The per-endpoint limits above are stricter and
 * are what actually protects signup, login and link codes; this one exists so
 * that an endpoint nobody thought about is bounded by default rather than
 * unbounded by default. Its counters live under a separate key namespace, so a
 * request that consumes a per-endpoint budget consumes exactly one of these too
 * — never two, and never instead.
 */
export const AUTHENTICATED_RATE_LIMIT: RateLimitRule = { limit: 100, windowSeconds: 60 };
