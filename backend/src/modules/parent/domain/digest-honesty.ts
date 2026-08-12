import type { BilingualText } from '@/platform/notify-channel/index';
import { DIGEST_LINE_COUNT, type DigestDraft } from './digest-content';
import type { DigestEvidence } from './digest-evidence';

/**
 * THE HONESTY GATE — every digest passes through this before it is stored or
 * sent, whoever wrote it.
 *
 * ===========================================================================
 * THIS IS NOT "THE LLM CHECK", AND CALLING IT THAT IS HOW IT GETS REMOVED.
 *
 * `composeDigest` is deterministic and passes this gate by construction today.
 * The temptation, therefore, is to run the gate only on model output — "our own
 * composer cannot produce a percentage". It can, the moment somebody adds a
 * helpful "(4 out of 6 correct)" to a line, and that edit will look like an
 * improvement in review.
 *
 * So the gate runs on EVERY draft from EVERY writer. It is what makes the
 * `DigestWriter` port safe to swap: whatever lands behind it — a real model, a
 * template, a vendor — cannot put a percentage or an invented misconception in
 * front of a parent, because the service refuses to store the draft at all.
 * ===========================================================================
 *
 * Pure: it returns the violations it found rather than throwing, so it can be
 * exhaustively unit tested with no error hierarchy, and the SERVICE decides
 * what a violation means (it is an `InternalError` — a dishonest draft is a
 * defect in this system, never something the parent did).
 */

/** The rules a draft can break. Stable strings — tests and logs both use them. */
export const DIGEST_VIOLATIONS = {
  LINE_COUNT: 'line_count',
  EMPTY_LINE: 'empty_line',
  MISSING_HINDI: 'missing_hindi',
  PERCENTAGE: 'percentage',
  JARGON: 'jargon',
  INVENTED_MISCONCEPTION: 'invented_misconception',
  MISSING_ACTION: 'missing_action',
} as const;

export type DigestViolation = (typeof DIGEST_VIOLATIONS)[keyof typeof DIGEST_VIOLATIONS];

/**
 * Anything that reads as a score.
 *
 * `%`, the word in either language, and the "N out of M" / "N/M" forms that are
 * a percentage with the division left to the reader. Bare digits are allowed —
 * "practised on 3 days" and "answered 24 questions" are counts, which is the
 * whole point of §8.7's distinction.
 */
const PERCENTAGE_PATTERNS: readonly RegExp[] = [
  /\d\s*%/,
  /per\s?cent/i,
  /प्रतिशत/,
  /\b\d+\s*(?:out of|\/)\s*\d+\b/i,
  /\bscored?\b/i,
  /\bmarks\b/i,
  /\bअंक\b/,
];

/**
 * Words a parent did not ask for.
 *
 * Each of these is a real term used correctly elsewhere in this codebase — and
 * every one of them turns a sentence a parent can act on into a sentence they
 * have to decode. `mastery` is the one most likely to leak, because it is the
 * column name.
 */
const JARGON_PATTERNS: readonly RegExp[] = [
  /\bmastery\b/i,
  /\bIRT\b/,
  /\bBloom'?s?\b/i,
  /\btheta\b/i,
  /\bease factor\b/i,
  /\bpercentile\b/i,
  /\bspaced retention\b/i,
  /\bcognitive\b/i,
];

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function texts(draft: DigestDraft): readonly BilingualText[] {
  return [...draft.lines, draft.suggestedAction];
}

/**
 * Checks a draft against the evidence it claims to describe.
 *
 * Returns every violation found rather than the first — a writer that broke
 * three rules should be reported as having broken three, or fixing them is
 * three round trips.
 */
export function checkDigestHonesty(
  draft: DigestDraft,
  evidence: DigestEvidence,
): readonly DigestViolation[] {
  const violations = new Set<DigestViolation>();

  if (draft.lines.length !== DIGEST_LINE_COUNT) {
    violations.add(DIGEST_VIOLATIONS.LINE_COUNT);
  }

  for (const text of texts(draft)) {
    if (isBlank(text.en)) violations.add(DIGEST_VIOLATIONS.EMPTY_LINE);
    // P7 is a required property at the type level; this catches the value that
    // satisfied the type and is an empty string — which is what a translation
    // step that was skipped actually looks like at runtime.
    if (isBlank(text.hi)) violations.add(DIGEST_VIOLATIONS.MISSING_HINDI);

    for (const candidate of [text.en, text.hi]) {
      if (PERCENTAGE_PATTERNS.some((pattern) => pattern.test(candidate))) {
        violations.add(DIGEST_VIOLATIONS.PERCENTAGE);
      }
      if (JARGON_PATTERNS.some((pattern) => pattern.test(candidate))) {
        violations.add(DIGEST_VIOLATIONS.JARGON);
      }
    }
  }

  if (isBlank(draft.suggestedAction.en) || isBlank(draft.suggestedAction.hi)) {
    violations.add(DIGEST_VIOLATIONS.MISSING_ACTION);
  }

  /**
   * THE RULE THAT MATTERS MOST — a misconception must have been OBSERVED.
   *
   * Not "plausible for this chapter", not "common at this grade". The code has
   * to appear in the evidence assembled from `practice_responses`, or the draft
   * is refused. With `distractor_misconceptions` NULL corpus-wide (D-077), the
   * evidence list is empty on essentially every real week — so this rule is
   * what stands between that gap and a confidently-worded diagnosis of a child
   * who was never diagnosed.
   */
  if (draft.misconceptionCode !== null) {
    const observed = evidence.misconceptions.some(
      (sighting) => sighting.code === draft.misconceptionCode,
    );
    if (!observed) violations.add(DIGEST_VIOLATIONS.INVENTED_MISCONCEPTION);
  }

  return [...violations];
}
