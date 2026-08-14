import type { Metadata } from 'next';
import { ParentDashboard } from '@/features/parent-dashboard/parent-dashboard';
import { getServerT } from '@/lib/i18n/server';

export const metadata: Metadata = {
  title: 'Parent dashboard',
};

/**
 * Build-order step 12.
 *
 * THE FIXTURES ARE GONE. This page rendered a `ChildSummary` built from a
 * hard-coded child, a hard-coded parent name and two invented "recent updates" —
 * a placeholder from before the `parent` module was reachable. Everything it
 * stood in for is now on the wire (`GET /parent/children` and the four
 * per-child endpoints), and a sample dashboard beside a real one is a screen
 * nobody can tell is lying.
 */
export default async function ParentDashboardPage() {
  const t = await getServerT();

  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="overflow-hidden rounded-card bg-brand p-6 text-white shadow-raised sm:p-8">
        <p className="text-sm font-semibold text-white">{t('parent.eyebrow')}</p>
        <div className="mt-3 max-w-2xl">
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
            {t('parent.title')}
          </h1>
          <p className="mt-3 text-base leading-7 text-white">{t('parent.intro')}</p>
        </div>
      </section>

      <ParentDashboard />
    </div>
  );
}
