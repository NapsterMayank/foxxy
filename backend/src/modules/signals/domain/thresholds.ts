/**
 * ANOMALY THRESHOLDS — every number this module reasons with, named, with the
 * argument for its value written next to it.
 *
 * ===========================================================================
 * WHY THEY ARE ALL IN ONE FILE.
 *
 * A threshold inlined at its use site is a magic number, and a magic number is
 * an unreviewable product decision: nobody can tell whether `>= 7` was chosen or
 * typed. Collected here they can be read in one sitting by somebody who does not
 * write TypeScript, which is the only review that matters for a number that
 * decides whether a teacher is told a child is struggling.
 *
 * ===========================================================================
 * THESE ARE STARTING POSITIONS, NOT MEASUREMENTS, AND THEY SAY SO.
 *
 * No student has used this system yet, so not one of these numbers has been
 * validated against a false-positive rate. Each carries the reasoning that
 * produced it and the observation that would change it. When usage data exists,
 * a changed threshold is a NEW RULE VERSION (`platform/rules`), never an edit —
 * which is precisely what keeps last month's escalations explainable by the
 * numbers that actually caused them.
 *
 * The one number NOT defined here is the anti-cheat floor. It belongs to
 * `practice`, it is already authored and tested there, and it arrives through an
 * injected edge. Copying it would create two floors that drift, and the drift
 * would be silent — see `domain/anomaly-rules.ts`.
 */

/**
 * Days without a submitted session before inactivity is signalled.
 *
 * SEVEN, because the unit of a school routine is a week. A shorter window fires
 * on an ordinary weekend, on a school holiday and on every festival — and a
 * signal that fires on normal behaviour is one that gets muted, taking the real
 * signals with it. Seven days means a student has missed a full cycle of their
 * own habit, which is the first moment the fact is worth anyone's attention.
 *
 * Revisit when: the false-positive rate over a term is known, or the product
 * gains a notion of holidays it can subtract.
 */
export const INACTIVITY_DAYS = 7;

/**
 * Percentage points a chapter's score must FALL across two consecutive sessions
 * before it counts as a mastery drop.
 *
 * FIFTEEN, because of arithmetic rather than pedagogy: a practice set is around
 * ten questions, so ONE question is worth about ten points. A threshold at or
 * below ten would fire whenever a student got one more question wrong than last
 * time, which is noise and not a drop. Fifteen requires the equivalent of two
 * questions, which cannot be explained by a single careless answer.
 *
 * Revisit when: the real distribution of session-to-session score change is
 * known. If sets stop being ten questions, this number is wrong immediately.
 */
export const MASTERY_DROP_MIN_PERCENTAGE_POINTS = 15;

/**
 * Average milliseconds per question below which a VALID attempt is nonetheless
 * unusually fast.
 *
 * SIX SECONDS = twice `practice`'s anti-cheat floor of three, and the
 * relationship is the definition: below three seconds the attempt is already
 * REJECTED and scored zero, so this signal would be reporting something the
 * system has acted on. Between three and six seconds the attempt is accepted,
 * scored and counted toward mastery while being faster than a CBSE
 * multiple-choice question can be read — which is exactly the case nothing else
 * looks at.
 *
 * IT IS NOT AN ACCUSATION. It is as consistent with a student re-doing a set
 * they have memorised as with one tapping through, and the reason string says
 * only what was measured.
 *
 * Revisit when: real completion-time distributions exist. This number is
 * DERIVED from the anti-cheat floor — see `FAST_COMPLETION_FLOOR_MULTIPLE`.
 */
export const FAST_COMPLETION_FLOOR_MULTIPLE = 2;

/**
 * Score at or below which a session counts as a failed attempt at its chapter.
 *
 * FORTY PERCENT, matching the ordinary CBSE pass mark of 33% with a margin. A
 * student sitting exactly on the pass mark is not the one this is looking for;
 * the target is repeated, clear non-comprehension.
 */
export const STRUGGLE_SCORE_PERCENT = 40;

/**
 * Failed sessions on the SAME chapter before repeated struggle is signalled.
 *
 * THREE, and this is the client's teacher-escalation trigger, so it is the
 * highest-consequence number in the file. Two is a bad day followed by another
 * bad day. Three is a pattern the student cannot break alone, which is the
 * moment a human should be told — and it is still small enough to fire while the
 * chapter is being taught rather than after the unit has moved on.
 *
 * Revisit when: teachers report the escalation volume is unmanageable, or that
 * it arrives too late. Both are changes to THIS number and both are new versions.
 */
export const REPEATED_STRUGGLE_SESSIONS = 3;

/** Milliseconds in a day, so no rule has to spell out `24 * 60 * 60 * 1000`. */
export const MS_PER_DAY = 86_400_000;
