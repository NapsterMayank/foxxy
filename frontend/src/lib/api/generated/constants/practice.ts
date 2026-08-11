/**
 * GENERATED — DO NOT EDIT.
 *
 * Source of truth: backend/src/shared/. Regenerate with
 * `npm run contracts:sync` from `frontend/`. `contracts-drift.test.ts`
 * fails when this file and its backend original disagree.
 */

/**
 * The practice vocabulary — the closed sets the database schema, the domain
 * functions and the wire contract all have to agree on.
 *
 * They live here for the same reason `curriculum.ts` does: a module cannot
 * import `platform/db` at all (ESLint `no-restricted-imports`, plan §7.4), so a
 * constant declared beside the tables is a constant every module has to
 * re-declare — and a re-declared closed set drifts from the CHECK constraint
 * enforcing it.
 *
 * NOTHING NUMERIC ABOUT XP OR SCORING IS ALLOWED IN THIS FILE. Every XP value
 * lives in `modules/practice/domain/xp-rules.ts` and nowhere else (§8.6). These
 * are vocabularies, not economics.
 */

/**
 * The confidence a student reported BEFORE answering.
 *
 * A CHECKed closed set, unlike `explanation_format_used`, because remediation
 * BRANCHES on it: confident-and-wrong is a misconception, unsure-and-right is a
 * guess, and they are identical in `is_correct` while calling for opposite
 * interventions. An unexpected value here would cost a wrong decision rather
 * than a report line.
 */
export const RESPONSE_CONFIDENCES = ['unsure', 'unsure_ish', 'confident'] as const;
export type ResponseConfidence = (typeof RESPONSE_CONFIDENCES)[number];

/**
 * THE HINT LADDER — the client's five levels, in order.
 *
 * Level 0 is "no hint asked for" and is not in this list; it is the absence of a
 * rung. `hint_level_used` counts rungs consumed, so 0 is a real observation.
 *
 * ===========================================================================
 * FOUR OF THE FIVE HAVE NO DATA BEHIND THEM TODAY — D-077, and this is measured
 * rather than feared. Across all 3,791 source questions, `hint_level_1`,
 * `hint_level_2`, `hint_level_3` and `solution_steps` are NULL, and
 * `distractor_misconceptions` is NULL on all 2,741 that were imported.
 *
 * So the ladder DEGRADES. `resolveHint` in `domain/hint-ladder.ts` serves the
 * rungs that have content and says plainly when a rung is unavailable. It never
 * invents a hint and it never reveals the answer — a fabricated hint is worse
 * than no hint, because a student cannot tell it apart from a real one.
 * ===========================================================================
 */
export const HINT_LEVELS = [
  /** Level 1 — "look at the units" — points at the approach, not the step. */
  'directional',
  /** Level 2 — restates the part of the question that carries the constraint. */
  'highlight',
  /** Level 3 — the first step worked, the rest left. */
  'partial_step',
  /** Level 4 — a fully worked ANALOGOUS example, never this question's answer. */
  'worked_example',
  /** Level 5 — give up on this question and go back to the prerequisite. */
  'prerequisite',
] as const;
export type HintLevelName = (typeof HINT_LEVELS)[number];

/** The highest rung. A request above it is clamped, never an error. */
export const MAX_HINT_LEVEL = HINT_LEVELS.length;

/**
 * The evidence label a mastery check reports — §8.6, and the client's Screen 8.
 *
 * FOUR WORDS, NEVER A PERCENTAGE. "She is confusing mass with weight" is useful
 * to a parent; "60 percent in Science" is not (plan §8.7). A percentage also
 * implies a precision that a six-question sample does not have, and the whole
 * point of `not_assessed` is to be able to say so rather than to round a
 * guess.
 */
export const EVIDENCE_LABELS = [
  'strong',
  'developing',
  'needs_another_session',
  'not_assessed',
] as const;
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

/**
 * NO `isEvidenceLabel` / `isResponseConfidence` TYPE GUARDS HERE, deliberately.
 *
 * Both were written and both were deleted: nothing needed them. Every value of
 * either union enters through a Zod schema in `shared/contracts/`, which is
 * where a runtime check belongs, and a second narrowing helper beside the
 * constant is a second place the membership rule is expressed. It would be
 * untested (nothing calls it), it would drift, and the first caller to reach
 * for it instead of the schema would skip the schema's error message.
 */

/**
 * The branch the session engine takes after an answer — the client's Screen 7.
 *
 * `advance`                correct, confident, consistent: go forward.
 * `confirm`               correct but unsure: one confirmation question.
 * `remediate_misconception` wrong, and the chosen distractor carries a known
 *                          misconception code: targeted remediation.
 * `remediate_general`     wrong, with no code available — which is the common
 *                          case today (D-077) and must not masquerade as the
 *                          diagnosed one.
 * `flag_for_recovery`     repeated difficulty on the same chapter.
 */
export const NEXT_DECISIONS = [
  'advance',
  'confirm',
  'remediate_misconception',
  'remediate_general',
  'flag_for_recovery',
] as const;
export type NextDecision = (typeof NEXT_DECISIONS)[number];

/**
 * Why Today's Mission chose what it chose.
 *
 * THE REASON IS THE FEATURE. §8.6 of this build and the client's most important
 * screen: a mission with a generic message is a mission the student has no
 * reason to trust. Each of these is derived from a row that exists —
 * `practice_retention.due_at`, `chapter_mastery.mastery_score`, or the absence
 * of any mastery row for the next chapter in the syllabus.
 */
export const MISSION_REASONS = [
  'due_review',
  'weak_chapter',
  'next_in_syllabus',
  'nothing_available',
] as const;
export type MissionReason = (typeof MISSION_REASONS)[number];

/** What a `xp_ledger.source` may say. One value today. */
export const XP_SOURCES = ['practice_session'] as const;
export type XpSource = (typeof XP_SOURCES)[number];
