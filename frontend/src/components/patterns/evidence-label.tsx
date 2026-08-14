'use client';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import type { EvidenceLabel as EvidenceCode } from '@/lib/api/generated/constants/practice';
import { useT } from '@/lib/i18n/i18n-provider';
import type { TranslationKey } from '@/lib/i18n/translate';

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
 * IT TAKES THE WIRE CODE NOW, NOT AN ENGLISH SENTENCE — 14 August 2026.
 *
 * It used to take `LearningEvidence`, a hand-written union of English strings
 * in `src/types/`, and render it directly. Two things were wrong with that and
 * the second one shipped:
 *
 *   §12 forbids "a hand-written type for data the backend already defines", and
 *   `EVIDENCE_LABELS` is generated from the same constant the database CHECK is
 *   built from. Two vocabularies for one closed set is one drift away from a
 *   screen that cannot render a label the server sends.
 *
 *   AND THE LABEL WAS NEVER TRANSLATED. The English sentence WAS the value, so
 *   a Hindi reader saw "Strong evidence" on their child's progress — on the one
 *   screen §8 cares most about, and invisible to anyone working in English.
 *
 * The code comes from the wire; the words come from the dictionary; the mapping
 * is the table below and a missing entry is a type error.
 *
 * ---------------------------------------------------------------------------
 * THE TONES CARRY NO FAILURE.
 *
 * `needs_another_session` is `info`, never `danger`. §9.1 spells out why for
 * the incorrect-answer state — no harsh red — and the same reasoning governs
 * every judgement a child or their parent reads about their learning. Red says
 * "you failed"; the sentence says "do this again", which is the actual meaning.
 * ===========================================================================
 */

const tones: Readonly<Record<EvidenceCode, BadgeTone>> = {
  strong: 'success',
  developing: 'brand',
  needs_another_session: 'info',
  not_assessed: 'neutral',
};

const labelKeys: Readonly<Record<EvidenceCode, TranslationKey>> = {
  strong: 'evidence.strong',
  developing: 'evidence.developing',
  needs_another_session: 'evidence.needsAnotherSession',
  not_assessed: 'evidence.notAssessed',
};

export interface EvidenceLabelProps {
  readonly evidence: EvidenceCode;
  readonly className?: string;
}

export function EvidenceLabel({ className, evidence }: EvidenceLabelProps) {
  const t = useT();

  return (
    <Badge className={className} tone={tones[evidence]}>
      {t(labelKeys[evidence])}
    </Badge>
  );
}
