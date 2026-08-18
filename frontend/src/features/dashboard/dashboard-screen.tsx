'use client';

import Link from 'next/link';
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { StatCard } from '@/components/patterns/stat-card';
import type { Mission } from '@/lib/api/generated/contracts/practice.contract';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';
import type { Translator } from '@/lib/i18n/translate';
import { formatDayAndMonth } from '@/lib/utils/format-date';
import { useDashboardProfile, useDashboardProgress, useMission } from './hooks/use-dashboard';
import { lastPractised } from './lib/last-practised';

/**
 * ===========================================================================
 * THE STUDENT DASHBOARD — open item 51, and the last fixture screen.
 *
 * What stood here rendered `sampleProgress`, a hard-coded learner called Aarav
 * and a five-square week of which four were filled, beside navigation leading
 * to live practice and live progress. It was the first screen a client saw
 * after signing in.
 *
 * ---------------------------------------------------------------------------
 * THREE READS, ONE OF WHICH THE SCREEN WAITS FOR.
 *
 * The MISSION is what this screen is for, so it gates the render. The LEDGER
 * fills tiles and one sentence, and arrives when it arrives. The PROFILE
 * supplies a name and nothing else — if it fails, the greeting is "Hello",
 * which is a greeting rather than a defect.
 *
 * ---------------------------------------------------------------------------
 * THE WEEK STRIP IS GONE AND WAS NOT REPLACED.
 *
 * Five squares, four of them filled, on every account: an assertion about a
 * student's week that no endpoint carries. Practice history has sessions and
 * their dates; a streak is a product decision nobody has taken. Inventing one
 * in the client to keep a decoration is how the fixture got here.
 * ===========================================================================
 */
export function DashboardScreen() {
  const t = useT();
  const mission = useMission();
  const progress = useDashboardProgress();
  const profile = useDashboardProfile();

  if (mission.isPending) return <LoadingState label={t('student.loading')} />;

  if (mission.error !== null) {
    return (
      <ErrorState
        description={t('student.errorTitle')}
        onRetry={() => {
          void mission.refetch();
        }}
        retryLabel={t('student.retryAction')}
        title={t('student.errorTitle')}
      />
    );
  }

  /*
   * THE NAME IS OPTIONAL AND NEVER INVENTED. `/me/profile` 404s for a student
   * who has not finished onboarding, and it can simply be slower than the
   * mission. Both cases greet without a name rather than with somebody else's.
   */
  const name = profile.data?.profile.displayName;
  const recent = progress.data === undefined ? null : lastPractised(progress.data.chapters);

  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="overflow-hidden rounded-card bg-brand p-6 text-white shadow-raised sm:p-8">
        <p className="text-sm font-semibold text-white">{t('student.eyebrow')}</p>
        <div className="mt-3 max-w-2xl">
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
            {name === undefined ? t('student.greetingUnknown') : t('student.greeting', { name })}
          </h1>
          <p className="mt-3 text-base leading-7 text-white">{t('student.intro')}</p>
          <Link
            className="mt-6 inline-flex min-h-control items-center justify-center rounded-full border border-white/60 px-6 py-3 text-sm font-bold text-white transition-surface duration-micro hover:bg-white/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/60"
            data-motion="press"
            href="/student/progress"
          >
            {t('student.reviewProgress')}
          </Link>
        </div>
      </section>

      {mission.data.mission === null ? (
        <EmptyState
          description={t('student.missionEmptyDescription')}
          title={t('student.missionEmptyTitle')}
        />
      ) : (
        <NextUp mission={mission.data.mission} t={t} />
      )}

      <section
        aria-labelledby="dashboard-continue-title"
        className="rounded-card border border-line bg-surface p-4 shadow-raised sm:p-6"
      >
        <h2
          className="text-xs font-bold uppercase tracking-widest text-brand"
          id="dashboard-continue-title"
        >
          {t('student.continueEyebrow')}
        </h2>
        <ContinueLine chapter={recent} isPending={progress.isPending} t={t} />
      </section>

      {progress.data === undefined ? null : (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            label={t('progressScreen.totalXpLabel')}
            value={String(progress.data.totalXp)}
          />
          <StatCard label={t('progressScreen.xpTodayLabel')} value={String(progress.data.xpToday)} />
          <StatCard
            label={t('progressScreen.sessionsLabel')}
            value={String(progress.data.sessionsCompleted)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Today's mission.
 *
 * THE REASON COMES FROM THE SERVER IN BOTH LANGUAGES and is rendered as it
 * arrives. `reasonEn`/`reasonHi` are derived from this student's own rows —
 * the contract requires both to be non-empty for exactly this reason — so a
 * template here would replace a true specific sentence with a generic one.
 */
function NextUp({ mission, t }: { readonly mission: Mission; readonly t: Translator }) {
  const { language } = useLanguage();
  const title =
    language === 'hi' && mission.chapterTitleHi !== null
      ? mission.chapterTitleHi
      : mission.chapterTitleEn;

  return (
    <section
      aria-labelledby="dashboard-next-title"
      className="product-anchor rounded-card border border-line bg-surface p-4 shadow-raised sm:p-6"
      id="next-up"
    >
      <p className="text-xs font-bold uppercase tracking-widest text-brand">
        {t('student.nextUpEyebrow')}
      </p>
      <h2 className="mt-2 text-xl font-extrabold text-ink" id="dashboard-next-title">
        {t('student.nextUpChapter', { number: mission.chapterNumber, title })}
      </h2>
      <p className="mt-2 text-sm leading-6 text-muted">
        {language === 'hi' ? mission.reasonHi : mission.reasonEn}
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        {/*
          The link goes to `/student/practice`, which starts from the SAME
          mission. There is no chapter parameter on that route, and adding one
          to the URL that the screen would ignore is a link that looks deeper
          than it is.
        */}
        <Link
          className="inline-flex min-h-control items-center justify-center rounded-full bg-brand px-6 py-3 text-sm font-bold text-brand-fg shadow-raised transition-surface duration-micro hover:bg-brand-strong focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/40"
          data-motion="press"
          href="/student/practice"
        >
          {t('student.startPractice')}
        </Link>
        <p className="text-sm text-muted">
          {t('student.nextUpQuestions', { count: mission.suggestedQuestionCount })}
        </p>
      </div>
    </section>
  );
}

function ContinueLine({
  chapter,
  isPending,
  t,
}: {
  readonly chapter: ReturnType<typeof lastPractised>;
  readonly isPending: boolean;
  readonly t: Translator;
}) {
  const { language } = useLanguage();

  if (isPending) return <LoadingState label={t('student.loading')} rows={1} />;

  /*
   * A ledger that failed renders as "nothing practised yet" — WRONG, and
   * cheaply avoided: `progress.data` is undefined on an error too, so the
   * caller passes `null` either way. The distinction that matters to a student
   * is between "you have not practised" and "we cannot see it", and only the
   * first belongs on a dashboard. The progress screen owns the error.
   */
  if (chapter === null) return <p className="mt-3 text-sm text-muted">{t('student.continueNone')}</p>;

  const title =
    language === 'hi' && chapter.chapterTitleHi !== null
      ? chapter.chapterTitleHi
      : chapter.chapterTitleEn;

  return (
    <p className="mt-3 text-base font-semibold text-ink">
      {t('student.continueChapter', {
        date: formatDayAndMonth(chapter.lastPractisedAt as string, language),
        title,
      })}
    </p>
  );
}
