'use client';

import { useState } from 'react';
import { ErrorState, LoadingState } from '@/components/patterns/states';
import { useT } from '@/lib/i18n/i18n-provider';
import { CurrentPlan } from './components/current-plan';
import { PlanCard } from './components/plan-card';
import { useBillingStatus, useCancelSubscription, usePlans, useSubscribe } from './hooks/use-billing';
import { billingErrorMessage } from './lib/billing-messages';
import { isFollowableCheckoutUrl } from './lib/checkout-url';

/**
 * ===========================================================================
 * THE BILLING SCREEN — build-order step 13.
 *
 * ---------------------------------------------------------------------------
 * THE STATUS GATES THE PAGE; THE CATALOGUE DOES NOT.
 *
 * A customer who cannot see what they already have must not be shown a row of
 * buy buttons — they would buy a plan they are on, and the backend's 409 would
 * be the first they heard of it. So a failed status is a page-level error.
 *
 * A failed CATALOGUE is different: the current plan still renders, because
 * "what am I paying for" is answerable without knowing what else is for sale.
 * ===========================================================================
 */
export function BillingScreen() {
  const t = useT();
  const status = useBillingStatus();
  const plans = usePlans();
  const subscribe = useSubscribe();
  const cancel = useCancelSubscription();

  /** Set when a checkout came back with a URL this client will not follow. */
  const [checkoutRefused, setCheckoutRefused] = useState(false);

  if (status.isPending) return <LoadingState label={t('billing.loading')} />;

  if (status.error !== null) {
    return (
      <ErrorState
        description={billingErrorMessage(status.error, t)}
        onRetry={() => {
          void status.refetch();
        }}
        retryLabel={t('billing.retryAction')}
        title={t('billing.errorTitle')}
      />
    );
  }

  const currentCode = status.data.subscription?.planCode ?? null;
  const isSchoolPaid = status.data.subscription?.payer.kind === 'school';

  function choose(planCode: string): void {
    setCheckoutRefused(false);
    subscribe.mutate(
      { planCode },
      {
        onSuccess: (response) => {
          /*
           * THE ONLY EXTERNAL NAVIGATION IN THE PRODUCT. `checkoutUrl` is a
           * plain `z.string()` on the contract, so the schema has not
           * established that it is safe to follow — see `checkout-url.ts`.
           *
           * `assign` and not `replace`: the customer must be able to press back
           * out of a payment page and land here rather than on whatever
           * preceded it.
           */
          if (!isFollowableCheckoutUrl(response.checkoutUrl)) {
            setCheckoutRefused(true);
            return;
          }
          window.location.assign(response.checkoutUrl);
        },
      },
    );
  }

  const subscribeError = checkoutRefused
    ? t('billing.errorCheckoutUnavailable')
    : subscribe.error === null
      ? null
      : billingErrorMessage(subscribe.error, t, { fallback: 'billing.errorCheckoutFailed' });

  return (
    <div className="space-y-6 sm:space-y-8">
      <CurrentPlan
        error={cancel.error === null ? undefined : billingErrorMessage(cancel.error, t)}
        isCancelling={cancel.isPending}
        onCancel={() => {
          cancel.mutate();
        }}
        status={status.data}
      />

      {/*
        A SCHOOL-PAID SEAT IS SHOWN NO PRICES AT ALL. The contract's whole
        reason for carrying `payer.kind` is that such a student "must not be
        shown 'you will be charged ₹299'" — and a catalogue below their status
        is that sentence in a different font.
      */}
      {isSchoolPaid ? null : (
        <section aria-labelledby="billing-plans-title">
          <h2
            className="text-xs font-bold uppercase tracking-widest text-brand"
            id="billing-plans-title"
          >
            {t('billing.plansTitle')}
          </h2>

          {plans.isPending ? (
            <LoadingState className="mt-3" label={t('billing.loading')} rows={2} />
          ) : plans.error !== null ? (
            <ErrorState
              className="mt-3"
              description={billingErrorMessage(plans.error, t)}
              onRetry={() => {
                void plans.refetch();
              }}
              retryLabel={t('billing.retryAction')}
              title={t('billing.errorPlansTitle')}
            />
          ) : (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              {plans.data.plans.map((plan) => (
                <PlanCard
                  isCurrent={plan.code === currentCode}
                  isPending={subscribe.isPending}
                  key={plan.code}
                  onChoose={choose}
                  plan={plan}
                />
              ))}
            </div>
          )}

          {subscribeError === null ? null : (
            <p className="mt-4 text-sm font-semibold text-danger" role="alert">
              {subscribeError}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
