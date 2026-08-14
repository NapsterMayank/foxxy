'use client';

import Link from 'next/link';
import { EvidenceLabel } from '@/components/patterns/evidence-label';
import type { SubmissionResult } from '@/lib/api/generated/contracts/practice.contract';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';
import { formatDayAndMonth } from '@/lib/utils/format-date';
import { invalidReasonMessage } from '../lib/practice-messages';

/**
 * ===========================================================================
 * THE RESULT — §10.4: "the result shows score and XP · an invalid attempt
 * shows its reason".
 *
 * ---------------------------------------------------------------------------
 * "4 OF 6", NEVER "67%". `SubmissionResult` carries `scorePercent` and this
 * component deliberately does not read it. A session score and a mastery
 * percentage are indistinguishable to a child — both are a number out of a
 * hundred describing them — and §9.1 forbids the second. Four correct out of
 * six is a fact about six questions and cannot be mistaken for a verdict.
 *
 * ---------------------------------------------------------------------------
 * BOTH XP NUMBERS ARE SHOWN WHEN THEY DIFFER.
 *
 * `xpAwarded` is what reached the ledger and `xpEarned` is what the session was
 * worth before the daily cap — two fields precisely so the interface can say
 * "20 of it was withheld" rather than silently printing a smaller number than
 * the arithmetic on screen produces (D-283). Showing only the awarded figure is
 * how a student concludes the app miscounted.
 * ===========================================================================
 */

export interface SessionSummaryProps {
  readonly result: SubmissionResult;
}

export function SessionSummary({ result }: SessionSummaryProps) {
  const t = useT();
  const { language } = useLanguage();
  const withheld = result.xpEarned - result.xpAwarded;

  return (
    <section
      aria-labelledby="practice-summary-title"
      className="rounded-card border border-line bg-surface p-4 shadow-raised sm:p-6"
    >
      <h2 className="text-2xl font-extrabold tracking-tight text-ink" id="practice-summary-title">
        {t('practice.summaryTitle')}
      </h2>

      <p className="mt-3 text-lg font-bold text-ink">
        {t('practice.summaryScore', {
          correct: result.correctCount,
          total: result.questionCount,
        })}
      </p>
      <p className="mt-1 text-base text-brand-strong">
        {t('practice.summaryXp', { xp: result.xpAwarded })}
      </p>
      {result.dailyCapReached && withheld > 0 ? (
        <p className="mt-1 text-sm text-muted">{t('practice.summaryXpWithheld', { withheld })}</p>
      ) : null}

      {/*
        THE INVALID NOTICE IS `status` AND NOT `alert`, and it is worded as
        withheld XP rather than as an accusation. The backend's reason CODE is
        never rendered — see `invalidReasonMessage`.
      */}
      {result.isValid ? null : (
        <div className="mt-6 rounded-card border border-warning bg-warning/10 p-4" role="status">
          <p className="text-base font-bold text-ink">{t('practice.invalidTitle')}</p>
          <p className="mt-1 text-sm leading-body text-ink">
            {invalidReasonMessage(result.invalidReason, t)}
          </p>
        </div>
      )}

      <div className="mt-6">
        <p className="text-xs font-bold uppercase tracking-widest text-muted">
          {t('practice.summaryEvidenceTitle')}
        </p>
        <EvidenceLabel className="mt-2" evidence={result.evidence} />
      </div>

      <p className="mt-6 text-sm text-muted">
        {t('practice.summaryNextReview', { date: formatDayAndMonth(result.nextReviewAt, language) })}
      </p>

      <Link
        className="mt-6 inline-flex min-h-control items-center justify-center rounded-full bg-brand px-6 py-3 text-sm font-semibold text-brand-fg shadow-raised transition-surface duration-micro hover:bg-brand-strong focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25"
        href="/student"
      >
        {t('practice.summaryDoneAction')}
      </Link>
    </section>
  );
}
