import { describe, expect, it } from 'vitest';
import { DIGEST_LINE_COUNT, composeDigest } from '../domain/digest-content';
import { checkDigestHonesty } from '../domain/digest-honesty';
import type {
  ChapterWeek,
  DigestEvidence,
  MisconceptionSighting,
} from '../domain/digest-evidence';
import { EMPTY_WEEK, type WeekActivity } from '../domain/snapshot';

const WEEK_START = new Date('2026-06-01T00:00:00.000Z');

function activity(overrides: Partial<WeekActivity> = {}): WeekActivity {
  return { sessions: 3, questionsAnswered: 18, chaptersTouched: 2, daysPractised: 3, ...overrides };
}

function chapter(id: string, overrides: Partial<ChapterWeek> = {}): ChapterWeek {
  return {
    chapterId: id,
    title: { en: 'The Human Eye', hi: 'मानव नेत्र' },
    sessions: 2,
    questionsAnswered: 12,
    averageScore: 70,
    priorAverageScore: 70,
    ...overrides,
  };
}

function evidence(overrides: Partial<DigestEvidence> = {}): DigestEvidence {
  return {
    weekStart: WEEK_START,
    activity: activity(),
    chapters: [chapter('a')],
    misconceptions: [],
    recoveries: 0,
    hintsUsed: 0,
    ...overrides,
  };
}

const MISCONCEPTION: MisconceptionSighting = {
  code: 'MASS_WEIGHT',
  description: 'mass with weight',
  descriptionHi: 'द्रव्यमान और भार',
  chapterTitle: { en: 'Gravitation', hi: 'गुरुत्वाकर्षण' },
  occurrences: 3,
};

function allText(draft: ReturnType<typeof composeDigest>): string[] {
  return [
    ...draft.lines.flatMap((line) => [line.en, line.hi]),
    draft.suggestedAction.en,
    draft.suggestedAction.hi,
  ];
}

describe('composeDigest — shape', () => {
  it('always produces exactly five lines', () => {
    for (const input of [
      evidence(),
      evidence({ activity: EMPTY_WEEK, chapters: [] }),
      evidence({ misconceptions: [MISCONCEPTION] }),
    ]) {
      expect(composeDigest(input).lines).toHaveLength(DIGEST_LINE_COUNT);
    }
  });

  it('produces both languages on every line and on the action', () => {
    const draft = composeDigest(evidence({ misconceptions: [MISCONCEPTION] }));
    for (const text of allText(draft)) {
      expect(text.trim().length).toBeGreaterThan(0);
    }
    for (const line of draft.lines) {
      expect(line.hi).toMatch(/[ऀ-ॿ]/);
    }
    expect(draft.suggestedAction.hi).toMatch(/[ऀ-ॿ]/);
  });

  it('is deterministic — the same evidence produces byte-identical text', () => {
    const input = evidence({ misconceptions: [MISCONCEPTION], recoveries: 2, hintsUsed: 4 });
    expect(JSON.stringify(composeDigest(input))).toBe(JSON.stringify(composeDigest(input)));
  });
});

describe('composeDigest — NEVER a percentage', () => {
  it('emits no percentage, score or "n out of m" for any evidence', () => {
    const cases = [
      evidence(),
      evidence({ activity: EMPTY_WEEK, chapters: [] }),
      evidence({ misconceptions: [MISCONCEPTION] }),
      evidence({ chapters: [chapter('a', { averageScore: 100, priorAverageScore: 10 })] }),
      evidence({ chapters: [chapter('a', { averageScore: 5, priorAverageScore: null })] }),
      evidence({ recoveries: 3, hintsUsed: 7 }),
    ];
    for (const input of cases) {
      for (const text of allText(composeDigest(input))) {
        expect(text).not.toMatch(/%/);
        expect(text).not.toMatch(/per\s?cent/i);
        expect(text).not.toMatch(/प्रतिशत/);
        expect(text).not.toMatch(/\bout of\b/i);
      }
      // And the gate agrees, for every one of them.
      expect(checkDigestHonesty(composeDigest(input), input)).toEqual([]);
    }
  });
});

describe('composeDigest — the misconception is named when one was observed', () => {
  it('names the misconception and ties the action to it', () => {
    const input = evidence({ misconceptions: [MISCONCEPTION] });
    const draft = composeDigest(input);

    expect(draft.misconceptionCode).toBe('MASS_WEIGHT');
    expect(draft.lines[3]?.en).toContain('mass with weight');
    expect(draft.lines[3]?.en).toContain('Gravitation');
    expect(draft.suggestedAction.en).toContain('mass with weight');
    // A concrete action, not a sentiment.
    expect(draft.suggestedAction.en).toMatch(/^Ask them to explain/);
  });

  it('falls back to the English description inside the Hindi line when no Hindi exists', () => {
    // `misconception_patterns` HAS NO HINDI COLUMN (D-098, open item 14). One
    // English clause beats silence about the only line that matters.
    const noHindi: MisconceptionSighting = { ...MISCONCEPTION, descriptionHi: null };
    const draft = composeDigest(evidence({ misconceptions: [noHindi] }));
    expect(draft.lines[3]?.hi).toContain('mass with weight');
    expect(draft.lines[3]?.hi).toMatch(/[ऀ-ॿ]/);
  });

  it('names ONE misconception even when several were seen', () => {
    const draft = composeDigest(
      evidence({
        misconceptions: [
          MISCONCEPTION,
          { ...MISCONCEPTION, code: 'OTHER', description: 'speed with velocity', occurrences: 1 },
        ],
      }),
    );
    expect(draft.misconceptionCode).toBe('MASS_WEIGHT');
    expect(draft.lines[3]?.en).not.toContain('speed with velocity');
  });
});

/**
 * THE D-077 CASE — and the most important test in this file.
 *
 * `distractor_misconceptions` is NULL corpus-wide, so this is what almost every
 * real week looks like today.
 */
describe('composeDigest — a week with NO misconception data', () => {
  it('says what improved instead, and invents nothing', () => {
    const draft = composeDigest(
      evidence({
        misconceptions: [],
        chapters: [chapter('a', { priorAverageScore: 40, averageScore: 80 })],
      }),
    );

    expect(draft.misconceptionCode).toBeNull();
    expect(draft.lines[3]?.en).toMatch(/have not spotted a specific mix-up/i);
    expect(draft.lines[3]?.en).toContain('The Human Eye');
  });

  it('never claims a mix-up it did not observe, in any shape', () => {
    const inputs = [
      evidence({ misconceptions: [] }),
      evidence({ misconceptions: [], chapters: [chapter('a', { averageScore: 0 })] }),
      evidence({ misconceptions: [], activity: EMPTY_WEEK, chapters: [] }),
    ];
    for (const input of inputs) {
      const draft = composeDigest(input);
      expect(draft.misconceptionCode).toBeNull();
      expect(checkDigestHonesty(draft, input)).toEqual([]);
    }
  });

  it('credits a recovery when there is nothing else to celebrate', () => {
    const draft = composeDigest(
      evidence({ chapters: [chapter('a', { averageScore: 70, priorAverageScore: 70 })], recoveries: 2 }),
    );
    expect(draft.lines[1]?.en).toContain('changed their mind');
  });

  it('mentions hints rather than a diagnosis when hints were the only signal', () => {
    const draft = composeDigest(evidence({ hintsUsed: 3, chapters: [chapter('a')] }));
    expect(draft.lines[3]?.en).toMatch(/3 hints/);
  });

  it('uses the singular for a single hint', () => {
    const draft = composeDigest(evidence({ hintsUsed: 1, chapters: [chapter('a')] }));
    expect(draft.lines[3]?.en).toMatch(/1 hint,/);
  });

  it('uses the singular for a single recovery', () => {
    const draft = composeDigest(evidence({ recoveries: 1, chapters: [chapter('a')] }));
    expect(draft.lines[1]?.en).toMatch(/1 time —/);
  });
});

describe('composeDigest — a week with no activity', () => {
  it('produces a graceful five-line message rather than an empty digest', () => {
    const input = evidence({ activity: EMPTY_WEEK, chapters: [] });
    const draft = composeDigest(input);

    expect(draft.lines).toHaveLength(DIGEST_LINE_COUNT);
    expect(draft.lines[0]?.en).toMatch(/did not finish a practice session/i);
    expect(draft.lines[2]?.en).toMatch(/cannot say what is giving them trouble/i);
    expect(draft.suggestedAction.en).toMatch(/ten-minute slot/i);
    for (const text of allText(draft)) {
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('composeDigest — no name ever appears', () => {
  it('addresses the parent about "your child", never by name', () => {
    // The digest text is what a real LLM adapter would be asked to write, and
    // `platform/llm`'s port forbids the model ever seeing a name. A digest
    // carrying one could not be handed to the writer port at all.
    const draft = composeDigest(evidence({ misconceptions: [MISCONCEPTION] }));
    expect(draft.lines[0]?.en).toContain('Your child');
    for (const text of allText(draft)) {
      expect(text).not.toMatch(/\bAsha\b|\bRahul\b/);
    }
  });
});

describe('composeDigest — the struggling chapter drives the action', () => {
  it('asks the parent to sit with them on the hardest chapter', () => {
    const draft = composeDigest(
      evidence({ chapters: [chapter('a', { averageScore: 30, priorAverageScore: 30 })] }),
    );
    expect(draft.lines[2]?.en).toContain('The Human Eye');
    expect(draft.suggestedAction.en).toMatch(/^Sit with them for ten minutes/);
  });

  it('asks them to teach it back when nothing looked hard', () => {
    const draft = composeDigest(
      evidence({ chapters: [chapter('a', { averageScore: 95, priorAverageScore: 95 })] }),
    );
    expect(draft.lines[2]?.en).toMatch(/Nothing looked especially hard/i);
    expect(draft.suggestedAction.en).toMatch(/^Ask them to teach you/);
  });

  it('falls back to a planning action when there are sessions but no chapters', () => {
    // Defensive: a session whose chapter row could not be resolved.
    const draft = composeDigest(evidence({ chapters: [] }));
    expect(draft.suggestedAction.en).toMatch(/put it in the calendar together/i);
    expect(draft.lines[1]?.en).toMatch(/nothing new from this week/i);
  });
});
