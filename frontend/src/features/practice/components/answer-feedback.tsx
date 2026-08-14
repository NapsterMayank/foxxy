'use client';

import { Button } from '@/components/ui/button';
import type { AnswerResult } from '@/lib/api/generated/contracts/practice.contract';
import { useT } from '@/lib/i18n/i18n-provider';
import { cx } from '@/lib/utils/cx';

/**
 * ===========================================================================
 * WHAT THE STUDENT SEES THE MOMENT THEY COMMIT.
 *
 * The answer key arrives with the answer (D-281) and this is where it lands.
 * Disclosing it is only defensible because the answer it reveals can no longer
 * be changed — a second answer to the same question is a 409 — which is why
 * this component has no "change my answer" affordance and must never grow one.
 *
 * ---------------------------------------------------------------------------
 * `role="status"`, NOT `role="alert"`.
 *
 * Both announce. `alert` is assertive: it interrupts whatever a screen reader
 * is mid-sentence on, which is right for a failure and wrong for "not this
 * time, here is why" — the interruption itself reads as alarm. §9.1's "no
 * harsh red" has an audible half, and this is it.
 * ===========================================================================
 */

export interface AnswerFeedbackProps {
  readonly result: AnswerResult;
  readonly correctOptionText: string;
  readonly onNext: () => void;
  readonly isLast: boolean;
}

export function AnswerFeedback({ correctOptionText, isLast, onNext, result }: AnswerFeedbackProps) {
  const t = useT();

  return (
    <div
      className={cx(
        'rounded-card border p-4 sm:p-6',
        result.isCorrect ? 'border-success bg-success/10' : 'border-warning bg-warning/10',
      )}
      data-correct={result.isCorrect ? 'true' : 'false'}
      role="status"
    >
      <p className="text-base font-bold text-ink">
        {result.isCorrect ? t('practice.feedbackCorrect') : t('practice.feedbackIncorrect')}
      </p>

      {/*
        The correct option is named IN WORDS, never as "option C". The letter is
        a position in a shuffle that is unique to this session — it means
        nothing tomorrow, and nothing to a student comparing notes with a friend
        whose options came out in a different order.
      */}
      {result.isCorrect ? null : (
        <p className="mt-2 text-sm leading-body text-ink">
          <span className="font-semibold">{t('practice.correctAnswerLabel')}</span>{' '}
          {correctOptionText}
        </p>
      )}

      {result.explanation === '' ? null : (
        <div className="mt-4">
          <p className="text-xs font-bold uppercase tracking-widest text-muted">
            {t('practice.explanationTitle')}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-body text-ink">
            {result.explanation}
          </p>
        </div>
      )}

      <Button className="mt-6" onClick={onNext}>
        {isLast ? t('practice.finishAction') : t('practice.nextAction')}
      </Button>
    </div>
  );
}
