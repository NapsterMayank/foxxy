import { FOXY_DAILY_MESSAGE_LIMIT, type FoxyPlan } from '@/shared/constants/foxy';

/**
 * THE DAILY USAGE LIMIT — §8.5, "the usage limit blocks a message once
 * exceeded".
 *
 * ===========================================================================
 * THE DECISION IS PURE; THE COUNTER IS NOT.
 *
 * Everything in this file is arithmetic on numbers that are passed in. The
 * counter itself lives in `platform/cache` under an expiring key, because
 * 00-ARCHITECTURE.md §7 is explicit that counters never live in process memory:
 * an in-memory counter stops working the moment a second instance runs, and it
 * fails SILENTLY — the limit reads as enforced, and is not. That is the same
 * failure shape as an authorisation guard that compares a value with itself.
 *
 * Splitting them this way means the RULE can be exhaustively tested with no
 * cache at all, and the cache can be tested for the one thing it is responsible
 * for: that the key expires.
 * ===========================================================================
 *
 * THE COUNT IS OF STUDENT MESSAGES, NOT OF MODEL CALLS, and the difference is
 * deliberate. An abstention consumes a message: it costs a retrieval, and a
 * student who could abstain for free would have an unlimited supply of
 * retrievals. A REFUSED message — one the safety classifier stopped — does NOT
 * consume one, because charging a child for being told to talk to an adult is
 * indefensible.
 */

export interface UsageDecision {
  readonly allowed: boolean;
  /** Messages already used today, before this one. */
  readonly used: number;
  /** The plan's daily allowance. */
  readonly limit: number;
  /** How many remain AFTER this message, floored at zero. */
  readonly remaining: number;
}

/**
 * The UTC day a counter belongs to.
 *
 * UTC RATHER THAN Asia/Kolkata, and it is a known, deliberate imperfection. A
 * student's day rolls over at 05:30 IST rather than midnight, which lands in
 * the middle of nobody's study session — whereas a timezone-aware key needs
 * per-user timezone storage, which does not exist (PROGRESS.md §7 records the
 * same gap for job scheduling, D-069). Stated here so the next person changes
 * it deliberately rather than discovering it.
 *
 * The clock is INJECTED by the caller. There is no `new Date()` in this module.
 */
export function usageDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** `foxy:usage:<userId>:<YYYY-MM-DD>`. One namespace, one shape. */
export function usageCacheKey(userId: string, now: Date): string {
  return `foxy:usage:${userId}:${usageDayKey(now)}`;
}

/**
 * How long the counter lives.
 *
 * A FULL DAY PLUS AN HOUR, not exactly a day. The key is created at the first
 * message of the day and must survive until that same calendar day ends; an
 * exact 24 hours would expire it mid-morning the following day, at which point
 * a student who started early gets a second allowance. The extra hour is slack
 * for the same reason.
 */
export const USAGE_TTL_SECONDS = 25 * 60 * 60;

/**
 * Whether one more message is allowed.
 *
 * `used` is the count BEFORE this message. The comparison is `<` rather than
 * `<=` for exactly that reason, and the boundary is tested at limit-1, limit
 * and limit+1 — an off-by-one here is either a free message every day for every
 * account or a student blocked one message early, and neither shows up as an
 * error anywhere.
 */
export function decideUsage(used: number, plan: FoxyPlan): UsageDecision {
  const limit = FOXY_DAILY_MESSAGE_LIMIT[plan];
  const allowed = used < limit;
  return {
    allowed,
    used,
    limit,
    remaining: Math.max(0, limit - used - (allowed ? 1 : 0)),
  };
}

/**
 * The seconds until the counter resets, for a `Retry-After`.
 *
 * A rate-limit response that does not say when to try again invites a client to
 * poll, which turns one blocked student into a load problem.
 */
export function secondsUntilReset(now: Date): number {
  const nextDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(1, Math.ceil((nextDay - now.getTime()) / 1000));
}
