'use client';

import { Button } from '@/components/ui/button';
import type { AnswerResult, PracticeQuestion } from '@/lib/api/generated/contracts/practice.contract';
import { useT } from '@/lib/i18n/i18n-provider';
import { cx } from '@/lib/utils/cx';

/**
 * ===========================================================================
 * ONE QUESTION — purely presentational, like the Foxy transcript. It takes a
 * question, a selection and a result, and reports what was pressed.
 *
 * ---------------------------------------------------------------------------
 * NATIVE RADIOS, NOT BUTTONS WITH `aria-pressed`.
 *
 * §10.3 requires keyboard access on every interaction, and a radio group gives
 * it for free and correctly: one tab stop for the whole group, arrow keys to
 * move between options, the browser enforcing "one at a time" rather than a
 * `useState` that could be made to hold two. §10.4's "one option selectable at
 * a time" is a property of the platform here, not of this component's code.
 *
 * ---------------------------------------------------------------------------
 * EVERY INDEX IS A PRESENTATION INDEX.
 *
 * `options` arrive shuffled for this session and position n IS presentation
 * index n — the contract says so, and the service translates through the
 * session's shuffle map before anything is stored. Nothing here sorts,
 * reorders or filters the array: a client that changed the order would send an
 * index meaning a different option than the one the student touched, and every
 * answer would be wrong in a way that looks like the student being wrong.
 * ===========================================================================
 */

export interface QuestionCardProps {
  readonly question: PracticeQuestion;
  readonly questionNumber: number;
  readonly questionCount: number;
  readonly selectedIndex: number | null;
  readonly onSelect: (index: number) => void;
  readonly onAnswer: () => void;
  /** Present once this question has been answered. Locks the group. */
  readonly result: AnswerResult | null;
  readonly isAnswering: boolean;
}

export function QuestionCard({
  isAnswering,
  onAnswer,
  onSelect,
  question,
  questionCount,
  questionNumber,
  result,
  selectedIndex,
}: QuestionCardProps) {
  const t = useT();
  const isAnswered = result !== null;

  return (
    <article className="rounded-card border border-line bg-surface p-4 shadow-raised sm:p-6">
      <p className="text-xs font-bold uppercase tracking-widest text-brand">
        {t('practice.questionProgress', { current: questionNumber, total: questionCount })}
      </p>
      <h2 className="mt-2 text-xl font-extrabold tracking-tight text-ink">
        {question.questionText}
      </h2>

      <fieldset className="mt-6" disabled={isAnswered}>
        <legend className="sr-only">{t('practice.optionsLabel')}</legend>
        <div className="space-y-3">
          {question.options.map((option, index) => (
            <OptionRow
              index={index}
              isCorrect={result !== null && result.correctPresentationIndex === index}
              isSelected={selectedIndex === index}
              isSettled={isAnswered}
              key={option}
              onSelect={onSelect}
              option={option}
              questionId={question.id}
            />
          ))}
        </div>
      </fieldset>

      {isAnswered ? null : (
        <Button
          className="mt-6"
          disabled={selectedIndex === null || isAnswering}
          onClick={onAnswer}
        >
          {t('practice.answerAction')}
        </Button>
      )}
    </article>
  );
}

interface OptionRowProps {
  readonly index: number;
  readonly isCorrect: boolean;
  readonly isSelected: boolean;
  readonly isSettled: boolean;
  readonly onSelect: (index: number) => void;
  readonly option: string;
  readonly questionId: string;
}

function OptionRow({
  index,
  isCorrect,
  isSelected,
  isSettled,
  onSelect,
  option,
  questionId,
}: OptionRowProps) {
  /*
   * THE CHOSEN-AND-WRONG ROW IS `warning`, NOT `danger`. §9.1 is explicit that
   * an incorrect answer gets no harsh red. The correct row is marked in
   * `success` whether or not it was the one chosen, because after disclosure
   * the useful information is where the answer is — not who was wrong.
   */
  const settledTone = isCorrect
    ? 'border-success bg-success/10'
    : isSelected
      ? 'border-warning bg-warning/10'
      : 'border-line';

  return (
    <label
      className={cx(
        'flex min-h-control cursor-pointer items-center gap-3 rounded-card border p-3 transition-surface duration-micro',
        isSettled
          ? settledTone
          : isSelected
            ? 'border-brand bg-brand-subtle'
            : 'border-line hover:border-brand',
      )}
    >
      <input
        checked={isSelected}
        // `size-6` and not `size-5`: the scale is closed, so an off-scale
        // utility emits NOTHING and the radio would render at its user-agent
        // size. The lint rule caught this one before it shipped.
        className="size-6 accent-brand"
        name={`question-${questionId}`}
        onChange={() => {
          onSelect(index);
        }}
        type="radio"
        value={index}
      />
      <span className="text-base leading-body text-ink">{option}</span>
    </label>
  );
}
