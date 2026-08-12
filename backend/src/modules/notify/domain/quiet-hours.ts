/**
 * Quiet hours — pure, and every instant is passed in.
 *
 * There is no `new Date()` in this file and there must never be one. §2's layer
 * table: a domain function that needs the current time takes it as an argument.
 * That is what makes "a security notification is not suppressed at 02:00"
 * testable without waiting until 02:00.
 *
 * ===========================================================================
 * THE WINDOW IS EXPRESSED IN THE USER'S LOCAL HOURS, NOT IN UTC.
 *
 * The product's users are in one timezone today and the digest is expected to
 * arrive at 09:00 IST (`worker/scheduler.ts` says so, and calls it out as the
 * limit of the current scheduler). "Do not disturb between 21:00 and 07:00" is
 * a statement about the user's evening, so storing it as UTC hours would make
 * it wrong for the first user outside Asia/Kolkata — silently, and only at
 * night.
 *
 * The local hour is derived with `Intl.DateTimeFormat`, which is DST-correct by
 * construction. India observes no DST, so today this is exact rather than
 * merely careful; the care is what makes the first non-IST tenant a
 * configuration change instead of a defect.
 */

/** A window in the recipient's local hours. `[startHour, endHour)`. */
export interface QuietHours {
  /** 0-23. Inclusive. */
  readonly startHour: number;
  /** 0-23. EXCLUSIVE — 07:00 means the window ends as 07:00 begins. */
  readonly endHour: number;
}

/**
 * The search step in `quietHoursEndAt`, and it is FIFTEEN MINUTES rather than
 * an hour for a reason that cost this file a failing test.
 *
 * IST is UTC+5:30. The top of a local hour is therefore NOT the top of a UTC
 * hour, so a search that walked whole UTC hours from a UTC-hour boundary could
 * only ever land on `:00` UTC and would never find 07:00 IST at all — it would
 * silently return the 48-hour bound, and the symptom would be a deferred
 * notification arriving two days late.
 *
 * Fifteen minutes is the coarsest step that divides every IANA offset in use,
 * including the :30 zones (India, Iran) and the :45 ones (Nepal, Chatham).
 */
const STEP_MS = 15 * 60 * 1000;

/**
 * A bound on the search in `quietHoursEndAt`.
 *
 * 48 hours is twice the longest possible answer, so hitting it means the window
 * is unsatisfiable rather than merely distant — a corrupted `endHour`, say.
 * Returning a bounded wrong answer beats looping.
 */
const MAX_SEARCH_HOURS = 48;
const MAX_STEPS = (MAX_SEARCH_HOURS * 60 * 60 * 1000) / STEP_MS;

/**
 * The hour of the day, 0-23, at `at` in `timezone`.
 *
 * `hourCycle: 'h23'` rather than the default, because `hour12: false` alone
 * produces "24" for midnight in some locales — a value that is out of range for
 * every comparison below and would make midnight silently fall outside a window
 * containing it.
 */
export function localHourIn(timezone: string, at: Date): number {
  return localTimeIn(timezone, at).hour;
}

/** The local hour AND minute, which the end-of-window search needs. */
function localTimeIn(
  timezone: string,
  at: Date,
): { readonly hour: number; readonly minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);

  // `formatToParts` rather than parsing the formatted string: the separator
  // between hour and minute is locale data, and a locale that used a different
  // one would turn a correct time into a `NaN` comparison that quietly matches
  // nothing.
  const read = (type: string): number =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);

  return { hour: read('hour'), minute: read('minute') };
}

/**
 * Whether `at` falls inside the window.
 *
 * A window with `startHour === endHour` is DISABLED, not 24 hours long. The
 * alternative reading — "quiet all day" — turns a configuration typo into a
 * product that silently never emails anybody, which is the failure mode this
 * whole module exists to make impossible.
 */
export function isWithinQuietHours(
  at: Date,
  quietHours: QuietHours | null,
  timezone: string,
): boolean {
  if (quietHours === null) return false;
  if (quietHours.startHour === quietHours.endHour) return false;

  const hour = localHourIn(timezone, at);

  // The ordinary case: 13:00 to 15:00, entirely within one local day.
  if (quietHours.startHour < quietHours.endHour) {
    return hour >= quietHours.startHour && hour < quietHours.endHour;
  }

  // The WRAPPING case, which is the one people actually configure: 21:00 to
  // 07:00 spans midnight, so the window is the union of two ranges and NOT the
  // intersection. Getting this backwards yields a window that is never active,
  // and the symptom is "quiet hours do nothing" rather than an error.
  return hour >= quietHours.startHour || hour < quietHours.endHour;
}

/**
 * The instant the window containing `at` ends — the top of the local `endHour`.
 *
 * Walked forward an hour at a time rather than computed arithmetically. The
 * arithmetic version has to reason about the offset between UTC and the target
 * zone, which changes across a DST boundary in exactly the direction that makes
 * a deferred notification arrive an hour early or an hour late; stepping and
 * re-asking `Intl` cannot get that wrong. Forty-eight iterations of a formatter
 * is nothing next to the email it is about to schedule.
 *
 * Callers only reach this while INSIDE the window, so the first candidate is
 * never the current hour.
 */
export function quietHoursEndAt(at: Date, quietHours: QuietHours, timezone: string): Date {
  // Truncating to the step first means the answer carries none of the caller's
  // stray milliseconds into a scheduled `run_at`, and that every deferred
  // delivery for one timezone lands on the same instant.
  const start = Math.floor(at.getTime() / STEP_MS) * STEP_MS;

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const candidate = new Date(start + step * STEP_MS);
    const local = localTimeIn(timezone, candidate);
    if (local.hour === quietHours.endHour && local.minute === 0) {
      return candidate;
    }
  }

  // Unreachable for any `endHour` in 0-23: every hour of the day occurs within
  // any 24-hour span. Returning the bound rather than throwing, because this is
  // a scheduling decision on a delivery path and a bounded-late notification
  // beats an exception that dead-letters it.
  return new Date(start + MAX_STEPS * STEP_MS);
}
