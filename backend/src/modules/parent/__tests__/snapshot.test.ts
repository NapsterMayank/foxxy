import { describe, expect, it } from 'vitest';
import {
  EMPTY_WEEK,
  TREND_THRESHOLD_DAYS,
  buildSnapshot,
  type WeekActivity,
} from '../domain/snapshot';

/** A week, stated field by field so no test depends on a default. */
function week(overrides: Partial<WeekActivity> = {}): WeekActivity {
  return { sessions: 3, questionsAnswered: 18, chaptersTouched: 2, daysPractised: 3, ...overrides };
}

const WEEK_START = new Date('2026-06-01T00:00:00.000Z');

describe('buildSnapshot — the four headline numbers', () => {
  it('reports exactly four headlines', () => {
    const snapshot = buildSnapshot({ weekStart: WEEK_START, activity: week(), previous: null });
    expect(snapshot.headlines).toHaveLength(4);
  });

  it('carries the counts it was given, unchanged', () => {
    const snapshot = buildSnapshot({
      weekStart: WEEK_START,
      activity: week({ sessions: 5, questionsAnswered: 31, chaptersTouched: 4, daysPractised: 4 }),
      previous: null,
    });
    expect(Object.fromEntries(snapshot.headlines.map((h) => [h.key, h.value]))).toEqual({
      days_practised: 4,
      sessions: 5,
      questions_answered: 31,
      chapters_touched: 4,
    });
  });

  it('labels every headline in BOTH languages', () => {
    const snapshot = buildSnapshot({ weekStart: WEEK_START, activity: week(), previous: null });
    for (const headline of snapshot.headlines) {
      expect(headline.label.en.length).toBeGreaterThan(0);
      expect(headline.label.hi.length).toBeGreaterThan(0);
      // Devanagari, not the English string copied across.
      expect(headline.label.hi).toMatch(/[ऀ-ॿ]/);
    }
  });
});

describe('buildSnapshot — the one trend', () => {
  it('reports `first_week` when there is no previous week at all', () => {
    const snapshot = buildSnapshot({ weekStart: WEEK_START, activity: week(), previous: null });
    expect(snapshot.trend).toBe('first_week');
  });

  it('distinguishes "no previous week" from "a previous week with nothing in it"', () => {
    const noHistory = buildSnapshot({ weekStart: WEEK_START, activity: week(), previous: null });
    const quietHistory = buildSnapshot({
      weekStart: WEEK_START,
      activity: week({ daysPractised: 3 }),
      previous: EMPTY_WEEK,
    });
    expect(noHistory.trend).toBe('first_week');
    expect(quietHistory.trend).toBe('more');
  });

  it('reports `more` at exactly the threshold', () => {
    const snapshot = buildSnapshot({
      weekStart: WEEK_START,
      activity: week({ daysPractised: 2 + TREND_THRESHOLD_DAYS }),
      previous: week({ daysPractised: 2 }),
    });
    expect(snapshot.trend).toBe('more');
  });

  it('reports `about_the_same` one day below the threshold', () => {
    const snapshot = buildSnapshot({
      weekStart: WEEK_START,
      activity: week({ daysPractised: 2 + TREND_THRESHOLD_DAYS - 1 }),
      previous: week({ daysPractised: 2 }),
    });
    expect(snapshot.trend).toBe('about_the_same');
  });

  it('reports `less` at exactly the negative threshold', () => {
    const snapshot = buildSnapshot({
      weekStart: WEEK_START,
      activity: week({ daysPractised: 1 }),
      previous: week({ daysPractised: 1 + TREND_THRESHOLD_DAYS }),
    });
    expect(snapshot.trend).toBe('less');
  });

  it('reports `about_the_same` for an identical week', () => {
    const snapshot = buildSnapshot({
      weekStart: WEEK_START,
      activity: week(),
      previous: week(),
    });
    expect(snapshot.trend).toBe('about_the_same');
  });

  it('gives every trend its own bilingual sentence', () => {
    const cases: { activity: WeekActivity; previous: WeekActivity | null }[] = [
      { activity: week({ daysPractised: 5 }), previous: week({ daysPractised: 1 }) },
      { activity: week({ daysPractised: 1 }), previous: week({ daysPractised: 5 }) },
      { activity: week(), previous: week() },
      { activity: week(), previous: null },
    ];
    const lines = cases.map(
      (input) => buildSnapshot({ weekStart: WEEK_START, ...input }).trendLine.en,
    );
    expect(new Set(lines).size).toBe(4);
    for (const input of cases) {
      const snapshot = buildSnapshot({ weekStart: WEEK_START, ...input });
      expect(snapshot.trendLine.hi).toMatch(/[ऀ-ॿ]/);
    }
  });
});

describe('buildSnapshot — a quiet week says so', () => {
  it('states in words that nothing happened, rather than showing four zeroes', () => {
    const snapshot = buildSnapshot({
      weekStart: WEEK_START,
      activity: EMPTY_WEEK,
      previous: week(),
    });
    expect(snapshot.summary.en).toMatch(/did not practise/i);
    expect(snapshot.summary.hi).toMatch(/[ऀ-ॿ]/);
    expect(snapshot.headlines.every((headline) => headline.value === 0)).toBe(true);
  });

  it('uses the singular for one day', () => {
    const snapshot = buildSnapshot({
      weekStart: WEEK_START,
      activity: week({ daysPractised: 1, chaptersTouched: 1 }),
      previous: null,
    });
    expect(snapshot.summary.en).toContain('1 day ');
    expect(snapshot.summary.en).toContain('1 chapter.');
  });

  it('uses the plural for more than one', () => {
    const snapshot = buildSnapshot({
      weekStart: WEEK_START,
      activity: week({ daysPractised: 4, chaptersTouched: 3 }),
      previous: null,
    });
    expect(snapshot.summary.en).toContain('4 days');
    expect(snapshot.summary.en).toContain('3 chapters');
  });
});

/**
 * §8.7's whole argument, as an assertion: plain language, never education
 * jargon, and never a percentage.
 */
describe('buildSnapshot — plain language only', () => {
  const forbidden = [/%/, /per\s?cent/i, /\bmastery\b/i, /\bBloom/i, /\bIRT\b/, /\bpercentile\b/i];

  it('produces no percentage and no jargon in any text it emits', () => {
    for (const activity of [EMPTY_WEEK, week(), week({ daysPractised: 7, sessions: 12 })]) {
      const snapshot = buildSnapshot({ weekStart: WEEK_START, activity, previous: week() });
      const strings = [
        snapshot.summary.en,
        snapshot.summary.hi,
        snapshot.trendLine.en,
        snapshot.trendLine.hi,
        ...snapshot.headlines.flatMap((headline) => [headline.label.en, headline.label.hi]),
      ];
      for (const text of strings) {
        for (const pattern of forbidden) {
          expect(text).not.toMatch(pattern);
        }
      }
    }
  });
});
