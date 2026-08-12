import { describe, expect, it } from 'vitest';
import { FixedClock } from '@/platform/clock/index';
import { WEAK_CHAPTER_MASTERY, chooseMission, type MissionCandidate } from '../domain/mission';

/**
 * Today's Mission — the priority order, and the property that matters most:
 * THE REASON IS DERIVED FROM THE CANDIDATE'S OWN DATA.
 *
 * The last describe block is the one to read. It asserts that the chapter title
 * and the number behind the choice actually appear in the reason string, in both
 * languages — which is the difference between "we picked this for you" and a
 * mission a student has a reason to trust.
 */

const clock = new FixedClock('2026-06-10T09:00:00.000Z');

function candidate(overrides: Partial<MissionCandidate> = {}): MissionCandidate {
  return {
    chapterId: 'chapter-1',
    chapterNumber: 1,
    chapterTitleEn: 'The Human Eye',
    chapterTitleHi: 'मानव नेत्र',
    subjectCode: 'science',
    dueAt: null,
    masteryScore: null,
    attempts: 0,
    ...overrides,
  };
}

describe('chooseMission — nothing to choose from', () => {
  it('returns null rather than manufacturing a mission', () => {
    expect(chooseMission([], clock.now())).toBeNull();
  });
});

describe('chooseMission — priority 1: a due review outranks everything', () => {
  it('picks the overdue chapter over a weaker one', () => {
    const due = candidate({
      chapterId: 'due',
      chapterTitleEn: 'Light',
      dueAt: new Date('2026-06-07T09:00:00.000Z'),
      masteryScore: 0.9,
      attempts: 4,
    });
    const weak = candidate({ chapterId: 'weak', masteryScore: 0.1, attempts: 3 });

    expect(chooseMission([weak, due], clock.now())?.chapterId).toBe('due');
  });

  it('picks the MOST overdue when several are due', () => {
    const recent = candidate({
      chapterId: 'recent',
      dueAt: new Date('2026-06-09T09:00:00.000Z'),
      attempts: 2,
      masteryScore: 0.9,
    });
    const ancient = candidate({
      chapterId: 'ancient',
      dueAt: new Date('2026-06-01T09:00:00.000Z'),
      attempts: 2,
      masteryScore: 0.9,
    });

    expect(chooseMission([recent, ancient], clock.now())?.chapterId).toBe('ancient');
  });

  it('does NOT treat a future due date as due', () => {
    const future = candidate({
      chapterId: 'future',
      dueAt: new Date('2026-06-20T09:00:00.000Z'),
      masteryScore: 0.95,
      attempts: 3,
    });
    const unstarted = candidate({ chapterId: 'unstarted', chapterNumber: 5 });

    expect(chooseMission([future, unstarted], clock.now())?.chapterId).toBe('unstarted');
  });

  it('treats a due date of exactly now as due', () => {
    const exactly = candidate({
      chapterId: 'exactly',
      dueAt: new Date('2026-06-10T09:00:00.000Z'),
      masteryScore: 0.9,
      attempts: 2,
    });
    expect(chooseMission([exactly], clock.now())?.reason).toBe('due_review');
  });
});

describe('chooseMission — priority 2: the weakest chapter', () => {
  it('picks the lowest mastery below the bar', () => {
    const middling = candidate({ chapterId: 'middling', masteryScore: 0.5, attempts: 2 });
    const worst = candidate({ chapterId: 'worst', masteryScore: 0.2, attempts: 2 });
    const unstarted = candidate({ chapterId: 'unstarted', chapterNumber: 2 });

    expect(chooseMission([middling, worst, unstarted], clock.now())?.chapterId).toBe('worst');
  });

  it('includes a chapter exactly AT the weakness bar', () => {
    const atBar = candidate({
      chapterId: 'at-bar',
      masteryScore: WEAK_CHAPTER_MASTERY,
      attempts: 2,
    });
    const unstarted = candidate({ chapterId: 'unstarted', chapterNumber: 2 });

    expect(chooseMission([atBar, unstarted], clock.now())?.chapterId).toBe('at-bar');
  });

  it('excludes a chapter just ABOVE the bar', () => {
    const aboveBar = candidate({
      chapterId: 'above-bar',
      masteryScore: WEAK_CHAPTER_MASTERY + 0.01,
      attempts: 2,
    });
    const unstarted = candidate({ chapterId: 'unstarted', chapterNumber: 2 });

    expect(chooseMission([aboveBar, unstarted], clock.now())?.chapterId).toBe('unstarted');
  });
});

describe('chooseMission — priority 3: next in the syllabus', () => {
  it('picks the lowest-numbered unstarted chapter', () => {
    const later = candidate({ chapterId: 'later', chapterNumber: 9 });
    const earlier = candidate({ chapterId: 'earlier', chapterNumber: 3 });

    expect(chooseMission([later, earlier], clock.now())?.chapterId).toBe('earlier');
  });

  it('reports next_in_syllabus as the reason', () => {
    expect(chooseMission([candidate()], clock.now())?.reason).toBe('next_in_syllabus');
  });
});

describe('chooseMission — nothing owed', () => {
  it('says so plainly rather than inventing a reason', () => {
    const strong = candidate({ masteryScore: 0.95, attempts: 4 });
    const mission = chooseMission([strong], clock.now());
    expect(mission?.reason).toBe('nothing_available');
    expect(mission?.evidence).toBe('strong');
  });
});

describe('chooseMission — THE REASON IS DERIVED FROM REAL DATA', () => {
  it('names the chapter and the days overdue on a due review', () => {
    const due = candidate({
      chapterTitleEn: 'The Human Eye',
      chapterTitleHi: 'मानव नेत्र',
      dueAt: new Date('2026-06-07T09:00:00.000Z'),
      masteryScore: 0.9,
      attempts: 3,
    });
    const mission = chooseMission([due], clock.now());

    expect(mission?.reasonEn).toContain('The Human Eye');
    expect(mission?.reasonEn).toContain('3 days');
    expect(mission?.reasonHi).toContain('मानव नेत्र');
    expect(mission?.reasonHi).toContain('3');
  });

  it('says "due today" rather than "0 days overdue"', () => {
    const due = candidate({
      dueAt: new Date('2026-06-10T09:00:00.000Z'),
      masteryScore: 0.9,
      attempts: 3,
    });
    expect(chooseMission([due], clock.now())?.reasonEn).toMatch(/due today/i);
  });

  it('uses the singular for one day', () => {
    const due = candidate({
      dueAt: new Date('2026-06-09T09:00:00.000Z'),
      masteryScore: 0.9,
      attempts: 3,
    });
    expect(chooseMission([due], clock.now())?.reasonEn).toContain('1 day overdue');
  });

  it('names the chapter and the attempt count on a weak chapter', () => {
    const weak = candidate({ chapterTitleEn: 'Acids and Bases', masteryScore: 0.2, attempts: 2 });
    const mission = chooseMission([weak], clock.now());

    expect(mission?.reasonEn).toContain('Acids and Bases');
    expect(mission?.reasonEn).toContain('2 attempts');
  });

  it('names the evidence LABEL and never a percentage', () => {
    const weak = candidate({ masteryScore: 0.2, attempts: 3 });
    const mission = chooseMission([weak], clock.now());

    expect(mission?.reasonEn).not.toContain('%');
    expect(mission?.reasonEn).not.toContain('20');
    expect(mission?.reasonEn).toMatch(/needs another session/);
  });

  it('names the chapter number on a next-in-syllabus mission', () => {
    const next = candidate({ chapterNumber: 7, chapterTitleEn: 'Sound' });
    const mission = chooseMission([next], clock.now());

    expect(mission?.reasonEn).toContain('Sound');
    expect(mission?.reasonEn).toContain('chapter 7');
    expect(mission?.reasonHi).toContain('7');
  });

  it('ALWAYS produces both languages, non-empty (P7)', () => {
    const cases: MissionCandidate[][] = [
      [candidate({ dueAt: new Date('2026-06-01T09:00:00.000Z'), masteryScore: 0.9, attempts: 2 })],
      [candidate({ masteryScore: 0.2, attempts: 2 })],
      [candidate()],
      [candidate({ masteryScore: 0.99, attempts: 5 })],
    ];

    for (const candidates of cases) {
      const mission = chooseMission(candidates, clock.now());
      expect(mission?.reasonEn.length ?? 0).toBeGreaterThan(0);
      expect(mission?.reasonHi.length ?? 0).toBeGreaterThan(0);
      // Devanagari really is present, rather than English echoed into the Hindi
      // slot — the failure mode a "both strings are non-empty" test misses.
      expect(mission?.reasonHi).toMatch(/[ऀ-ॿ]/);
    }
  });

  it('falls back to the English title when no Hindi title exists', () => {
    // 9 of the 137 imported chapters carry a placeholder title and some carry no
    // Hindi at all. Falling back is better than a mission that names nothing.
    const noHindi = candidate({ chapterTitleHi: null, chapterTitleEn: 'Motion' });
    expect(chooseMission([noHindi], clock.now())?.reasonHi).toContain('Motion');
  });
});
