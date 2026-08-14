import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PracticeScreen } from '@/features/practice/practice-screen';
import { getServerT } from '@/lib/i18n/server';

export const metadata: Metadata = {
  title: 'Practice',
};

/** Build-order step 10. The heading is server-rendered; the journey is one island. */
export default async function PracticePage() {
  const t = await getServerT();

  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="rounded-card bg-brand p-6 text-white shadow-raised sm:p-8">
        <p className="text-sm font-semibold text-white">{t('practice.eyebrow')}</p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">
          {t('practice.title')}
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-white">{t('practice.description')}</p>
      </section>

      <Suspense fallback={<p className="text-sm text-muted">{t('practice.loadingSession')}</p>}>
        <PracticeScreen />
      </Suspense>
    </div>
  );
}
