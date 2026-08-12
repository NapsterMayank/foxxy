import type { BilingualText } from '@/platform/notify-channel/index';

/**
 * THE PARENT SNAPSHOT — four headline numbers and one trend.
 *
 * ===========================================================================
 * PLAIN LANGUAGE, NEVER EDUCATION JARGON, AND NEVER A PERCENTAGE.
 *
 * Every number here is a COUNT OF SOMETHING A PARENT CAN PICTURE: days their
 * child sat down, questions they answered, chapters they worked on, sessions
 * they finished. Not "mastery", not "IRT theta", not "retention interval", not
 * "60% in Science" — §8.7 is explicit that the last of those is what every
 * competitor ships and that it tells a parent nothing they can act on.
 *
 * The words `mastery`, `evidence label`, `spaced retention` and `Bloom` appear
 * nowhere in the text this file produces. A test asserts that, because jargon
 * arrives one helpful clarification at a time.
 * ===========================================================================
 *
 * ONE TREND, NOT FOUR. Comparing every number to last week produces a wall of
 * arrows that a parent reads as noise. The single comparison is "did they sit
 * down more often than last week", because days practised is the only one of
 * the four a parent can directly influence.
 *
 * Bilingual at the point of construction (P7): both strings are built here,
 * together, from the same numbers — never an English string plus a translation
 * step that can be skipped.
 *
 * Pure: no I/O, no clock (`now` is an argument where it is needed at all), no
 * randomness.
 */

/**
 * What actually happened in one week, counted from real rows.
 *
 * Assembled by the repository from `practice_sessions` and
 * `practice_responses`. Every field is a COUNT — there is no score, no
 * percentage and no mastery figure on this type, so no rendering of it can
 * accidentally show one.
 */
export interface WeekActivity {
  /** Submitted sessions. An abandoned session is not an achievement. */
  readonly sessions: number;
  readonly questionsAnswered: number;
  readonly chaptersTouched: number;
  /** Distinct UTC dates with at least one submitted session. */
  readonly daysPractised: number;
}

export const EMPTY_WEEK: WeekActivity = Object.freeze({
  sessions: 0,
  questionsAnswered: 0,
  chaptersTouched: 0,
  daysPractised: 0,
});

/**
 * The one comparison a snapshot makes.
 *
 * `first_week` rather than `same` when there is nothing to compare against —
 * "no change" and "no previous week" look identical to a reader and mean
 * completely different things.
 */
export const SNAPSHOT_TRENDS = ['more', 'about_the_same', 'less', 'first_week'] as const;
export type SnapshotTrend = (typeof SNAPSHOT_TRENDS)[number];

/** One headline number, with the plain words that explain it. */
export interface SnapshotHeadline {
  readonly key: 'days_practised' | 'sessions' | 'questions_answered' | 'chapters_touched';
  readonly value: number;
  readonly label: BilingualText;
}

export interface ChildSnapshot {
  /** Midnight UTC on the Monday this snapshot covers. */
  readonly weekStart: Date;
  readonly headlines: readonly SnapshotHeadline[];
  readonly trend: SnapshotTrend;
  /** One sentence a parent can read without any of the numbers. */
  readonly summary: BilingualText;
  readonly trendLine: BilingualText;
}

/**
 * A trend needs a difference worth mentioning.
 *
 * One extra day is noise — a Sunday that fell on the other side of a Monday.
 * Two is a pattern. Without this, almost every week reports a change and the
 * trend stops carrying information.
 */
export const TREND_THRESHOLD_DAYS = 2;

function trendOf(current: WeekActivity, previous: WeekActivity | null): SnapshotTrend {
  // NOTHING TO COMPARE AGAINST. Said plainly rather than reported as "the
  // same", which would claim a measurement that was never taken.
  if (previous === null) return 'first_week';

  const difference = current.daysPractised - previous.daysPractised;
  if (difference >= TREND_THRESHOLD_DAYS) return 'more';
  if (difference <= -TREND_THRESHOLD_DAYS) return 'less';
  return 'about_the_same';
}

function pluralDaysEn(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * The summary sentence.
 *
 * THE QUIET-WEEK BRANCH IS THE IMPORTANT ONE. A week with nothing in it must
 * say so, in words, rather than rendering four zeroes and letting the parent
 * work it out. "Zero, zero, zero, zero" is a system reporting on itself; "they
 * did not open the app this week" is a fact somebody can act on this evening.
 */
function summaryOf(activity: WeekActivity): BilingualText {
  if (activity.sessions === 0) {
    return {
      en: 'Your child did not practise at all this week.',
      hi: 'आपके बच्चे ने इस सप्ताह बिल्कुल अभ्यास नहीं किया।',
    };
  }

  return {
    en:
      `Your child practised on ${pluralDaysEn(activity.daysPractised)} this week and ` +
      `answered ${activity.questionsAnswered} questions across ${activity.chaptersTouched} ` +
      `${activity.chaptersTouched === 1 ? 'chapter' : 'chapters'}.`,
    hi:
      `आपके बच्चे ने इस सप्ताह ${activity.daysPractised} दिन अभ्यास किया और ` +
      `${activity.chaptersTouched} अध्यायों में ${activity.questionsAnswered} प्रश्न हल किए।`,
  };
}

function trendLineOf(trend: SnapshotTrend): BilingualText {
  switch (trend) {
    case 'more':
      return {
        en: 'They sat down more often than last week.',
        hi: 'उन्होंने पिछले सप्ताह से ज़्यादा बार बैठकर अभ्यास किया।',
      };
    case 'less':
      return {
        en: 'They sat down less often than last week.',
        hi: 'उन्होंने पिछले सप्ताह से कम बार बैठकर अभ्यास किया।',
      };
    case 'about_the_same':
      return {
        en: 'That is about the same as last week.',
        hi: 'यह लगभग पिछले सप्ताह जितना ही है।',
      };
    case 'first_week':
      // HONEST ABOUT HAVING NO HISTORY. The alternative — showing "no change"
      // in a family's first week — is a comparison with nothing, presented as
      // a comparison with something.
      return {
        en: 'This is the first week we have anything to show.',
        hi: 'यह पहला सप्ताह है जिसका हमारे पास कोई ब्योरा है।',
      };
  }
}

/**
 * Builds the snapshot.
 *
 * `previous` is null when the child has no earlier week at all — which is a
 * different statement from a previous week in which they did nothing, and the
 * two produce different trends.
 */
export function buildSnapshot(input: {
  readonly weekStart: Date;
  readonly activity: WeekActivity;
  readonly previous: WeekActivity | null;
}): ChildSnapshot {
  const { activity } = input;
  const trend = trendOf(activity, input.previous);

  return {
    weekStart: input.weekStart,
    trend,
    summary: summaryOf(activity),
    trendLine: trendLineOf(trend),
    headlines: [
      {
        key: 'days_practised',
        value: activity.daysPractised,
        label: { en: 'Days they practised', hi: 'अभ्यास के दिन' },
      },
      {
        key: 'sessions',
        value: activity.sessions,
        label: { en: 'Practice sessions finished', hi: 'पूरे किए गए अभ्यास सत्र' },
      },
      {
        key: 'questions_answered',
        value: activity.questionsAnswered,
        label: { en: 'Questions answered', hi: 'हल किए गए प्रश्न' },
      },
      {
        key: 'chapters_touched',
        value: activity.chaptersTouched,
        label: { en: 'Chapters they worked on', hi: 'जिन अध्यायों पर काम किया' },
      },
    ],
  };
}
