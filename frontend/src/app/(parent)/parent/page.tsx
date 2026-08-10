import type { Metadata } from 'next';
import { ChildSummary, type ChildLearningSummary } from '@/features/parent-dashboard/components/child-summary';

export const metadata: Metadata = {
  title: 'Parent dashboard',
};

const sampleChild: ChildLearningSummary = {
  childName: 'Aarav Sharma',
  classLabel: 'Class 7 · Sample learner',
  recentActivity: 'Practised fractions on four days this week',
  latestEvidence: 'Strong evidence',
  latestEvidenceDetail: 'Equivalent fractions are consistent across recent practice.',
  focusArea: 'Main ideas in English reading',
};

export default function ParentDashboardPage() {
  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="overflow-hidden rounded-card bg-brand p-6 text-white shadow-raised sm:p-8">
        <p className="text-sm font-semibold text-white">Parent dashboard · Sample data</p>
        <div className="mt-3 max-w-2xl">
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Welcome back, Ananya</h1>
          <p className="mt-3 text-base leading-7 text-white">
            See a calm, evidence-based summary of Aarav&apos;s recent learning without ranking or comparison.
          </p>
        </div>
      </section>

      <ChildSummary child={sampleChild} />

      <section aria-labelledby="updates-heading" className="product-anchor rounded-card border border-line bg-surface p-5 shadow-raised sm:p-6" id="updates">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-brand">Recent updates</p>
            <h2 className="mt-2 text-xl font-extrabold tracking-tight text-ink" id="updates-heading">
              Learning activity
            </h2>
          </div>
          <span className="rounded-full bg-brand-subtle px-3 py-1 text-xs font-semibold text-brand-strong">Preview</span>
        </div>

        <ol className="mt-6 divide-y divide-line">
          <li className="flex gap-4 py-4 first:pt-0">
            <span aria-hidden="true" className="mt-1 size-3 shrink-0 rounded-full bg-brand" />
            <div>
              <p className="font-semibold text-ink">Completed a fractions practice set</p>
              <p className="mt-1 text-sm leading-6 text-muted">The evidence moved from Developing to Strong evidence after consistent answers.</p>
            </div>
          </li>
          <li className="flex gap-4 py-4 last:pb-0">
            <span aria-hidden="true" className="mt-1 size-3 shrink-0 rounded-full bg-brand" />
            <div>
              <p className="font-semibold text-ink">Continued the plant systems lesson</p>
              <p className="mt-1 text-sm leading-6 text-muted">Aarav explained two concepts correctly using his own examples.</p>
            </div>
          </li>
        </ol>
      </section>
    </div>
  );
}
