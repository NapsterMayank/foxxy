import { describe, expect, it } from 'vitest';
import {
  IMPROVEMENT_POINTS,
  STRUGGLING_SCORE,
  improvedChapters,
  pickMisconception,
  strugglingChapters,
  type ChapterWeek,
  type MisconceptionSighting,
} from '../domain/digest-evidence';

function chapter(id: string, overrides: Partial<ChapterWeek> = {}): ChapterWeek {
  return {
    chapterId: id,
    title: { en: `Chapter ${id}`, hi: `अध्याय ${id}` },
    sessions: 2,
    questionsAnswered: 12,
    averageScore: 70,
    priorAverageScore: 50,
    ...overrides,
  };
}

function sighting(code: string, overrides: Partial<MisconceptionSighting> = {}): MisconceptionSighting {
  return {
    code,
    description: 'mass with weight',
    descriptionHi: null,
    chapterTitle: { en: 'Gravitation', hi: 'गुरुत्वाकर्षण' },
    occurrences: 1,
    ...overrides,
  };
}

describe('improvedChapters', () => {
  it('includes a chapter that rose by exactly the threshold', () => {
    const result = improvedChapters([
      chapter('a', { priorAverageScore: 40, averageScore: 40 + IMPROVEMENT_POINTS }),
    ]);
    expect(result.map((c) => c.chapterId)).toEqual(['a']);
  });

  it('excludes a chapter one point below the threshold', () => {
    const result = improvedChapters([
      chapter('a', { priorAverageScore: 40, averageScore: 40 + IMPROVEMENT_POINTS - 1 }),
    ]);
    expect(result).toEqual([]);
  });

  it('excludes a chapter with NO prior score — a first attempt is not an improvement', () => {
    expect(improvedChapters([chapter('a', { priorAverageScore: null, averageScore: 100 })])).toEqual(
      [],
    );
  });

  it('excludes a chapter that went down', () => {
    expect(
      improvedChapters([chapter('a', { priorAverageScore: 90, averageScore: 40 })]),
    ).toEqual([]);
  });

  it('orders by how much it moved, biggest first', () => {
    const result = improvedChapters([
      chapter('small', { priorAverageScore: 50, averageScore: 65 }),
      chapter('big', { priorAverageScore: 20, averageScore: 80 }),
    ]);
    expect(result.map((c) => c.chapterId)).toEqual(['big', 'small']);
  });

  it('breaks ties deterministically, so the same week always reads the same', () => {
    const input = [
      chapter('zeta', { priorAverageScore: 40, averageScore: 70 }),
      chapter('alpha', { priorAverageScore: 40, averageScore: 70 }),
    ];
    expect(improvedChapters(input).map((c) => c.chapterId)).toEqual(['alpha', 'zeta']);
    expect(improvedChapters([...input].reverse()).map((c) => c.chapterId)).toEqual([
      'alpha',
      'zeta',
    ]);
  });

  it('returns nothing for an empty list', () => {
    expect(improvedChapters([])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [chapter('b'), chapter('a')];
    improvedChapters(input);
    expect(input.map((c) => c.chapterId)).toEqual(['b', 'a']);
  });
});

describe('strugglingChapters', () => {
  it('includes a chapter at exactly the boundary', () => {
    expect(
      strugglingChapters([chapter('a', { averageScore: STRUGGLING_SCORE })]).map((c) => c.chapterId),
    ).toEqual(['a']);
  });

  it('excludes a chapter one point above it', () => {
    expect(strugglingChapters([chapter('a', { averageScore: STRUGGLING_SCORE + 1 })])).toEqual([]);
  });

  it('orders hardest first', () => {
    const result = strugglingChapters([
      chapter('mid', { averageScore: 55 }),
      chapter('worst', { averageScore: 10 }),
    ]);
    expect(result.map((c) => c.chapterId)).toEqual(['worst', 'mid']);
  });

  it('breaks ties deterministically', () => {
    const input = [chapter('zeta', { averageScore: 20 }), chapter('alpha', { averageScore: 20 })];
    expect(strugglingChapters(input).map((c) => c.chapterId)).toEqual(['alpha', 'zeta']);
  });

  it('returns nothing for an empty list', () => {
    expect(strugglingChapters([])).toEqual([]);
  });
});

describe('pickMisconception', () => {
  it('returns null when nothing was observed — the common case today (D-077)', () => {
    expect(pickMisconception([])).toBeNull();
  });

  it('picks the most frequent sighting', () => {
    expect(
      pickMisconception([sighting('rare', { occurrences: 1 }), sighting('common', { occurrences: 4 })])
        ?.code,
    ).toBe('common');
  });

  it('breaks a tie on the code, so a week is reported identically on every run', () => {
    const input = [sighting('zeta', { occurrences: 2 }), sighting('alpha', { occurrences: 2 })];
    expect(pickMisconception(input)?.code).toBe('alpha');
    expect(pickMisconception([...input].reverse())?.code).toBe('alpha');
  });

  it('returns ONE, never a list — a parent given three things to fix does none of them', () => {
    const picked = pickMisconception([sighting('a'), sighting('b'), sighting('c')]);
    expect(picked).not.toBeNull();
    expect(Array.isArray(picked)).toBe(false);
  });

  it('does not mutate its input', () => {
    const input = [sighting('b', { occurrences: 1 }), sighting('a', { occurrences: 9 })];
    pickMisconception(input);
    expect(input.map((s) => s.code)).toEqual(['b', 'a']);
  });
});
