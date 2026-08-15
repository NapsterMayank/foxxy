'use client';

import { useState } from 'react';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type {
  BillingStatusResponse,
  SubscriptionStatus,
} from '@/lib/api/generated/contracts/billing.contract';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';
import type { TranslationKey } from '@/lib/i18n/translate';
import { formatDayAndMonth } from '@/lib/utils/format-date';

/**
 * ===========================================================================
 * WHAT THIS ACCOUNT HAS RIGHT NOW.
 *
 * ---------------------------------------------------------------------------
 * A SCHOOL-PAID SEAT MUST NEVER BE SHOWN A PRICE OR A CANCEL BUTTON.
 *
 * `payer.kind` is on the wire for exactly this — the contract says a student on
 * a school plan "must not be shown 'you will be charged ₹299'", and that without
 * the field a client would have to guess from the role. So the cancel control
 * is behind `payer.kind === 'user'`: cancelling somebody else's institutional
 * contract is not an action this screen offers, and offering it would produce a
 * refusal the student could do nothing about.
 *
 * ---------------------------------------------------------------------------
 * `pending` IS NOT `active`, AND SAYING SO IS THE HONEST PART.
 *
 * A subscription is created in `pending` and grants nothing until the provider
 * confirms payment by webhook. A screen that read "subscribed" the moment
 * checkout started would be telling somebody they had bought something before
 * any money moved — and the customer would then find the paid features absent.
 * ===========================================================================
 */

const statusTones: Readonly<Record<SubscriptionStatus, BadgeTone>> = {
  active: 'success',
  pending: 'info',
  /*
   * `past_due` IS `warning`, NOT `danger`. Something needs attention — a card
   * that expired — and access has not been cut off yet. Red would say the
   * account is gone, which is both wrong and the fastest way to lose somebody
   * who was about to fix their card.
   */
  past_due: 'warning',
  cancelled: 'neutral',
  expired: 'neutral',
};

const statusLabelKeys: Readonly<Record<SubscriptionStatus, TranslationKey>> = {
  active: 'billing.statusActive',
  pending: 'billing.statusPending',
  past_due: 'billing.statusPastDue',
  cancelled: 'billing.statusCancelled',
  expired: 'billing.statusExpired',
};

export interface CurrentPlanProps {
  readonly status: BillingStatusResponse;
  readonly onCancel: () => void;
  readonly isCancelling: boolean;
  readonly error?: string;
}

export function CurrentPlan({ error, isCancelling, onCancel, status }: CurrentPlanProps) {
  const t = useT();
  const { language } = useLanguage();
  const [confirming, setConfirming] = useState(false);

  const { entitlements, subscription } = status;
  const isSchoolPaid = subscription?.payer.kind === 'school';
  const canCancel =
    subscription !== null &&
    !isSchoolPaid &&
    subscription.cancelledAt === null &&
    (subscription.status === 'active' || subscription.status === 'past_due');

  return (
    <section
      aria-labelledby="billing-current-title"
      className="rounded-card border border-line bg-surface p-4 shadow-raised sm:p-6"
    >
      <h2
        className="text-xs font-bold uppercase tracking-widest text-brand"
        id="billing-current-title"
      >
        {t('billing.currentTitle')}
      </h2>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <p className="text-xl font-extrabold tracking-tight text-ink">
          {entitlements.isPaid ? t('billing.planPaid') : t('billing.planFree')}
        </p>
        {subscription === null ? null : (
          <Badge tone={statusTones[subscription.status]}>
            {t(statusLabelKeys[subscription.status])}
          </Badge>
        )}
      </div>

      {isSchoolPaid ? (
        <p className="mt-2 text-sm leading-body text-ink">{t('billing.paidBySchool')}</p>
      ) : null}

      {/*
        `activeUntil` is NULL ON THE FREE TIER, which never lapses — the
        contract says so. Rendering "expires: —" for the majority of accounts
        would suggest something is missing when nothing is.
      */}
      {entitlements.activeUntil === null ? null : (
        <p className="mt-2 text-sm text-muted">
          {subscription?.cancelledAt === null
            ? t('billing.renewsOn', {
                date: formatDayAndMonth(entitlements.activeUntil, language),
              })
            : t('billing.accessUntil', {
                date: formatDayAndMonth(entitlements.activeUntil, language),
              })}
        </p>
      )}

      {subscription?.cancelledAt === null || subscription === null ? null : (
        <p className="mt-2 text-sm font-semibold text-ink">{t('billing.cancelledNote')}</p>
      )}

      {canCancel ? (
        <Button
          className="mt-6"
          disabled={isCancelling}
          onClick={() => {
            setConfirming(true);
          }}
          variant="secondary"
        >
          {t('billing.cancelAction')}
        </Button>
      ) : null}

      {error === undefined ? null : (
        <p className="mt-3 text-sm font-semibold text-danger" role="alert">
          {error}
        </p>
      )}

      <ConfirmDialog
        cancelLabel={t('billing.cancelKeep')}
        confirmLabel={t('billing.cancelConfirm')}
        /*
         * The description states WHAT WILL HAPPEN, including the part people
         * most fear: access continues to the end of the period they paid for.
         * "Are you sure?" would leave them guessing at exactly that.
         */
        description={t('billing.cancelDescription', {
          date:
            entitlements.activeUntil === null
              ? ''
              : formatDayAndMonth(entitlements.activeUntil, language),
        })}
        onCancel={() => {
          setConfirming(false);
        }}
        onConfirm={() => {
          setConfirming(false);
          onCancel();
        }}
        open={confirming}
        title={t('billing.cancelTitle')}
      />
    </section>
  );
}
