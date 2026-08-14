'use client';

import { EvidenceLabel } from '@/components/patterns/evidence-label';
import { Button } from '@/components/ui/button';
import type { Mission } from '@/lib/api/generated/contracts/practice.contract';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';

/**
 * ===========================================================================
 * TODAY'S MISSION — the chapter chosen for this student, and WHY.
 *
 * ---------------------------------------------------------------------------
 * THE REASON SENTENCE COMES FROM THE SERVER, BOTH LANGUAGES, AND IS NOT
 * ASSEMBLED HERE.
 *
 * `reasonEn` and `reasonHi` are `min(1)` on the contract — required, not
 * optional — and the contract says why: `notify` learned the cost of an
 * optional Hindi field, which is a Hindi field that is empty in production. The
 * sentences are derived from this student's own rows ("you last practised this
 * three weeks ago"), so a local template keyed on `reason` would replace a
 * specific true sentence with a generic one.
 *
 * `reason` — the enum — is therefore NOT rendered. It is on the wire so a
 * client can branch on it, and this screen has no reason to.
 * ===========================================================================
 */

export interface MissionCardProps {
  readonly mission: Mission;
  readonly onStart: () => void;
  readonly isPending: boolean;
}

export function MissionCard({ isPending, mission, onStart }: MissionCardProps) {
  const t = useT();
  const { language } = useLanguage();

  /*
   * `chapterTitleHi` is NULLABLE where `reasonHi` is not, so this falls back to
   * English rather than rendering an empty heading. A chapter title is NCERT's
   * own wording; §8's "never translate subject names as the syllabus writes
   * them" is the same argument one level down.
   */
  const title =
    language === 'hi' && mission.chapterTitleHi !== null
      ? mission.chapterTitleHi
      : mission.chapterTitleEn;

  return (
    <section
      aria-labelledby="mission-title"
      className="rounded-card border border-line bg-surface p-4 shadow-raised sm:p-6"
    >
      <p className="text-xs font-bold uppercase tracking-widest text-brand">
        {t('practice.missionEyebrow')}
      </p>
      <h2 className="mt-2 text-xl font-extrabold tracking-tight text-ink" id="mission-title">
        {title}
      </h2>
      <p className="mt-2 text-base leading-body text-muted">
        {language === 'hi' ? mission.reasonHi : mission.reasonEn}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <EvidenceLabel evidence={mission.evidence} />
        <span className="text-sm text-muted">
          {t('practice.missionQuestionCount', { count: mission.suggestedQuestionCount })}
        </span>
      </div>

      <Button className="mt-6" disabled={isPending} onClick={onStart}>
        {t('practice.startAction')}
      </Button>
    </section>
  );
}
