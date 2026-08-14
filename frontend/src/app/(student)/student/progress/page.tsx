import type { Metadata } from 'next';
import { ProgressScreen } from '@/features/progress/progress-screen';
import { getServerT } from '@/lib/i18n/server';

export const metadata: Metadata = {
  title: 'Progress',
};

/** Build-order step 11. No `Suspense` here: this screen reads no search params. */
export default async function ProgressPage() {
  const t = await getServerT();

  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="rounded-card bg-brand p-6 text-white shadow-raised sm:p-8">
        <p className="text-sm font-semibold text-white">{t('progressScreen.eyebrow')}</p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">
          {t('progressScreen.title')}
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-white">
          {t('progressScreen.description')}
        </p>
      </section>

      <ProgressScreen />
    </div>
  );
}
