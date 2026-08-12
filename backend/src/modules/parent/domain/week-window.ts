/**
 * The digest week, and the window a snapshot reads.
 *
 * Pure. `now` is always an argument — §9.5 forbids asserting on the current
 * date, and "the digest is idempotent per week" is exactly the property that
 * cannot be tested without moving time.
 *
 * ===========================================================================
 * THIS IS A SECOND IMPLEMENTATION OF NOTIFY'S WEEK, AND THAT IS DELIBERATE.
 *
 * `notify/domain/digest-week.ts` computes the same Monday-in-UTC boundary, and
 * the obvious tidy-up is for `parent` to import it. It must not: a module
 * reaches another module through an INJECTED dependency, never an import
 * (D-051), and `app/routes.ts` is the complete cross-module dependency graph
 * only for as long as that holds. Notify already hands `weekStart` to
 * `buildDigest`, so the injection exists — this file is what the PARENT-facing
 * endpoints use when nobody has handed them a week.
 *
 * Two implementations of one boundary is a drift risk, so it is pinned rather
 * than hoped: `__tests__/week-window.test.ts` asserts these functions agree
 * with notify's across a year of dates. If someone moves either week to Sunday,
 * that test goes red rather than a parent receiving two digests in one week.
 * ===========================================================================
 *
 * MONDAY, IN UTC — the same two reasons notify gives. Monday because the digest
 * reports a school week and a Sunday start splits the weekend across two
 * reports. UTC because a key derived from local time changes meaning when the
 * server's region does.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many days one digest week covers. */
export const DAYS_PER_WEEK = 7;

/**
 * Midnight UTC on the Monday of the week containing `at`.
 *
 * `getUTCDay()` returns 0 for Sunday, so Sunday is 6 days AFTER its Monday
 * rather than 1 day before the next one. Getting that wrong moves every Sunday
 * into the following week and makes one week cover eight days and the next six.
 */
export function weekStartOf(at: Date): Date {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const daysSinceMonday = (at.getUTCDay() + 6) % 7;
  return new Date(midnight - daysSinceMonday * DAY_MS);
}

/** `YYYY-MM-DD` of the week's Monday. The key `weekly_digests` is unique on. */
export function weekKeyOf(at: Date): string {
  return weekStartOf(at).toISOString().slice(0, 10);
}

/** The Monday before this one. Used for the snapshot's one trend. */
export function previousWeekStart(weekStart: Date): Date {
  return new Date(weekStart.getTime() - DAYS_PER_WEEK * DAY_MS);
}

/**
 * The half-open window `[from, to)` a week covers.
 *
 * HALF-OPEN, and it matters: a closed upper bound at `to` would count a session
 * submitted at exactly next Monday 00:00:00.000Z in both weeks, so the two
 * weeks' totals would not sum to the fortnight's.
 */
export interface WeekWindow {
  readonly from: Date;
  /** Exclusive. */
  readonly to: Date;
}

export function weekWindowOf(weekStart: Date): WeekWindow {
  const from = weekStartOf(weekStart);
  return { from, to: new Date(from.getTime() + DAYS_PER_WEEK * DAY_MS) };
}
