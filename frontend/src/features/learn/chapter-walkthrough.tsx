'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { Button } from '@/components/ui/button';
import type { ChapterConcept } from '@/lib/api/generated/contracts/content.contract';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';
import { useChapterConcepts } from './hooks/use-learn';

/**
 * ===========================================================================
 * THE CHAPTER WALKTHROUGH — one concept at a time.
 *
 * This is what the 639 rows in `chapter_concepts` were imported for. They have
 * been in the database since the corpus landed, complete with explanations, and
 * until the endpoint shipped nothing could read them.
 *
 * ---------------------------------------------------------------------------
 * ONE CONCEPT PER SCREEN, NOT A WALL OF TEXT.
 *
 * A chapter is seven concepts on average. Rendering all seven is a page a
 * student scrolls past; rendering one is a thing they finish. The position is
 * held in component state rather than the URL — a half-read chapter is not a
 * place worth linking to, and putting it in the URL would put every "next"
 * press in the back button's history, so leaving the chapter would mean
 * pressing back seven times.
 * ===========================================================================
 */

export interface ChapterWalkthroughProps {
  readonly chapterId: string;
  readonly subject: string;
}

export function ChapterWalkthrough({ chapterId, subject }: ChapterWalkthroughProps) {
  const t = useT();
  const { language } = useLanguage();
  const query = useChapterConcepts(chapterId);
  const [index, setIndex] = useState(0);

  if (query.isPending) return <LoadingState label={t('learn.loading')} />;

  if (query.error !== null) {
    return (
      <ErrorState
        description={t('learn.errorDescription')}
        onRetry={() => {
          void query.refetch();
        }}
        retryLabel={t('learn.retryAction')}
        title={t('learn.errorTitle')}
      />
    );
  }

  const { chapter, concepts } = query.data;
  const title = language === 'hi' && chapter.titleHi !== null ? chapter.titleHi : chapter.titleEn;

  /*
   * Ten of the 137 chapters have no concepts. The endpoint answers 200 with an
   * empty list precisely so this can be said honestly — content missing, not a
   * chapter missing — and the student is pointed at practice, which does have
   * questions for it.
   */
  if (concepts.length === 0) {
    return (
      <div className="space-y-4">
        <ChapterHeading number={chapter.chapterNumber} subject={subject} title={title} />
        <EmptyState
          action={
            <Link
              className="inline-flex min-h-control items-center rounded-full bg-brand px-6 py-3 text-sm font-semibold text-brand-fg shadow-raised"
              href="/student/practice"
            >
              {t('learn.practiceInstead')}
            </Link>
          }
          description={t('learn.noConceptsDescription')}
          title={t('learn.noConceptsTitle')}
        />
      </div>
    );
  }

  const concept = concepts[Math.min(index, concepts.length - 1)];
  if (concept === undefined) return null;

  const isLast = index >= concepts.length - 1;

  return (
    <div className="space-y-6">
      <ChapterHeading number={chapter.chapterNumber} subject={subject} title={title} />

      <ConceptProgress current={index + 1} total={concepts.length} />

      <ConceptCard concept={concept} />

      <div className="flex flex-wrap gap-3">
        {index > 0 ? (
          <Button
            onClick={() => {
              setIndex((current) => current - 1);
            }}
            variant="secondary"
          >
            {t('learn.previousConcept')}
          </Button>
        ) : null}

        {isLast ? (
          /*
           * THE END OF A CHAPTER IS A HANDOFF, NOT A DEAD END. Reading is half
           * the loop; the product's whole pedagogy is read → practise, so the
           * last card offers practice rather than leaving the student on a
           * screen with nothing to press.
           */
          <Link
            className="inline-flex min-h-control items-center rounded-full bg-brand px-6 py-3 text-sm font-semibold text-brand-fg shadow-raised"
            href="/student/practice"
          >
            {t('learn.practiceThisChapter')}
          </Link>
        ) : (
          <Button
            onClick={() => {
              setIndex((current) => current + 1);
            }}
          >
            {t('learn.nextConcept')}
          </Button>
        )}

        {/*
          ASK FOXY, ALREADY SCOPED TO THIS SUBJECT. The whole reason this screen
          exists as an entry point: the subject is known, so nothing is guessed
          from a dropdown that defaults to mathematics.
        */}
        <Link
          className="inline-flex min-h-control items-center rounded-full px-4 py-3 text-sm font-semibold text-brand hover:bg-brand-subtle"
          href={`/student/foxy?subject=${encodeURIComponent(subject)}`}
        >
          {t('learn.askFoxy')}
        </Link>
      </div>
    </div>
  );
}

function ChapterHeading({
  number,
  subject,
  title,
}: {
  readonly number: number;
  readonly subject: string;
  readonly title: string;
}) {
  const t = useT();

  return (
    <div>
      <Link
        className="text-sm font-semibold text-brand hover:text-brand-strong"
        href={`/student/learn?subject=${encodeURIComponent(subject)}`}
      >
        {t('learn.backToChapters')}
      </Link>
      <h2 className="mt-2 text-2xl font-extrabold tracking-tight text-ink">
        {t('learn.chapterNumber', { number })} · {title}
      </h2>
    </div>
  );
}

/**
 * Where the student is in the chapter.
 *
 * A COUNT AND A BAR, and the bar is `aria-hidden` because the count already
 * says it. Two announcements of the same fact is noise on a screen a student
 * moves through seven times.
 */
function ConceptProgress({ current, total }: { readonly current: number; readonly total: number }) {
  const t = useT();

  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-widest text-muted">
        {t('learn.conceptProgress', { current, total })}
      </p>
      <div aria-hidden="true" className="mt-2 flex gap-1">
        {Array.from({ length: total }, (_, position) => (
          <span
            className={
              position < current ? 'h-2 flex-1 rounded-full bg-brand' : 'h-2 flex-1 rounded-full bg-line'
            }
            key={position}
          />
        ))}
      </div>
    </div>
  );
}

function ConceptCard({ concept }: { readonly concept: ChapterConcept }) {
  const t = useT();
  const { language } = useLanguage();

  /*
   * Hindi here is CORPUS CONTENT and genuinely absent on some rows, so it falls
   * back to English rather than rendering a blank card. The alternative — hiding
   * the concept — would silently shorten a chapter for Hindi readers.
   */
  const title = language === 'hi' && concept.titleHi !== null ? concept.titleHi : concept.titleEn;
  const explanation =
    language === 'hi' && concept.explanationHi !== null
      ? concept.explanationHi
      : concept.explanationEn;

  return (
    <article className="rounded-card border border-line bg-surface p-4 shadow-raised sm:p-6">
      <h3 className="text-xl font-extrabold tracking-tight text-ink">{title}</h3>

      {concept.learningObjective === null ? null : (
        <p className="mt-2 text-sm font-semibold text-brand-strong">{concept.learningObjective}</p>
      )}

      {explanation === null ? null : (
        <p className="mt-4 whitespace-pre-wrap text-base leading-body text-ink">{explanation}</p>
      )}

      {concept.keyFormula === null ? null : (
        <div className="mt-4 rounded-card bg-brand-subtle p-4">
          <p className="text-xs font-bold uppercase tracking-widest text-brand-strong">
            {t('learn.keyFormula')}
          </p>
          <p className="mt-1 whitespace-pre-wrap font-mono text-base text-ink">
            {concept.keyFormula}
          </p>
        </div>
      )}

      {concept.exampleContent === null ? null : (
        <div className="mt-4">
          <p className="text-xs font-bold uppercase tracking-widest text-muted">
            {t('learn.example')}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-base leading-body text-ink">
            {concept.exampleContent}
          </p>
        </div>
      )}

      {concept.commonMistakes.length === 0 ? null : (
        <div className="mt-4 rounded-card border border-warning bg-warning/10 p-4">
          <p className="text-xs font-bold uppercase tracking-widest text-ink">
            {t('learn.commonMistakes')}
          </p>
          <ul className="mt-2 space-y-1">
            {concept.commonMistakes.map((mistake) => (
              <li className="text-sm leading-body text-ink" key={mistake}>
                {mistake}
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}
