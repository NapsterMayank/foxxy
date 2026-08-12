import { describe, expect, it } from 'vitest';
import { RRF_K, fuse, maxFusedScore, minFusedScore } from '../domain/reciprocal-rank-fusion';

describe('reciprocal rank fusion', () => {
  it('uses constant 60, as §8.4 specifies', () => {
    expect(RRF_K).toBe(60);
  });

  it('scores a document by 1 / (k + rank) in each list it appears in', () => {
    const [top] = fuse(['a'], []);

    expect(top?.fusedScore).toBeCloseTo(1 / 61, 12);
  });

  it('RANKS A DOCUMENT IN BOTH LISTS ABOVE ONE IN ONLY EITHER', () => {
    /**
     * §8.4's stated test, and the property k = 60 exists to produce.
     *
     * `both` is SECOND in each list — beaten in both — while `denseOnly` and
     * `sparseOnly` are FIRST in one. Agreement still wins, because appearing
     * in a second list is worth ~1/61 while moving from rank 2 to rank 1 is
     * worth ~1/61 - 1/62, sixty times less.
     */
    const fused = fuse(['denseOnly', 'both'], ['sparseOnly', 'both']);

    expect(fused[0]?.id).toBe('both');
    expect(fused[0]?.denseRank).toBe(2);
    expect(fused[0]?.sparseRank).toBe(2);
    expect(fused.slice(1).map((candidate) => candidate.id).sort()).toEqual([
      'denseOnly',
      'sparseOnly',
    ]);
  });

  it('still ranks a both-list document first when it is LAST in both', () => {
    // The strong form of the same property, and the one that would break if k
    // were small. At k = 1 a rank-50 pair would lose to a rank-1 single.
    const dense = Array.from({ length: 50 }, (_unused, index) => `d${String(index)}`);
    const sparse = Array.from({ length: 50 }, (_unused, index) => `s${String(index)}`);
    dense[49] = 'both';
    sparse[49] = 'both';

    expect(fuse(dense, sparse)[0]?.id).toBe('both');
  });

  it('records which list each candidate came from, and null for the other', () => {
    const fused = fuse(['a'], ['b']);
    const a = fused.find((candidate) => candidate.id === 'a');
    const b = fused.find((candidate) => candidate.id === 'b');

    expect(a).toMatchObject({ denseRank: 1, sparseRank: null });
    expect(b).toMatchObject({ denseRank: null, sparseRank: 1 });
  });

  it('returns an empty list when both halves are empty', () => {
    expect(fuse([], [])).toEqual([]);
  });

  it('handles one empty half without dropping the other', () => {
    expect(fuse([], ['only']).map((candidate) => candidate.id)).toEqual(['only']);
  });

  it('scores a repeated id ONCE, at its first position', () => {
    // A half that repeats an id is a defect upstream, but scoring the repeat
    // would double-count one document into a top-3 that only has three slots.
    const fused = fuse(['a', 'a', 'b'], []);

    expect(fused).toHaveLength(2);
    expect(fused[0]?.id).toBe('a');
    expect(fused[0]?.fusedScore).toBeCloseTo(1 / 61, 12);
    expect(fused[1]?.denseRank).toBe(3);
  });

  it('breaks ties deterministically, so two runs cannot disagree', () => {
    // Equal scores, opposite input orders. Without the explicit tie-break the
    // survivor of a top-N cut would depend on Map iteration order, and a
    // result that is not reproducible cannot be debugged from its own trace.
    const one = fuse(['x', 'y'], []).map((candidate) => candidate.id);
    const two = fuse(['x', 'y'], []).map((candidate) => candidate.id);
    const flipped = fuse(['y'], ['x']).map((candidate) => candidate.id);

    expect(one).toEqual(two);
    expect(flipped).toEqual(['x', 'y']);
  });

  it('sorts strictly descending by fused score', () => {
    const fused = fuse(['a', 'b', 'c'], ['c', 'b']);
    const scores = fused.map((candidate) => candidate.fusedScore);

    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
  });
});

describe('the bounds a threshold must live inside', () => {
  it('caps at 2 / (k + 1) — rank one in both lists', () => {
    expect(maxFusedScore()).toBeCloseTo(2 / 61, 12);
    expect(fuse(['a'], ['a'])[0]?.fusedScore).toBeCloseTo(maxFusedScore(), 12);
  });

  it('floors at 1 / (k + limit) — last place in exactly one list', () => {
    const dense = Array.from({ length: 50 }, (_unused, index) => `d${String(index)}`);

    expect(minFusedScore(50)).toBeCloseTo(1 / 110, 12);
    expect(fuse(dense, [])[49]?.fusedScore).toBeCloseTo(minFusedScore(50), 12);
  });

  it('puts the whole scale far below any cosine-similarity number', () => {
    /**
     * THE PREVIOUS SYSTEM'S BUG, as an assertion. Its floor was a cosine
     * similarity of order 0.7 applied to fused scores that cannot exceed
     * 0.0328 — so every query abstained, for a year, silently. Any future
     * threshold pulled from a similarity scale fails this by two orders of
     * magnitude.
     */
    expect(maxFusedScore()).toBeLessThan(0.05);
  });
});
