'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { EntitlementFeature } from '@/lib/api/generated/contracts/billing.contract';
import type { TolerantPlanSummary } from '../api/billing-requests';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';
import type { TranslationKey } from '@/lib/i18n/translate';
import { formatMoney, periodOf } from '../lib/money';

/**
 * ===========================================================================
 * ONE PLAN, AT THE PRICE THE SERVER QUOTED.
 *
 * The figure, the currency and the period all come from `GET /billing/plans`,
 * which reads the same table the checkout path reads. Nothing here holds a
 * price, and nothing here should ever be given a `price` prop that a screen
 * could compute — a client that can compute a price is a client that can
 * advertise one figure while another is charged.
 *
 * The FEATURE LIST is also served. It says what is being bought, and a local
 * list would eventually promise something the grant does not include.
 * ===========================================================================
 */

/**
 * Entitlement codes to their copy.
 *
 * A `Partial` record, and deliberately: `ENTITLEMENT_FEATURES` is a closed set
 * the backend can add to, and a feature this build cannot name is DROPPED from
 * the list rather than rendered as its code. "practice.unlimited" in a bullet
 * point on a paid plan is worse than one fewer bullet — it reads as an
 * unfinished page on the screen where trust matters most.
 */
const featureLabelKeys: Partial<Record<EntitlementFeature, TranslationKey>> = {
  'practice.basic': 'billing.featurePracticeBasic',
  'practice.unlimited': 'billing.featurePracticeUnlimited',
  'foxy.basic': 'billing.featureFoxyBasic',
  'foxy.unlimited': 'billing.featureFoxyUnlimited',
  'parent.digest': 'billing.featureParentDigest',
};

const periodLabelKeys = {
  month: 'billing.perMonth',
  year: 'billing.perYear',
  days: 'billing.perDays',
} as const satisfies Record<ReturnType<typeof periodOf>, TranslationKey>;

export interface PlanCardProps {
  readonly plan: TolerantPlanSummary;
  readonly isCurrent: boolean;
  readonly onChoose: (planCode: string) => void;
  readonly isPending: boolean;
}

export function PlanCard({ isCurrent, isPending, onChoose, plan }: PlanCardProps) {
  const t = useT();
  const { language } = useLanguage();
  const period = periodOf(plan.periodDays);

  const features = plan.features
    .map((feature) => featureLabelKeys[feature as EntitlementFeature])
    .filter((key): key is TranslationKey => key !== undefined);

  return (
    <article
      className="flex flex-col rounded-card border border-line bg-surface p-4 shadow-raised sm:p-6"
      data-plan={plan.code}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-2xl font-extrabold tracking-tight text-ink">
          {formatMoney(plan.amountMinorUnits, plan.currency, language)}
        </p>
        {isCurrent ? <Badge tone="success">{t('billing.currentPlanBadge')}</Badge> : null}
      </div>

      <p className="mt-1 text-sm text-muted">
        {period === 'days'
          ? t(periodLabelKeys.days, { days: plan.periodDays })
          : t(periodLabelKeys[period])}
      </p>

      <ul className="mt-4 flex-1 space-y-2">
        {features.map((key) => (
          <li className="text-sm leading-body text-ink" key={key}>
            {t(key)}
          </li>
        ))}
      </ul>

      {/*
        A PLAN SOMEBODY IS ALREADY ON OFFERS NOTHING TO PRESS. The backend
        refuses a second live subscription with a 409, so a live button here
        would be a button whose only outcome is an error the customer cannot
        act on.
      */}
      {isCurrent ? (
        <p className="mt-6 text-sm font-semibold text-muted">{t('billing.currentPlanNote')}</p>
      ) : (
        <Button
          className="mt-6"
          disabled={isPending}
          onClick={() => {
            onChoose(plan.code);
          }}
        >
          {t('billing.chooseAction')}
        </Button>
      )}
    </article>
  );
}
