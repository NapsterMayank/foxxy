import { describe, expect, it } from 'vitest';
import { EVIDENCE_LABELS } from '@/lib/api/generated/constants/practice';
import { EVIDENCE_ASCENDING, evidenceRank } from '../lib/evidence-order';

describe('the evidence rank', () => {
  /*
   * `EVIDENCE_LABELS` is generated and its order is the DECLARATION order of a
   * closed set, with `strong` first. A step bar built straight from it fills
   * backwards: "Not assessed yet" would light every segment.
   */
  it('is not the generated declaration order', () => {
    expect(EVIDENCE_LABELS[0]).toBe('strong');
    expect(EVIDENCE_ASCENDING[0]).toBe('not_assessed');
  });

  it('runs weakest to strongest', () => {
    expect([...EVIDENCE_ASCENDING]).toEqual([
      'not_assessed',
      'needs_another_session',
      'developing',
      'strong',
    ]);
  });

  it('covers every generated label, so nothing renders as rank zero by accident', () => {
    expect(EVIDENCE_ASCENDING).toHaveLength(EVIDENCE_LABELS.length);
    for (const label of EVIDENCE_LABELS) {
      expect(EVIDENCE_ASCENDING).toContain(label);
    }
  });

  it('ranks each label at its own position', () => {
    for (const [index, label] of EVIDENCE_ASCENDING.entries()) {
      expect(evidenceRank(label)).toBe(index);
    }
  });
});
