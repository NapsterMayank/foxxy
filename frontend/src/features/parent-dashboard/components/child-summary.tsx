import { EvidenceLabel } from '@/components/patterns/evidence-label';
import { getServerT } from '@/lib/i18n/server';
import type { LearningEvidence } from '@/types/learning-evidence';

export interface ChildLearningSummary {
  childName: string;
  classLabel: string;
  focusArea: string;
  latestEvidence: LearningEvidence;
  latestEvidenceDetail: string;
  recentActivity: string;
}

interface ChildSummaryProps {
  child: ChildLearningSummary;
}

export async function ChildSummary({ child }: ChildSummaryProps) {
  const t = await getServerT();

  return (
    <section aria-labelledby="child-summary-heading" className="product-anchor rounded-card border border-line bg-surface p-4 shadow-raised sm:p-6" id="child-summary">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-brand">{t('childSummary.eyebrow')}</p>
          <h2 className="mt-2 text-xl font-extrabold tracking-tight text-ink" id="child-summary-heading">
            {child.childName}
          </h2>
          <p className="mt-1 text-sm text-muted">{child.classLabel}</p>
        </div>
        <span className="rounded-full bg-brand-subtle px-3 py-1 text-xs font-semibold text-brand-strong">
          {t('common.sampleData')}
        </span>
      </div>

      <dl className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-card border border-line p-4">
          <dt className="text-xs font-bold uppercase tracking-wider text-muted">
            {t('childSummary.recentActivityLabel')}
          </dt>
          <dd className="mt-2 text-sm font-semibold leading-6 text-ink">{child.recentActivity}</dd>
        </div>
        <div className="rounded-card border border-line p-4">
          <dt className="text-xs font-bold uppercase tracking-wider text-muted">
            {t('childSummary.latestEvidenceLabel')}
          </dt>
          <dd className="mt-2 text-sm font-semibold leading-6 text-ink">
            <EvidenceLabel evidence={child.latestEvidence} />
            <span className="mt-1 block">{child.latestEvidenceDetail}</span>
          </dd>
        </div>
        <div className="rounded-card border border-line p-4">
          <dt className="text-xs font-bold uppercase tracking-wider text-muted">
            {t('childSummary.focusAreaLabel')}
          </dt>
          <dd className="mt-2 text-sm font-semibold leading-6 text-ink">{child.focusArea}</dd>
        </div>
      </dl>

      {/*
        §10.4: "the child's visibility indicator is ALWAYS present". A parent
        reading a report about their child must know the child can read it too —
        a surveillance dashboard the child cannot see is a different product.
      */}
      <p className="mt-6 text-sm leading-body text-muted">{t('childSummary.visibilityNote')}</p>
    </section>
  );
}
