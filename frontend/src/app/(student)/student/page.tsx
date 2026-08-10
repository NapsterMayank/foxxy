import type { Metadata } from 'next';
import { ProgressSummary, type SubjectProgressItem } from '@/features/progress/components/progress-summary';

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

export default function StudentDashboardPage() {
  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="overflow-hidden rounded-card bg-brand p-6 text-white shadow-raised sm:p-8">
        <p className="text-sm font-semibold text-white">Student dashboard · Sample data</p>
        <div className="mt-3 max-w-2xl">
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Good afternoon, Aarav</h1>
          <p className="mt-3 text-base leading-7 text-white">
            Your next activity is ready. Pick up where you left off or review your recent learning evidence.
          </p>
        </div>
      </section>

      <section className="product-anchor grid gap-4 sm:grid-cols-2" id="next-up">
        <article className="rounded-card border border-line bg-surface p-5 shadow-raised sm:p-6">
          <p className="text-xs font-bold uppercase tracking-widest text-brand">Next up</p>
          <h2 className="mt-2 text-xl font-extrabold text-ink">Fractions in everyday life</h2>
          <p className="mt-2 text-sm leading-6 text-muted">A short practice set using recipes and sharing examples.</p>
          <span className="mt-5 inline-flex min-h-control items-center rounded-full bg-brand-subtle px-4 py-2 text-sm font-semibold text-brand-strong">
            Preview only
          </span>
        </article>

        <article className="rounded-card border border-line bg-surface p-5 shadow-raised sm:p-6">
          <p className="text-xs font-bold uppercase tracking-widest text-brand">This week</p>
          <h2 className="mt-2 text-xl font-extrabold text-ink">Four learning days</h2>
          <p className="mt-2 text-sm leading-6 text-muted">A steady rhythm matters more than a perfect streak. Nice work returning regularly.</p>
          <div aria-label="Four of five learning days completed" className="mt-5 flex gap-2" role="img">
            {[true, true, true, true, false].map((complete, index) => (
              <span
                className={complete ? 'size-8 rounded-lg bg-brand' : 'size-8 rounded-lg bg-line'}
                key={`day-${index + 1}`}
              />
            ))}
          </div>
        </article>
      </section>

      <ProgressSummary items={sampleProgress} title="How your learning is developing" />
    </div>
  );
}
