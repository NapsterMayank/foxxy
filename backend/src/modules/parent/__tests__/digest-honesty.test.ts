import { describe, expect, it } from 'vitest';
import type { BilingualText } from '@/platform/notify-channel/index';
import { DIGEST_LINE_COUNT, composeDigest, type DigestDraft } from '../domain/digest-content';
import { DIGEST_VIOLATIONS, checkDigestHonesty } from '../domain/digest-honesty';
import type { DigestEvidence, MisconceptionSighting } from '../domain/digest-evidence';
import { EMPTY_WEEK } from '../domain/snapshot';

const WEEK_START = new Date('2026-06-01T00:00:00.000Z');

const SIGHTING: MisconceptionSighting = {
  code: 'MASS_WEIGHT',
  description: 'mass with weight',
  descriptionHi: 'द्रव्यमान और भार',
  chapterTitle: { en: 'Gravitation', hi: 'गुरुत्वाकर्षण' },
  occurrences: 2,
};

function evidence(overrides: Partial<DigestEvidence> = {}): DigestEvidence {
  return {
    weekStart: WEEK_START,
    activity: EMPTY_WEEK,
    chapters: [],
    misconceptions: [],
    recoveries: 0,
    hintsUsed: 0,
    ...overrides,
  };
}

function line(en: string, hi = 'ठीक है।'): BilingualText {
  return { en, hi };
}

function draft(overrides: Partial<DigestDraft> = {}): DigestDraft {
  return {
    lines: Array.from({ length: DIGEST_LINE_COUNT }, (_unused, index) => line(`Line ${index}.`)),
    misconceptionCode: null,
    suggestedAction: line('Sit with them for ten minutes.'),
    ...overrides,
  };
}

describe('checkDigestHonesty — an honest draft', () => {
  it('finds nothing wrong with what the composer produces', () => {
    const input = evidence({ misconceptions: [SIGHTING] });
    expect(checkDigestHonesty(composeDigest(input), input)).toEqual([]);
  });

  it('finds nothing wrong with the minimal hand-built draft', () => {
    expect(checkDigestHonesty(draft(), evidence())).toEqual([]);
  });
});

describe('checkDigestHonesty — the percentage rule (§8.7)', () => {
  const rejected = ['She got 60%', 'sixty per cent', 'उसने 60 प्रतिशत पाए', '4 out of 6', '4/6 right', 'She scored well', 'good marks'];

  for (const text of rejected) {
    it(`refuses a line reading ${JSON.stringify(text)}`, () => {
      const violations = checkDigestHonesty(draft({ lines: [line(text), line('b'), line('c'), line('d'), line('e')] }), evidence());
      expect(violations).toContain(DIGEST_VIOLATIONS.PERCENTAGE);
    });
  }

  it('refuses a percentage in the ACTION as readily as in a line', () => {
    expect(
      checkDigestHonesty(draft({ suggestedAction: line('Aim for 80% next week.') }), evidence()),
    ).toContain(DIGEST_VIOLATIONS.PERCENTAGE);
  });

  it('refuses a percentage hidden in the HINDI half', () => {
    expect(
      checkDigestHonesty(
        draft({ lines: [{ en: 'Fine.', hi: 'उन्हें 60 प्रतिशत मिले।' }, line('b'), line('c'), line('d'), line('e')] }),
        evidence(),
      ),
    ).toContain(DIGEST_VIOLATIONS.PERCENTAGE);
  });

  it('ALLOWS bare counts — "3 days" and "24 questions" are the whole point', () => {
    expect(
      checkDigestHonesty(
        draft({ lines: [line('They practised on 3 days and answered 24 questions.'), line('b'), line('c'), line('d'), line('e')] }),
        evidence(),
      ),
    ).toEqual([]);
  });
});

describe('checkDigestHonesty — the jargon rule', () => {
  for (const text of ['Their mastery improved', 'IRT says so', "Bloom's level 3", 'ease factor rose', 'top percentile', 'cognitive load']) {
    it(`refuses ${JSON.stringify(text)}`, () => {
      expect(
        checkDigestHonesty(draft({ lines: [line(text), line('b'), line('c'), line('d'), line('e')] }), evidence()),
      ).toContain(DIGEST_VIOLATIONS.JARGON);
    });
  }
});

describe('checkDigestHonesty — a misconception must have been OBSERVED', () => {
  it('accepts a code that appears in the evidence', () => {
    expect(
      checkDigestHonesty(draft({ misconceptionCode: 'MASS_WEIGHT' }), evidence({ misconceptions: [SIGHTING] })),
    ).toEqual([]);
  });

  it('REFUSES a code that appears nowhere in the evidence', () => {
    expect(
      checkDigestHonesty(draft({ misconceptionCode: 'MASS_WEIGHT' }), evidence({ misconceptions: [] })),
    ).toContain(DIGEST_VIOLATIONS.INVENTED_MISCONCEPTION);
  });

  it('REFUSES a code that is plausible but is not the one observed', () => {
    expect(
      checkDigestHonesty(
        draft({ misconceptionCode: 'SPEED_VELOCITY' }),
        evidence({ misconceptions: [SIGHTING] }),
      ),
    ).toContain(DIGEST_VIOLATIONS.INVENTED_MISCONCEPTION);
  });

  it('accepts a null code even when a misconception WAS observed', () => {
    // Naming none is always allowed. Naming a wrong one never is.
    expect(
      checkDigestHonesty(draft({ misconceptionCode: null }), evidence({ misconceptions: [SIGHTING] })),
    ).toEqual([]);
  });
});

describe('checkDigestHonesty — shape rules', () => {
  it('refuses four lines', () => {
    expect(
      checkDigestHonesty(draft({ lines: [line('a'), line('b'), line('c'), line('d')] }), evidence()),
    ).toContain(DIGEST_VIOLATIONS.LINE_COUNT);
  });

  it('refuses six lines', () => {
    expect(
      checkDigestHonesty(
        draft({ lines: [line('a'), line('b'), line('c'), line('d'), line('e'), line('f')] }),
        evidence(),
      ),
    ).toContain(DIGEST_VIOLATIONS.LINE_COUNT);
  });

  it('refuses an empty English line', () => {
    expect(
      checkDigestHonesty(draft({ lines: [line('   '), line('b'), line('c'), line('d'), line('e')] }), evidence()),
    ).toContain(DIGEST_VIOLATIONS.EMPTY_LINE);
  });

  it('refuses an empty Hindi line — the shape a skipped translation actually has', () => {
    expect(
      checkDigestHonesty(
        draft({ lines: [{ en: 'Fine.', hi: '' }, line('b'), line('c'), line('d'), line('e')] }),
        evidence(),
      ),
    ).toContain(DIGEST_VIOLATIONS.MISSING_HINDI);
  });

  it('refuses a blank action', () => {
    const violations = checkDigestHonesty(draft({ suggestedAction: { en: '', hi: '' } }), evidence());
    expect(violations).toContain(DIGEST_VIOLATIONS.MISSING_ACTION);
  });

  it('reports every violation, not just the first', () => {
    const violations = checkDigestHonesty(
      draft({
        lines: [line('Mastery at 60%'), line('b'), line('c')],
        misconceptionCode: 'NOPE',
        suggestedAction: { en: '', hi: '' },
      }),
      evidence(),
    );
    expect(new Set(violations)).toEqual(
      new Set([
        DIGEST_VIOLATIONS.LINE_COUNT,
        DIGEST_VIOLATIONS.PERCENTAGE,
        DIGEST_VIOLATIONS.JARGON,
        DIGEST_VIOLATIONS.INVENTED_MISCONCEPTION,
        DIGEST_VIOLATIONS.MISSING_ACTION,
        DIGEST_VIOLATIONS.EMPTY_LINE,
        DIGEST_VIOLATIONS.MISSING_HINDI,
      ]),
    );
  });
});
