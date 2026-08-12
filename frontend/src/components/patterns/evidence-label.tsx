import { Badge, type BadgeTone } from '@/components/ui/badge';
import type { LearningEvidence } from '@/types/learning-evidence';

/**
 * ===========================================================================
 * THE FOUR EVIDENCE LABELS — plan §9.1, a CLIENT CONSTRAINT rather than a
 * design preference.
 *
 * "The client requires exactly four — Strong evidence, Developing, Needs
 * another session, Not assessed yet — and FORBIDS showing mastery percentages.
 * The union lives in `shared/contracts/`, so the frontend cannot invent a fifth
 * label and cannot render a number."
 *
 * This component is where that constraint becomes unavoidable rather than
 * remembered. It takes the union and nothing else: there is no `value` prop, no
 * `percentage`, no `children` — so a screen physically cannot pass 0.72 through
 * it, and a fifth label is a type error.
 *
 * ---------------------------------------------------------------------------
 * THE TONES CARRY NO FAILURE.
 *
 * "Needs another session" is `info`, never `danger`. §9.1 spells out why for
 * the incorrect-answer state — no harsh red — and the same reasoning governs
 * every judgement a child or their parent reads about their learning. Red says
 * "you failed"; the sentence says "do this again", which is the actual meaning.
 * ===========================================================================
 */

const tones: Readonly<Record<LearningEvidence, BadgeTone>> = {
  'Strong evidence': 'success',
  Developing: 'brand',
  'Needs another session': 'info',
  'Not assessed yet': 'neutral',
};

export interface EvidenceLabelProps {
  readonly evidence: LearningEvidence;
  readonly className?: string;
}

export function EvidenceLabel({ className, evidence }: EvidenceLabelProps) {
  return (
    <Badge className={className} tone={tones[evidence]}>
      {evidence}
    </Badge>
  );
}
