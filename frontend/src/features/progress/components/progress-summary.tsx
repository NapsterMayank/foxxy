import { learningEvidenceLabels, type LearningEvidence } from '@/types/learning-evidence';

export interface SubjectProgressItem {
  detail: string;
  evidence: LearningEvidence;
  subject: string;
}

interface ProgressSummaryProps {
  items: readonly SubjectProgressItem[];
  title: string;
}

export function ProgressSummary({ items, title }: ProgressSummaryProps) {
  return (
    <section aria-labelledby="progress-heading" className="product-anchor rounded-card border border-line bg-surface p-5 shadow-raised sm:p-6" id="progress">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-brand">Learning evidence</p>
          <h2 className="mt-2 text-xl font-extrabold tracking-tight text-ink" id="progress-heading">
            {title}
          </h2>
        </div>
        <p className="rounded-full bg-brand-subtle px-3 py-1 text-xs font-semibold text-brand-strong">
          Sample progress
        </p>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => {
          const activeStep = learningEvidenceLabels.indexOf(item.evidence);

          return (
            <article className="rounded-card border border-line p-4" key={item.subject}>
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-bold text-ink">{item.subject}</h3>
                <span className="rounded-full bg-brand-subtle px-2 py-1 text-xs font-semibold text-brand-strong">
                  {item.evidence}
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted">{item.detail}</p>
              <div aria-hidden="true" className="mt-4 flex gap-2">
                {learningEvidenceLabels.map((step, index) => (
                  <span
                    className={index <= activeStep ? 'h-2 flex-1 rounded-full bg-brand' : 'h-2 flex-1 rounded-full bg-line'}
                    key={step}
                  />
                ))}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
