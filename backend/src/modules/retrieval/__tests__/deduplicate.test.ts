import { describe, expect, it } from 'vitest';
import {
  deduplicateByText,
  hashChunkText,
  normaliseChunkText,
} from '../domain/deduplicate';

const PASSAGE =
  'The least distance of distinct vision is 25 cm for a normal human eye.';

function candidate(id: string, chunkText: string, fusedScore: number): {
  id: string;
  chunkText: string;
  fusedScore: number;
} {
  return { id, chunkText, fusedScore };
}

describe('chunk text normalisation', () => {
  it('folds case', () => {
    expect(normaliseChunkText('Photosynthesis')).toBe(normaliseChunkText('photosynthesis'));
  });

  it('collapses whitespace, including newlines the extractor left behind', () => {
    expect(normaliseChunkText('a  b\n\tc ')).toBe('a b c');
  });

  it('does NOT strip punctuation', () => {
    // Anything wider than case and whitespace starts merging passages that
    // differ in ways a student would notice. "25 cm." and "25 cm" are the same
    // passage; "f = ma" and "f = m/a" are not.
    expect(normaliseChunkText('f = ma')).not.toBe(normaliseChunkText('f = m/a'));
  });

  it('hashes equal normalised text to the same digest, and different text apart', () => {
    expect(hashChunkText('The  SAME passage')).toBe(hashChunkText('the same passage'));
    expect(hashChunkText('one passage')).not.toBe(hashChunkText('another passage'));
  });
});

describe('deduplication — D-108, a quarter of the corpus', () => {
  it('collapses exact duplicate passages and RECORDS HOW MANY', () => {
    const result = deduplicateByText([
      candidate('a', PASSAGE, 0.03),
      candidate('b', PASSAGE, 0.02),
      candidate('c', 'A completely different passage about friction.', 0.01),
    ]);

    expect(result.kept.map((kept) => kept.id)).toEqual(['a', 'c']);
    expect(result.duplicatesCollapsed).toBe(1);
  });

  it('counts REMOVALS, not groups — three copies is two collapsed', () => {
    // The trace has to reconcile against the candidate count. Counting groups
    // would report 1 for a fused list that shrank by 2, and the arithmetic in
    // the trace would silently stop adding up.
    const result = deduplicateByText([
      candidate('a', PASSAGE, 0.03),
      candidate('b', PASSAGE, 0.02),
      candidate('c', PASSAGE, 0.01),
    ]);

    expect(result.duplicatesCollapsed).toBe(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.collapsedIds).toEqual(['b', 'c']);
  });

  it('keeps the HIGHEST-SCORING instance', () => {
    const result = deduplicateByText([
      candidate('low', PASSAGE, 0.01),
      candidate('high', PASSAGE, 0.03),
    ]);

    expect(result.kept.map((kept) => kept.id)).toEqual(['high']);
    expect(result.groups[0]?.keptId).toBe('high');
  });

  it('keeps the highest even when the input is NOT sorted', () => {
    /**
     * The property is of this function, not of its caller. The caller does
     * hand fused output in descending order today — but "keep the highest"
     * held only by that convention would break silently the day somebody
     * deduplicates an unsorted list, and the wrong copy would survive with
     * nothing failing.
     */
    const result = deduplicateByText([
      candidate('mid', PASSAGE, 0.02),
      candidate('low', PASSAGE, 0.01),
      candidate('high', PASSAGE, 0.03),
    ]);

    expect(result.kept.map((kept) => kept.id)).toEqual(['high']);
  });

  it('treats two copies differing only in whitespace and case as one', () => {
    // Which is what D-108's duplicates look like once an extractor has been
    // through them twice under two chapter-title conventions.
    const result = deduplicateByText([
      candidate('a', PASSAGE, 0.03),
      candidate('b', `  ${PASSAGE.toUpperCase()}  `, 0.02),
    ]);

    expect(result.duplicatesCollapsed).toBe(1);
  });

  it('collapses nothing when every passage is distinct', () => {
    const result = deduplicateByText([
      candidate('a', 'one', 0.03),
      candidate('b', 'two', 0.02),
    ]);

    expect(result.duplicatesCollapsed).toBe(0);
    expect(result.groups).toEqual([]);
  });

  it('handles an empty candidate list', () => {
    expect(deduplicateByText([])).toEqual({ kept: [], duplicatesCollapsed: 0, groups: [] });
  });

  it('preserves fused order among the survivors', () => {
    const result = deduplicateByText([
      candidate('first', 'alpha', 0.03),
      candidate('dup', 'alpha', 0.025),
      candidate('second', 'beta', 0.02),
    ]);

    expect(result.kept.map((kept) => kept.id)).toEqual(['first', 'second']);
  });
});
