import { describe, expect, it } from 'vitest';
import type { ChapterProgress } from '@/lib/api/generated/contracts/practice.contract';
import { lastPractised } from '../lib/last-practised';

function chapter(overrides: Partial<ChapterProgress> & { chapterId: string }): ChapterProgress {
  return {
    chapterTitleEn: 'Chapter',
    chapterTitleHi: null,
    evidence: 'not_assessed',
    attempts: 0,
    lastPractisedAt: null,
    nextReviewAt: null,
    ...overrides,
  } as ChapterProgress;
}

describe('lastPractised', () => {
  it('is null when nothing has been practised', () => {
    expect(lastPractised([])).toBeNull();
    expect(lastPractised([chapter({ chapterId: 'a' })])).toBeNull();
  });

  it('ignores chapters that were never practised', () => {
    const practised = chapter({ chapterId: 'b', lastPractisedAt: '2026-08-10T09:00:00.000Z' });

    expect(lastPractised([chapter({ chapterId: 'a' }), practised])).toBe(practised);
  });

  it('takes the most recent, whatever the order in the list', () => {
    const older = chapter({ chapterId: 'a', lastPractisedAt: '2026-08-10T09:00:00.000Z' });
    const newer = chapter({ chapterId: 'b', lastPractisedAt: '2026-08-12T09:00:00.000Z' });

    expect(lastPractised([newer, older])).toBe(newer);
    expect(lastPractised([older, newer])).toBe(newer);
  });

  it('keeps the first of two identical timestamps, so the screen is stable', () => {
    const first = chapter({ chapterId: 'a', lastPractisedAt: '2026-08-12T09:00:00.000Z' });
    const second = chapter({ chapterId: 'b', lastPractisedAt: '2026-08-12T09:00:00.000Z' });

    expect(lastPractised([first, second])).toBe(first);
    expect(lastPractised([second, first])).toBe(second);
  });
});
