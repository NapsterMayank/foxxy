import type { Metadata } from 'next';
import Link from 'next/link';
import { ProgressSummary, type SubjectProgressItem } from '@/features/progress/components/progress-summary';
import { getServerT } from '@/lib/i18n/server';

export const metadata: Metadata = {
  title: 'Student dashboard',
};

const sampleProgress: readonly SubjectProgressItem[] = [
  {
    subject: 'Mathematics',
    evidence: 'Strong evidence',
    detail: 'Fractions are looking confident across recent practice.',
  },
  {
    subject: 'Science',
    evidence: 'Developing',
    detail: 'You can explain the parts of a plant with clear examples.',
  },
  {
    subject: 'English',
    evidence: 'Needs another session',
    detail: 'Try one more exercise on identifying the main idea.',
  },
];

/** Sample data, not UI copy — see the note in the parent dashboard. */
const learner = { name: 'Aarav', daysDone: 4, daysTotal: 5 };

export default async function StudentDashboardPage() {
  const t = await getServerT();

  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="overflow-hidden rounded-card bg-brand p-6 text-white shadow-raised sm:p-8">
        <p className="text-sm font-semibold text-white">
          {t('student.eyebrow')} · {t('common.sampleData')}
        </p>
        <div className="mt-3 max-w-2xl">
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
            {t('student.greeting', { name: learner.name })}
          </h1>
          <p className="mt-3 text-base leading-7 text-white">{t('student.intro')}</p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link
              className="inline-flex min-h-control items-center justify-center rounded-full bg-white px-6 py-3 text-sm font-bold text-brand-strong shadow-raised transition-surface duration-micro hover:shadow-overlay focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/60 active:scale-press"
              data-motion="press"
              href="#next-up"
            >
              {t('student.seeNext')}
              <span aria-hidden="true" className="ml-2">
                ↓
              </span>
            </Link>
            <Link
              className="inline-flex min-h-control items-center justify-center rounded-full border border-white/60 px-6 py-3 text-sm font-bold text-white transition-surface duration-micro hover:bg-white/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/60 active:scale-press"
              data-motion="press"
              href="#progress"
            >
              {t('student.reviewProgress')}
            </Link>
          </div>
        </div>
      </section>

      <section className="product-anchor grid gap-4 sm:grid-cols-2" id="next-up">
        <article className="rounded-card border border-line bg-surface p-4 shadow-raised sm:p-6">
          <p className="text-xs font-bold uppercase tracking-widest text-brand">{t('student.nextUpEyebrow')}</p>
          <h2 className="mt-2 text-xl font-extrabold text-ink">{t('student.nextUpTitle')}</h2>
          <p className="mt-2 text-sm leading-6 text-muted">{t('student.nextUpDescription')}</p>
          <span className="mt-6 inline-flex min-h-control items-center rounded-full bg-brand-subtle px-4 py-2 text-sm font-semibold text-brand-strong">
            {t('student.previewOnly')}
          </span>
        </article>

        <article className="rounded-card border border-line bg-surface p-4 shadow-raised sm:p-6">
          <p className="text-xs font-bold uppercase tracking-widest text-brand">{t('student.weekEyebrow')}</p>
          <h2 className="mt-2 text-xl font-extrabold text-ink">{t('student.weekTitle')}</h2>
          <p className="mt-2 text-sm leading-6 text-muted">{t('student.weekDescription')}</p>
          <div
            aria-label={t('student.weekProgressLabel', { done: learner.daysDone, total: learner.daysTotal })}
            className="mt-6 flex gap-2"
            role="img"
          >
            {[true, true, true, true, false].map((complete, index) => (
              <span
                className={complete ? 'size-8 rounded bg-brand' : 'size-8 rounded bg-line'}
                key={`day-${index + 1}`}
              />
            ))}
          </div>
        </article>
      </section>

      <ProgressSummary items={sampleProgress} title={t('student.progressTitle')} />
    </div>
  );
}
