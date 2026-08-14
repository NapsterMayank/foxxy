'use client';

import { StatCard, type StatTrend } from '@/components/patterns/stat-card';
import type { SnapshotResponse } from '@/lib/api/generated/contracts/parent.contract';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';
import type { TranslationKey } from '@/lib/i18n/translate';
import { bilingual } from '../lib/bilingual';

/**
 * ===========================================================================
 * THE WEEKLY SNAPSHOT — §8.7.
 *
 * FOUR COUNTS AND A TREND WORD. There is no score on this response and there
 * must never be one: the contract says "60 percent in Science" is exactly what
 * a parent cannot use, and a field that exists on the wire is a field somebody
 * eventually renders. Scores are read from `practice_sessions` inside the
 * module and never leave it.
 *
 * The headline LABELS come from the server, bilingual, because they describe
 * what was counted and the counting is the server's. Only the trend is worded
 * here, and only because it is a fixed four-value enum.
 * ===========================================================================
 */

/**
 * The trend enum → the shared `StatCard` vocabulary.
 *
 * `less` IS `down` AND NOT A FAILURE. `StatCard`'s own header settles the
 * colour question — a downward trend is `warning`, never `danger`, because a
 * quieter week is a fact about a week and not a verdict on a child. The
 * `trendLabel` sentence is what a screen reader announces; the arrow is
 * decorative, because colour-only status fails for a large slice of this
 * audience.
 */
const trendByKey: Readonly<Record<SnapshotResponse['trend'], StatTrend | undefined>> = {
  more: 'up',
  about_the_same: 'flat',
  less: 'down',
  // A first week has nothing to be a trend against. No arrow at all beats an
  // arrow that implies a comparison the data cannot support.
  first_week: undefined,
};

const trendLabelKeys: Readonly<Record<SnapshotResponse['trend'], TranslationKey>> = {
  more: 'parentDashboard.trendMore',
  about_the_same: 'parentDashboard.trendSame',
  less: 'parentDashboard.trendLess',
  first_week: 'parentDashboard.trendFirstWeek',
};

export interface SnapshotPanelProps {
  readonly snapshot: SnapshotResponse;
}

export function SnapshotPanel({ snapshot }: SnapshotPanelProps) {
  const t = useT();
  const { language } = useLanguage();
  const trend = trendByKey[snapshot.trend];

  return (
    <section aria-labelledby="parent-snapshot-title" className="space-y-4">
      <div>
        <h2
          className="text-xs font-bold uppercase tracking-widest text-brand"
          id="parent-snapshot-title"
        >
          {t('parentDashboard.snapshotTitle')}
        </h2>
        <p className="mt-2 text-base leading-body text-ink">
          {bilingual(snapshot.summary, language)}
        </p>
        <p className="mt-1 text-sm text-muted">{bilingual(snapshot.trendLine, language)}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {snapshot.headlines.map((headline, index) => (
          <StatCard
            key={headline.key}
            label={bilingual(headline.label, language)}
            /*
             * THE TREND SITS ON THE FIRST TILE ONLY. It describes the week as a
             * whole — one enum for the snapshot, not one per count — and
             * repeating the same arrow on four tiles would read as four
             * independent measurements moving together.
             */
            {...(index === 0 && trend !== undefined
              ? { trend, trendLabel: t(trendLabelKeys[snapshot.trend]) }
              : {})}
            value={String(headline.value)}
          />
        ))}
      </div>
    </section>
  );
}
