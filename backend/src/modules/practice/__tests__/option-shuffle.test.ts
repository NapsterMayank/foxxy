import { describe, expect, it } from 'vitest';
import {
  applyShuffle,
  assertShuffleMap,
  buildShuffle,
  identityShuffle,
  toCanonicalIndex,
  toPresentationIndex,
} from '../domain/option-shuffle';

/**
 * D-058 — the canonical index.
 *
 * ===========================================================================
 * THE TEST THAT MATTERS HERE IS THE ONE WITH A SHUFFLE THAT ACTUALLY REORDERS.
 *
 * A translation test against the identity permutation passes whether or not the
 * translation exists, because `map[i] === i`. That is not a hypothetical
 * weakness: it is the exact shape a shuffle test takes when it is written from
 * the implementation rather than from the failure, and it would report full
 * coverage of a function that had been deleted.
 *
 * So every translation assertion below uses a map that moves things, and the
 * identity case is tested separately and named as the degenerate case it is.
 * ===========================================================================
 */

describe('buildShuffle — deterministic from supplied randomness', () => {
  it('returns a permutation of every index', () => {
    const map = buildShuffle(4, [0.9, 0.5, 0.1]);
    expect([...map].sort()).toEqual([0, 1, 2, 3]);
  });

  it('produces the same map for the same fractions', () => {
    expect(buildShuffle(4, [0.9, 0.5, 0.1])).toEqual(buildShuffle(4, [0.9, 0.5, 0.1]));
  });

  it('ACTUALLY REORDERS for at least one input', () => {
    // Without this the whole module could be `identityShuffle` in disguise and
    // every other test here would still pass.
    const map = buildShuffle(4, [0.1, 0.1, 0.1]);
    expect(map).not.toEqual([0, 1, 2, 3]);
    expect(map).toEqual([1, 2, 3, 0]);
  });

  it('CAN return the identity, and that is correct Fisher-Yates', () => {
    // Every fraction near 1 selects the element already in place, so nothing
    // moves. Worth pinning: it is the input that makes a naive "the shuffle
    // always reorders" assertion flaky rather than wrong, and it is why the
    // reordering test above names its fractions explicitly.
    expect(buildShuffle(4, [0.9, 0.9, 0.9])).toEqual([0, 1, 2, 3]);
  });

  it('refuses to run with too few fractions rather than silently not shuffling', () => {
    expect(() => buildShuffle(4, [0.1, 0.2])).toThrow(RangeError);
  });

  it('rejects a fraction outside [0, 1)', () => {
    expect(() => buildShuffle(4, [1, 0.2, 0.3])).toThrow(RangeError);
    expect(() => buildShuffle(4, [-0.1, 0.2, 0.3])).toThrow(RangeError);
  });

  it('rejects a non-positive option count', () => {
    expect(() => buildShuffle(0, [])).toThrow(RangeError);
  });
});

describe('toCanonicalIndex — a shuffle that REORDERS', () => {
  // The student saw options[2] first, options[0] second, options[3] third and
  // options[1] fourth.
  const map = [2, 0, 3, 1] as const;

  it('translates the FIRST presented option to its original index', () => {
    expect(toCanonicalIndex(map, 0)).toBe(2);
  });

  it('translates every position', () => {
    expect(toCanonicalIndex(map, 1)).toBe(0);
    expect(toCanonicalIndex(map, 2)).toBe(3);
    expect(toCanonicalIndex(map, 3)).toBe(1);
  });

  it('is NOT the identity — the whole reason the map is retained', () => {
    const translated = [0, 1, 2, 3].map((position) => toCanonicalIndex(map, position));
    expect(translated).not.toEqual([0, 1, 2, 3]);
  });

  it('round-trips with toPresentationIndex', () => {
    for (const position of [0, 1, 2, 3]) {
      expect(toPresentationIndex(map, toCanonicalIndex(map, position))).toBe(position);
    }
  });

  it('throws on an out-of-range position rather than clamping to 0', () => {
    // Clamping would write a real-looking answer nobody gave.
    expect(() => toCanonicalIndex(map, 4)).toThrow(RangeError);
    expect(() => toCanonicalIndex(map, -1)).toThrow(RangeError);
  });

  it('throws when asked for a canonical index the map does not contain', () => {
    expect(() => toPresentationIndex(map, 9)).toThrow(RangeError);
  });
});

describe('applyShuffle', () => {
  it('presents the options in map order', () => {
    expect(applyShuffle(['a', 'b', 'c', 'd'], [2, 0, 3, 1])).toEqual(['c', 'a', 'd', 'b']);
  });

  it('keeps the correct option reachable through the translation', () => {
    const options = ['a', 'b', 'c', 'd'];
    const map = [2, 0, 3, 1];
    const presented = applyShuffle(options, map);
    // The student taps position 0. The canonical index is 2, which is 'c' —
    // exactly what they were shown first.
    expect(presented[0]).toBe(options[toCanonicalIndex(map, 0)]);
  });
});

describe('identityShuffle — the degenerate case, named as such', () => {
  it('maps every position to itself', () => {
    expect(identityShuffle(4)).toEqual([0, 1, 2, 3]);
  });

  it('makes translation a no-op, which is why it cannot be the only test', () => {
    expect(toCanonicalIndex(identityShuffle(4), 3)).toBe(3);
  });
});

describe('assertShuffleMap — the map arrives back from a jsonb column', () => {
  it('accepts a real permutation', () => {
    expect(() => {
      assertShuffleMap([2, 0, 3, 1], 4);
    }).not.toThrow();
  });

  it('rejects a map of the wrong length', () => {
    expect(() => {
      assertShuffleMap([0, 1, 2], 4);
    }).toThrow(RangeError);
  });

  it('rejects a duplicated index — two positions cannot show one option', () => {
    expect(() => {
      assertShuffleMap([0, 1, 1, 3], 4);
    }).toThrow(RangeError);
  });

  it('rejects an index outside the option range', () => {
    expect(() => {
      assertShuffleMap([0, 1, 2, 7], 4);
    }).toThrow(RangeError);
  });

  it('rejects a non-array', () => {
    expect(() => {
      assertShuffleMap('0,1,2,3', 4);
    }).toThrow(RangeError);
  });
});
