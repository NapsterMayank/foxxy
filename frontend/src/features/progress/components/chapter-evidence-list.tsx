'use client';

import { EvidenceLabel } from '@/components/patterns/evidence-label';
import type { ChapterProgress } from '@/lib/api/generated/contracts/practice.contract';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';
import { formatDayAndMonth } from '@/lib/utils/format-date';
import { EVIDENCE_ASCENDING, evidenceRank } from '../lib/evidence-order';

/**
 * ===========================================================================
 * CHAPTER BY CHAPTER — §10.4, "mastery bars reflect the data".
 *
 * The bar is a RANK IN A NAMED SEQUENCE, not a score. Four segments, one per
 * evidence label, filled to this chapter's position — and `aria-hidden`,
 * because the LABEL beside it is the information and a screen reader should
 * hear the word rather than "graphic, three of four". §9.1 forbids the
 * percentage that a filled bar is otherwise one refactor away from becoming.
 *
 * Purely presentational: it takes an array and renders it.
 * ===========================================================================
 */

export interface ChapterEvidenceListProps {
  readonly chapters: readonly ChapterProgress[];
}

export function ChapterEvidenceList({ chapters }: ChapterEvidenceListProps) {
  const t = useT();
  const { language } = useLanguage();

  return (
    <section aria-labelledby="progress-chapters-title">
      <h2
        className="text-xs font-bold uppercase tracking-widest text-muted"
        id="progress-chapters-title"
      >
        {t('progressScreen.chaptersTitle')}
      </h2>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {chapters.map((chapter) => (
          <article
            className="rounded-card border border-line bg-surface p-4"
            data-evidence={chapter.evidence}
            key={chapter.chapterId}
          >
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-bold text-ink">
                {language === 'hi' && chapter.chapterTitleHi !== null
                  ? chapter.chapterTitleHi
                  : chapter.chapterTitleEn}
              </h3>
              <EvidenceLabel evidence={chapter.evidence} />
            </div>

            <div aria-hidden="true" className="mt-4 flex gap-2">
              {EVIDENCE_ASCENDING.map((step, index) => (
                <span
                  className={
                    index <= evidenceRank(chapter.evidence)
                      ? 'h-2 flex-1 rounded-full bg-brand'
                      : 'h-2 flex-1 rounded-full bg-line'
                  }
                  key={step}
                />
              ))}
            </div>

            <p className="mt-3 text-sm text-muted">
              {t('progressScreen.attemptsLabel', { count: chapter.attempts })}
              {' · '}
              {chapter.lastPractisedAt === null
                ? t('progressScreen.neverPractisedLabel')
                : t('progressScreen.lastPractisedLabel', {
                    date: formatDayAndMonth(chapter.lastPractisedAt, language),
                  })}
            </p>

            {chapter.nextReviewAt === null ? null : (
              <p className="mt-1 text-sm text-brand-strong">
                {t('progressScreen.nextReviewLabel', {
                  date: formatDayAndMonth(chapter.nextReviewAt, language),
                })}
              </p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
