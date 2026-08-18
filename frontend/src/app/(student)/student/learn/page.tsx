import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LearnBrowser } from '@/features/learn/learn-browser';
import { SUBJECTS, type Subject } from '@/lib/api/generated/constants/curriculum';
import { getServerT } from '@/lib/i18n/server';

export const metadata: Metadata = {
  title: 'Study',
};

/**
 * The subject browser.
 *
 * THE SUBJECT COMES FROM THE URL and is narrowed here rather than trusted: a
 * query string is user input, and `?subject=chemistry` would otherwise reach
 * the API as a filter for a subject the pilot does not carry. An unknown value
 * falls back to the picker, which is what a student typing by hand deserves to
 * see.
 */
export default async function LearnPage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string }>;
}) {
  const t = await getServerT();
  const { subject } = await searchParams;
  const selected = SUBJECTS.find((code): code is Subject => code === subject) ?? null;

  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="rounded-card bg-brand p-6 text-white shadow-raised sm:p-8">
        <p className="text-sm font-semibold text-white">{t('learn.eyebrow')}</p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">
          {t('learn.title')}
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-white">{t('learn.description')}</p>
      </section>

      <Suspense fallback={<p className="text-sm text-muted">{t('learn.loading')}</p>}>
        <LearnBrowser subject={selected} />
      </Suspense>
    </div>
  );
}
