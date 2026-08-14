/**
 * ===========================================================================
 * PER-QUESTION TIMING — plan §10.4, "the timer records per question".
 *
 * A pure function over two timestamps, so the rule it enforces can be tested
 * without a clock, a component or a fake timer.
 *
 * ---------------------------------------------------------------------------
 * THE CLAMP IS NOT DEFENSIVE TIDINESS. IT IS THE CONTRACT'S RANGE.
 *
 * `timeSpentMs` is `min(0).max(60 * 60 * 1000)`. Two ordinary things break that
 * range and neither is a bug in this file:
 *
 *   a student leaves the tab open over lunch  →  hours, and a 400 on submit
 *   the device clock steps backwards (NTP, a  →  a NEGATIVE elapsed, and a 400
 *   timezone change, a manual correction)         on a question answered fine
 *
 * A 400 here is the worst possible outcome: the answer is lost, and the reason
 * is a number the student never saw and cannot influence. So the value is
 * clamped into the range the contract accepts and sent.
 *
 * THAT IS SAFE BECAUSE THE SERVER DOES NOT TRUST THIS NUMBER ANYWAY. The
 * contract says so in as many words — a client can lie — and `submitSession`
 * computes `now - practice_sessions.started_at` from its own injected clock and
 * CLAMPS the claimed total to it before averaging. Sending an hour where a
 * student idled for three cannot buy a pass; the wall clock still bounds it.
 * ===========================================================================
 */

/** The contract's own ceiling, restated so the clamp cannot drift from it. */
export const MAX_TIME_SPENT_MS = 60 * 60 * 1000;

export function elapsedMsBetween(startedAtMs: number, answeredAtMs: number): number {
  const raw = answeredAtMs - startedAtMs;
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(Math.round(raw), MAX_TIME_SPENT_MS);
}
