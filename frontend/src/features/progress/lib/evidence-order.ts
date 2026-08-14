import {
  EVIDENCE_LABELS,
  type EvidenceLabel as EvidenceCode,
} from '@/lib/api/generated/constants/practice';

/**
 * ===========================================================================
 * THE FOUR LABELS, WEAKEST FIRST — for the step bar, and nothing else.
 *
 * `EVIDENCE_LABELS` is generated and its order is the DECLARATION order of a
 * closed set (`strong` first), which is not an ordering of strength. A step bar
 * built straight from it fills backwards: "Not assessed yet" would light every
 * segment and "Strong evidence" would light one.
 *
 * So the rank is stated here, once, and asserted to cover the generated union —
 * a fifth label added upstream fails `typecheck` at `Record<EvidenceCode, …>`
 * rather than rendering as rank zero.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A RANK, NOT A SCORE, AND THE DIFFERENCE IS THE POINT.
 *
 * §9.1 forbids mastery percentages. Four filled segments out of four is a
 * position in a named sequence a student can read back — "Developing" — where
 * 63% is a number nobody can act on and that invites comparison with a sibling.
 * The bar is `aria-hidden` for the same reason: the LABEL is the information,
 * and a screen reader should hear the word, not "graphic, four of four".
 * ===========================================================================
 */
const rank: Readonly<Record<EvidenceCode, number>> = {
  not_assessed: 0,
  needs_another_session: 1,
  developing: 2,
  strong: 3,
};

/** Weakest to strongest. The step bar renders one segment per entry. */
export const EVIDENCE_ASCENDING: readonly EvidenceCode[] = [...EVIDENCE_LABELS].sort(
  (left, right) => rank[left] - rank[right],
);

export function evidenceRank(evidence: EvidenceCode): number {
  return rank[evidence];
}
