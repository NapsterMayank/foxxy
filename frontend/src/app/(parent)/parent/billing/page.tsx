import type { Metadata } from 'next';
import { BillingScreen } from '@/features/billing/billing-screen';
import { getServerT } from '@/lib/i18n/server';

export const metadata: Metadata = {
  title: 'Your plan',
};

/**
 * Build-order step 13.
 *
 * ===========================================================================
 * UNDER `(parent)` AND NOT UNDER `(student)`, AND THAT IS A SCOPE DECISION
 * RATHER THAN A ROUTING ONE.
 *
 * The billing contract is explicit that "nothing in this file says a parent
 * pays" — the product may ship B2C or as a school pilot, and that is unresolved.
 * What IS settled is that every billing endpoint resolves the subject from the
 * session, so whoever holds the session sees their own plan.
 *
 * The parent is the payer in the B2C story, so the screen ships there. A
 * STUDENT ON A SCHOOL-PAID SEAT therefore has nowhere to see that fact yet —
 * recorded as an open item rather than solved by adding a fifth item to a
 * mobile bottom navigation on a guess about who pays.
 * ===========================================================================
 */
export default async function BillingPage() {
  const t = await getServerT();

  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="rounded-card bg-brand p-6 text-white shadow-raised sm:p-8">
        <p className="text-sm font-semibold text-white">{t('billing.eyebrow')}</p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">
          {t('billing.title')}
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-white">{t('billing.description')}</p>
      </section>

      <BillingScreen />
    </div>
  );
}
