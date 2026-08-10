import { describe, expect, it } from 'vitest';
import { RECOVERY_WRONG_STREAK, decideNext, type AnswerEvidence } from '../domain/decide-next';

/**
 * The client's Screen 7 branch — every arm, both sides of the streak threshold,
 * and the fifth arm the brief does not mention.
 */

function evidence(overrides: Partial<AnswerEvidence> = {}): AnswerEvidence {
  return {
    isCorrect: true,
    confidence: 'confident',
    answerChanged: false,
    misconceptionCode: null,
    consecutiveWrongInChapter: 0,
    ...overrides,
  };
}

describe('decideNext — correct, confident, consistent', () => {
  it('advances', () => {
    expect(decideNext(evidence())).toEqual({ decision: 'advance', misconceptionCode: null });
  });

  it('advances when confidence was never asked', () => {
    // NULL IS NOT UNCERTAINTY. Treating an unasked question as doubt would put a
    // confirmation question in front of every student on every screen that has
    // not adopted the confidence prompt — which is most of them.
    expect(decideNext(evidence({ confidence: null })).decision).toBe('advance');
  });
});

describe('decideNext — correct but uncertain', () => {
  it('asks for confirmation when the student said unsure', () => {
    expect(decideNext(evidence({ confidence: 'unsure' })).decision).toBe('confirm');
  });

  it('asks for confirmation at the middle confidence too', () => {
    expect(decideNext(evidence({ confidence: 'unsure_ish' })).decision).toBe('confirm');
  });

  it('asks for confirmation when the student changed their answer', () => {
    // Right mark, but they also showed the misconception on the way. One
    // confirmation question is cheaper than waiting for the next session.
    expect(decideNext(evidence({ answerChanged: true })).decision).toBe('confirm');
  });

  it('carries no misconception code on the confirm branch', () => {
    expect(decideNext(evidence({ confidence: 'unsure' })).misconceptionCode).toBeNull();
  });
});

describe('decideNext — incorrect with a known misconception', () => {
  it('remediates the named misconception', () => {
    expect(
      decideNext(evidence({ isCorrect: false, misconceptionCode: 'confuses_mass_weight' })),
    ).toEqual({ decision: 'remediate_misconception', misconceptionCode: 'confuses_mass_weight' });
  });

  it('trims the code rather than shipping whitespace into a lookup', () => {
    expect(
      decideNext(evidence({ isCorrect: false, misconceptionCode: '  unit_step  ' }))
        .misconceptionCode,
    ).toBe('unit_step');
  });
});

describe('decideNext — incorrect with NO misconception code (the common case today)', () => {
  it('remediates generally, and says so', () => {
    // D-077: `distractor_misconceptions` is NULL on all 2,741 imported
    // questions. If this returned `remediate_misconception` the funnel would
    // report targeted remediation firing, the metric would look healthy, and
    // nobody would ever author the codes that would make it true.
    expect(decideNext(evidence({ isCorrect: false })).decision).toBe('remediate_general');
  });

  it('treats an empty or whitespace code as no code', () => {
    expect(decideNext(evidence({ isCorrect: false, misconceptionCode: '' })).decision).toBe(
      'remediate_general',
    );
    expect(decideNext(evidence({ isCorrect: false, misconceptionCode: '   ' })).decision).toBe(
      'remediate_general',
    );
  });
});

describe('decideNext — repeated difficulty', () => {
  it('does NOT flag one below the streak threshold', () => {
    expect(
      decideNext(
        evidence({ isCorrect: false, consecutiveWrongInChapter: RECOVERY_WRONG_STREAK - 1 }),
      ).decision,
    ).toBe('remediate_general');
  });

  it('flags for recovery AT the streak threshold', () => {
    expect(
      decideNext(evidence({ isCorrect: false, consecutiveWrongInChapter: RECOVERY_WRONG_STREAK }))
        .decision,
    ).toBe('flag_for_recovery');
  });

  it('OUTRANKS a known misconception', () => {
    // Remediating a known misconception is the right move once. Three times in a
    // row it is the wrong altitude — the student needs somebody to notice.
    expect(
      decideNext(
        evidence({
          isCorrect: false,
          misconceptionCode: 'confuses_mass_weight',
          consecutiveWrongInChapter: RECOVERY_WRONG_STREAK,
        }),
      ).decision,
    ).toBe('flag_for_recovery');
  });

  it('does not flag a CORRECT answer, however long the previous streak', () => {
    expect(
      decideNext(evidence({ isCorrect: true, consecutiveWrongInChapter: 10 })).decision,
    ).toBe('advance');
  });
});

describe('decideNext — rejects impossible input', () => {
  it('rejects a negative streak', () => {
    expect(() => decideNext(evidence({ consecutiveWrongInChapter: -1 }))).toThrow(RangeError);
  });

  it('rejects a fractional streak', () => {
    expect(() => decideNext(evidence({ consecutiveWrongInChapter: 1.5 }))).toThrow(RangeError);
  });
});
