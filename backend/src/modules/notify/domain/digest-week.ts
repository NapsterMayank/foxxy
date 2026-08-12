/**
 * The weekly digest's week, and the keys derived from it.
 *
 * Pure. `now` is always an argument — §9.5 forbids asserting on the current
 * date, and "the scheduler is idempotent per parent per week" is exactly the
 * property that cannot be tested without moving time.
 *
 * ===========================================================================
 * THE WEEK KEY IS THE ENTIRE IDEMPOTENCE MECHANISM.
 *
 * `platform/jobs` makes `(kind, idempotency_key)` UNIQUE and enqueues with
 * `ON CONFLICT DO NOTHING`, and its header is explicit: "THE KEY MUST BE
 * DERIVED FROM WHAT MAKES THE WORK UNIQUE ... NEVER a timestamp and never a
 * random value: either makes every enqueue a new row and silently removes the
 * only protection this design offers."
 *
 * For a weekly digest the work is uniquely identified by (parent, week). So the
 * key is exactly that, and running the scan ten times on Monday — ten replicas,
 * a restart, a manual re-run — enqueues one digest per parent. There is no
 * "have I already sent this" query anywhere, because the unique index IS the
 * query.
 *
 * ===========================================================================
 * WEEKS START ON MONDAY, IN UTC, AND BOTH HALVES OF THAT ARE DELIBERATE.
 *
 * MONDAY because the digest reports a school week and a Sunday-start week
 * splits the weekend across two reports.
 *
 * UTC because a key derived from local time changes meaning when the server's
 * region does — "the digest went out twice the week we moved region" is a bug
 * nobody would connect to a key format. The same reasoning, and the same
 * decision, as `worker/scheduler.ts`'s `utcDateKey`.
 *
 * The 09:00 Asia/Kolkata DELIVERY time is a different question, handled by
 * quiet hours and by the job's `run_at`, not by the key.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Midnight UTC on the Monday of the week containing `at`.
 *
 * `getUTCDay()` returns 0 for Sunday, so Sunday is 6 days after its Monday
 * rather than 1 day before the next one. Getting that wrong moves every Sunday
 * into the following week and makes one week's digest cover eight days and the
 * next one six.
 */
export function weekStartOf(at: Date): Date {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const dayOfWeek = at.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  return new Date(midnight - daysSinceMonday * DAY_MS);
}

/** `YYYY-MM-DD` of the week's Monday. The stable half of every digest key. */
export function weekKey(at: Date): string {
  return weekStartOf(at).toISOString().slice(0, 10);
}

/** The scan job's key: one scan per week, however many workers are running. */
export function digestScanKey(kind: string, at: Date): string {
  return `${kind}:${weekKey(at)}`;
}

/** One delivery per parent per week. THE test for the digest scheduler. */
export function digestJobKey(parentUserId: string, at: Date): string {
  return `${parentUserId}:${weekKey(at)}`;
}

/**
 * The frequency-cap counter key: one counter per (user, kind, UTC day).
 *
 * UTC rather than local, matching every other key in the system. A cap that
 * resets at local midnight would reset at a different instant for each user and
 * make the counter unshardable for no benefit anybody can perceive.
 */
export function frequencyCapKey(userId: string, kind: string, at: Date): string {
  return `notify:cap:${userId}:${kind}:${at.toISOString().slice(0, 10)}`;
}

/**
 * How long a cap counter lives. 26 hours — comfortably past the end of any UTC
 * day it was created in, and short enough that the cache never accumulates.
 *
 * A cap counter is the one thing in this module that may be lost without
 * consequence: losing it lets one extra notification through, which is a far
 * better failure than the alternative D-012 rules out (nothing whose loss
 * changes what a user is ALLOWED to do may live in a cache).
 */
export const FREQUENCY_CAP_TTL_SECONDS = 26 * 60 * 60;
