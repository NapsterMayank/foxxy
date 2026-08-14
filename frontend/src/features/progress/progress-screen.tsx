'use client';

import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { StatCard } from '@/components/patterns/stat-card';
import type { HistoryEntry } from '@/lib/api/generated/contracts/practice.contract';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';
import { formatDayAndMonth } from '@/lib/utils/format-date';
import { ChapterEvidenceList } from './components/chapter-evidence-list';
import { usePracticeHistory, useProgress } from './hooks/use-progress';

/**
 * ===========================================================================
 * THE PROGRESS SCREEN — build-order step 11.
 *
 * ---------------------------------------------------------------------------
 * XP IS A NUMBER; EVIDENCE IS A WORD. That split is the whole screen and it is
 * §9.1 made concrete.
 *
 * XP counts what a student DID — sessions finished, questions answered — and a
 * number is the honest form of that. Evidence describes what it SHOWS, and the
 * client forbids a percentage there: "Developing" is something a student and a
 * parent can act on, where 63% is a rank invitation.
 *
 * `ProgressResponse` makes the split structural. There is no `masteryPercent`
 * on it to render even carelessly — the contract says so and says why.
 * ===========================================================================
 */
export function ProgressScreen() {
  const t = useT();
  const progress = useProgress();
  const history = usePracticeHistory();

  if (progress.isPending) return <LoadingState label={t('progressScreen.loading')} />;

  if (progress.error !== null) {
    return (
      <ErrorState
        description={t('practice.errorGeneric')}
        onRetry={() => {
          void progress.refetch();
        }}
        retryLabel={t('progressScreen.retryAction')}
        title={t('progressScreen.errorTitle')}
      />
    );
  }

  const { chapters, sessionsCompleted, totalXp, xpToday } = progress.data;

  /*
   * EMPTY IS "NO SESSIONS", NOT "NO CHAPTERS" — §10.4's "empty state before any
   * practice". A student who has subjects but has never practised HAS chapters,
   * every one of them `not_assessed`, and a grid of four grey badges is a worse
   * answer to "how am I doing" than one sentence saying to go and practise.
   */
  if (sessionsCompleted === 0) {
    return (
      <EmptyState
        description={t('progressScreen.emptyDescription')}
        title={t('progressScreen.emptyTitle')}
      />
    );
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={t('progressScreen.totalXpLabel')} value={String(totalXp)} />
        <StatCard label={t('progressScreen.xpTodayLabel')} value={String(xpToday)} />
        <StatCard label={t('progressScreen.sessionsLabel')} value={String(sessionsCompleted)} />
      </div>

      {chapters.length === 0 ? null : <ChapterEvidenceList chapters={chapters} />}

      <HistoryList entries={history.data?.sessions ?? []} isPending={history.isPending} />
    </div>
  );
}

/**
 * Recent sessions.
 *
 * ITS OWN LOADING STATE, and it is not allowed to block the screen. History and
 * progress are two requests; gating the XP tiles on the slower one would hide
 * numbers that had already arrived. A failed history is rendered as nothing at
 * all rather than as an error — it is supporting detail, and an error banner
 * for it would suggest the figures above are also suspect.
 */
function HistoryList({
  entries,
  isPending,
}: {
  readonly entries: readonly HistoryEntry[];
  readonly isPending: boolean;
}) {
  const t = useT();
  const { language } = useLanguage();

  if (isPending) return <LoadingState label={t('progressScreen.loading')} rows={2} />;
  if (entries.length === 0) return null;

  return (
    <section aria-labelledby="progress-history-title">
      <h2
        className="text-xs font-bold uppercase tracking-widest text-muted"
        id="progress-history-title"
      >
        {t('progressScreen.historyTitle')}
      </h2>

      <ul className="mt-3 space-y-2">
        {entries.map((entry) => (
          <li
            className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-surface p-4"
            key={entry.sessionId}
          >
            <div>
              <p className="font-semibold text-ink">
                {language === 'hi' && entry.chapterTitleHi !== null
                  ? entry.chapterTitleHi
                  : entry.chapterTitleEn}
              </p>
              <p className="text-sm text-muted">
                {formatDayAndMonth(entry.submittedAt ?? entry.startedAt, language)}
              </p>
            </div>

            {/*
              Three states, and the invalid one is worded as "did not count"
              rather than as a score of zero. A zero is a judgement about the
              answers; the truth is that the attempt was not counted at all.
            */}
            <p className="text-sm font-semibold text-brand-strong">
              {entry.submittedAt === null
                ? t('progressScreen.historyPending')
                : entry.isValid === false
                  ? t('progressScreen.historyInvalid')
                  : t('progressScreen.historyScore', { xp: entry.xpAwarded ?? 0 })}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
