import type { Metadata } from 'next';
import { ChildSummary, type ChildLearningSummary } from '@/features/parent-dashboard/components/child-summary';
import { getServerT } from '@/lib/i18n/server';

export const metadata: Metadata = {
  title: 'Parent dashboard',
};

const sampleChild: ChildLearningSummary = {
  childName: 'Aarav Sharma',
  classLabel: 'Class 7 · Sample learner',
  recentActivity: 'Practised fractions on four days this week',
  latestEvidence: 'strong',
  latestEvidenceDetail: 'Equivalent fractions are consistent across recent practice.',
  focusArea: 'Main ideas in English reading',
};

/**
 * SAMPLE DATA, not UI copy. It stays in English because it stands in for
 * values the API will supply — a child's name, a teacher's note — and those
 * are never translated at render time either.
 */
const parentName = 'Ananya';

const updates = [
  {
    title: 'Completed a fractions practice set',
    detail: 'The evidence moved from Developing to Strong evidence after consistent answers.',
  },
  {
    title: 'Continued the plant systems lesson',
    detail: 'Aarav explained two concepts correctly using his own examples.',
  },
];

export default async function ParentDashboardPage() {
  const t = await getServerT();

  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="overflow-hidden rounded-card bg-brand p-6 text-white shadow-raised sm:p-8">
        <p className="text-sm font-semibold text-white">
          {t('parent.eyebrow')} · {t('common.sampleData')}
        </p>
        <div className="mt-3 max-w-2xl">
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
            {t('parent.greeting', { name: parentName })}
          </h1>
          <p className="mt-3 text-base leading-7 text-white">{t('parent.intro')}</p>
        </div>
      </section>

      <ChildSummary child={sampleChild} />

      <section aria-labelledby="updates-heading" className="product-anchor rounded-card border border-line bg-surface p-4 shadow-raised sm:p-6" id="updates">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-brand">{t('parent.updatesEyebrow')}</p>
            <h2 className="mt-2 text-xl font-extrabold tracking-tight text-ink" id="updates-heading">
              {t('parent.updatesTitle')}
            </h2>
          </div>
          <span className="rounded-full bg-brand-subtle px-3 py-1 text-xs font-semibold text-brand-strong">
            {t('common.preview')}
          </span>
        </div>

        <ol className="mt-6 divide-y divide-line">
          <li className="flex gap-4 py-4 first:pt-0">
            <span aria-hidden="true" className="mt-1 size-3 shrink-0 rounded-full bg-brand" />
            <div>
              <p className="font-semibold text-ink">{updates[0].title}</p>
              <p className="mt-1 text-sm leading-6 text-muted">{updates[0].detail}</p>
            </div>
          </li>
          <li className="flex gap-4 py-4 last:pb-0">
            <span aria-hidden="true" className="mt-1 size-3 shrink-0 rounded-full bg-brand" />
            <div>
              <p className="font-semibold text-ink">{updates[1].title}</p>
              <p className="mt-1 text-sm leading-6 text-muted">{updates[1].detail}</p>
            </div>
          </li>
        </ol>
      </section>
    </div>
  );
}
