import { describe, expect, it } from 'vitest';
import { EVIDENCE_LABELS } from '@/shared/constants/practice';
import {
  ATTEMPTS_FOR_STRONG,
  DEVELOPING_MASTERY,
  STRONG_MASTERY,
  evidenceLabel,
} from '../domain/evidence';

/**
 * "evidence labels at each boundary" — and the rule underneath them: the answer
 * is one of four words and NEVER a percentage.
 */

describe('evidenceLabel — the four labels and nothing else', () => {
  it('only ever returns a value from the shared union', () => {
    for (let mastery = 0; mastery <= 1.0001; mastery += 0.05) {
      for (const attempts of [0, 1, 2, 9]) {
        const label = evidenceLabel(Math.min(1, mastery), attempts);
        expect(EVIDENCE_LABELS).toContain(label);
      }
    }
  });

  it('NEVER returns a number or a percentage-shaped string', () => {
    const label: string = evidenceLabel(0.87, 5);
    expect(label).not.toMatch(/\d/);
    expect(label).not.toMatch(/%/);
  });
});

describe('evidenceLabel — not_assessed', () => {
  it('reports not_assessed when nothing has been attempted', () => {
    expect(evidenceLabel(0, 0)).toBe('not_assessed');
  });

  it('reports not_assessed even for a high stored mastery with no attempts', () => {
    // An untouched chapter and a failed one are very different conversations.
    expect(evidenceLabel(0.95, 0)).toBe('not_assessed');
  });
});

describe('evidenceLabel — the strong boundary', () => {
  it('is strong AT the threshold with enough attempts', () => {
    expect(evidenceLabel(STRONG_MASTERY, ATTEMPTS_FOR_STRONG)).toBe('strong');
  });

  it('is developing just BELOW the threshold', () => {
    expect(evidenceLabel(STRONG_MASTERY - 0.01, ATTEMPTS_FOR_STRONG)).toBe('developing');
  });

  it('is strong at a perfect mastery', () => {
    expect(evidenceLabel(1, 5)).toBe('strong');
  });

  it('REFUSES to call one good session strong', () => {
    // One good session is evidence of one good session. This is the only place
    // `attempts` changes the answer; without it the parameter is decoration.
    expect(evidenceLabel(1, 1)).toBe('developing');
  });
});

describe('evidenceLabel — the developing boundary', () => {
  it('is developing AT the threshold', () => {
    expect(evidenceLabel(DEVELOPING_MASTERY, 3)).toBe('developing');
  });

  it('needs another session just BELOW the threshold', () => {
    expect(evidenceLabel(DEVELOPING_MASTERY - 0.01, 3)).toBe('needs_another_session');
  });

  it('needs another session at zero mastery with attempts behind it', () => {
    expect(evidenceLabel(0, 2)).toBe('needs_another_session');
  });
});

describe('evidenceLabel — rejects impossible input rather than clamping', () => {
  it('rejects mastery above 1', () => {
    // Clamping here would mask a clamping failure upstream, and this output is
    // what a parent reads.
    expect(() => evidenceLabel(1.4, 3)).toThrow(RangeError);
  });

  it('rejects negative mastery', () => {
    expect(() => evidenceLabel(-0.1, 3)).toThrow(RangeError);
  });

  it('rejects a negative attempt count', () => {
    expect(() => evidenceLabel(0.5, -1)).toThrow(RangeError);
  });

  it('rejects a fractional attempt count', () => {
    expect(() => evidenceLabel(0.5, 1.5)).toThrow(RangeError);
  });
});
