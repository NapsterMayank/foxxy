'use client';

import Link from 'next/link';
import { ErrorState, LoadingState } from '@/components/patterns/states';
import { SUBJECTS, type Subject } from '@/lib/api/generated/constants/curriculum';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';
import type { TranslationKey } from '@/lib/i18n/translate';
import { useChapters, useProfile } from './hooks/use-learn';

/**
 * ===========================================================================
 * SUBJECT → CHAPTER, THE WAY A STUDENT THINKS ABOUT IT.
 *
 * The mental model is Subjects → Chapters → Read → Practice, and the URL says
 * so: `/student/learn?subject=science` and then
 * `/student/learn/science/<chapterId>`. Dropdowns were the alternative and they
 * lose three things a URL keeps — the back button, a link somebody can send,
 * and a screen that can be reopened where it was left.
 *
 * It also fixes a real defect in the Foxy entry point. That screen's subject
 * `<select>` defaults to the first subject alphabetically — MATHEMATICS — so a
 * student who asked a science question in a fresh conversation had it answered
 * against the maths corpus and got an abstention. Verified in the retrieval
 * trace: `subject=mathematics, chunks=0, abstain_reason=below_threshold`.
 * Arriving from a chapter means the subject is never guessed.
 * ===========================================================================
 */

const subjectLabelKeys: Readonly<Record<Subject, TranslationKey>> = {
  mathematics: 'onboarding.subjectOption.mathematics',
  science: 'onboarding.subjectOption.science',
};

export interface LearnBrowserProps {
  /** From the URL. Null shows the subject picker. */
  readonly subject: Subject | null;
}

export function LearnBrowser({ subject }: LearnBrowserProps) {
  const t = useT();
  const profile = useProfile();
  const grade = profile.data?.profile.grade ?? null;
  const chapters = useChapters(grade, subject);

  if (profile.isPending) return <LoadingState label={t('learn.loading')} />;

  if (profile.error !== null) {
    return (
      <ErrorState
        description={t('learn.errorDescription')}
        onRetry={() => {
          void profile.refetch();
        }}
        retryLabel={t('learn.retryAction')}
        title={t('learn.errorTitle')}
      />
    );
  }

  return (
    <div className="space-y-6">
      <SubjectTiles selected={subject} />

      {subject === null ? (
        <p className="text-base leading-body text-muted">{t('learn.pickSubject')}</p>
      ) : chapters.isPending ? (
        <LoadingState label={t('learn.loading')} />
      ) : chapters.error !== null ? (
        <ErrorState
          description={t('learn.errorDescription')}
          onRetry={() => {
            void chapters.refetch();
          }}
          retryLabel={t('learn.retryAction')}
          title={t('learn.errorTitle')}
        />
      ) : (
        <ChapterList chapters={chapters.data.chapters} subject={subject} />
      )}
    </div>
  );
}

/**
 * The subjects this student may study.
 *
 * RENDERED AS LINKS, NOT BUTTONS. Choosing a subject is a navigation — it
 * changes what the page is about and belongs in history — so it works with a
 * middle click and reads as a navigation to a screen reader.
 */
function SubjectTiles({ selected }: { readonly selected: Subject | null }) {
  const t = useT();

  return (
    <nav aria-label={t('learn.subjectsLabel')}>
      <div className="flex flex-wrap gap-3">
        {SUBJECTS.map((code) => {
          const isCurrent = code === selected;
          return (
            <Link
              aria-current={isCurrent ? 'page' : undefined}
              className={
                isCurrent
                  ? 'inline-flex min-h-control items-center rounded-full bg-brand px-6 py-3 text-sm font-semibold text-brand-fg shadow-raised'
                  : 'inline-flex min-h-control items-center rounded-full border border-line bg-surface px-6 py-3 text-sm font-semibold text-ink hover:border-brand hover:text-brand-strong'
              }
              href={`/student/learn?subject=${code}`}
              key={code}
            >
              {t(subjectLabelKeys[code])}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function ChapterList({
  chapters,
  subject,
}: {
  readonly chapters: readonly { id: string; chapterNumber: number; titleEn: string; titleHi: string | null }[];
  readonly subject: Subject;
}) {
  const t = useT();
  const { language } = useLanguage();

  if (chapters.length === 0) {
    return <p className="text-base leading-body text-muted">{t('learn.noChapters')}</p>;
  }

  return (
    <section aria-labelledby="learn-chapters-title">
      <h2
        className="text-xs font-bold uppercase tracking-widest text-muted"
        id="learn-chapters-title"
      >
        {t('learn.chaptersTitle')}
      </h2>

      <ol className="mt-3 space-y-2">
        {chapters.map((chapter) => (
          <li key={chapter.id}>
            <Link
              className="flex min-h-control items-center gap-4 rounded-card border border-line bg-surface p-4 transition-surface duration-micro hover:border-brand"
              href={`/student/learn/${subject}/${encodeURIComponent(chapter.id)}`}
            >
              {/*
                The chapter NUMBER is the anchor a student navigates by — they
                are told "do chapter 6", not the title — so it leads, and it
                stays legible when the title is one of the 63 placeholders the
                import produced.
              */}
              <span className="grid size-12 shrink-0 place-items-center rounded-card bg-brand-subtle text-base font-extrabold text-brand-strong">
                {chapter.chapterNumber}
              </span>
              <span className="font-semibold text-ink">
                {language === 'hi' && chapter.titleHi !== null ? chapter.titleHi : chapter.titleEn}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
