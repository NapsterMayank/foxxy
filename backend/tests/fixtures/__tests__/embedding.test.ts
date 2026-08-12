import { describe, expect, it } from 'vitest';
import { cosineSimilarity, makeEmbedding, toVectorLiteral } from '../embedding';
import { makeChapter, makeQuestion, makeRagChunk, makeStudent, misconceptionsFor } from '../content';

/**
 * The fixtures themselves, tested.
 *
 * Fixture code is test infrastructure, and test infrastructure that is wrong
 * is worse than none: every suite built on it is green about the wrong thing.
 * The determinism property in particular has to be asserted, because its
 * failure mode is a flaky vector-similarity test appearing weeks later in
 * someone else's suite.
 */

describe('makeEmbedding — determinism', () => {
  it('returns identical vectors for identical seeds', () => {
    expect(makeEmbedding('photosynthesis')).toEqual(makeEmbedding('photosynthesis'));
  });

  it('returns different vectors for different seeds', () => {
    expect(makeEmbedding('friction')).not.toEqual(makeEmbedding('photosynthesis'));
  });

  it('is stable across runs — a hardcoded value from the generator', () => {
    // Pins the algorithm itself. Swapping the PRNG would silently invalidate
    // every recorded similarity expectation elsewhere; this makes that a
    // deliberate act rather than an accident.
    const first = makeEmbedding('foxxy')[0];
    expect(first).toBeCloseTo(-0.05805968082604466, 12);
  });
});

describe('makeEmbedding — shape', () => {
  it('produces exactly 1024 dimensions, matching voyage-3 and the corpus', () => {
    expect(makeEmbedding('any')).toHaveLength(1024);
  });

  it('produces a unit vector, as voyage-3 does', () => {
    // Unit length keeps cosine distance and inner product interchangeable,
    // exactly as they will be against the real corpus.
    const vector = makeEmbedding('unit');
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 10);
  });

  it('produces components of BOTH signs', () => {
    // The property that makes a similarity test able to fail. Uniform [0,1)
    // components would put every vector in one orthant, so any two would score
    // around 0.75 regardless of seed.
    const vector = makeEmbedding('signs');
    expect(vector.some((value) => value > 0)).toBe(true);
    expect(vector.some((value) => value < 0)).toBe(true);
  });

  it('keeps unrelated seeds near-orthogonal', () => {
    const similarity = cosineSimilarity(makeEmbedding('alpha'), makeEmbedding('omega'));
    expect(Math.abs(similarity)).toBeLessThan(0.2);
  });

  it('scores a vector against itself as 1', () => {
    expect(cosineSimilarity(makeEmbedding('same'), makeEmbedding('same'))).toBeCloseTo(1, 10);
  });

  it('contains no NaN or Infinity', () => {
    expect(makeEmbedding('finite').every((value) => Number.isFinite(value))).toBe(true);
  });

  it('honours an explicit width, so a test can prove the column rejects one', () => {
    expect(makeEmbedding('narrow', 768)).toHaveLength(768);
  });
});

describe('toVectorLiteral', () => {
  it('renders the pgvector bracket form', () => {
    expect(toVectorLiteral([1, -0.5, 0])).toBe('[1,-0.5,0]');
  });
});

describe('cosineSimilarity', () => {
  it('throws on a length mismatch rather than comparing nonsense', () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/length mismatch/);
  });
});

describe('the fixtures satisfy every CHECK constraint by construction', () => {
  it('gives a question exactly four options', () => {
    expect(makeQuestion('q').options).toHaveLength(4);
  });

  it('gives a question four NON-EMPTY options', () => {
    expect(makeQuestion('q').options.every((option) => option.trim().length > 0)).toBe(true);
  });

  it('keeps correct_index inside 0..3', () => {
    const { correctIndex } = makeQuestion('q');
    expect(correctIndex).toBeGreaterThanOrEqual(0);
    expect(correctIndex).toBeLessThan(4);
  });

  it('gives a question exactly three misconception codes', () => {
    expect(Object.keys(makeQuestion('q').distractorMisconceptions ?? {})).toHaveLength(3);
  });

  it('keys the misconception codes by OPTION INDEX, correct option absent', () => {
    // Migration 0003 (D-048). The keying rule replaced a positional array
    // whose alignment lived in a comment: reordering options re-pointed every
    // code at a different option with nothing raising an error.
    expect(misconceptionsFor('x', 0)).toEqual({
      '1': 'x-misconception-opt1',
      '2': 'x-misconception-opt2',
      '3': 'x-misconception-opt3',
    });
    expect(misconceptionsFor('x', 2)).toEqual({
      '0': 'x-misconception-opt0',
      '1': 'x-misconception-opt1',
      '3': 'x-misconception-opt3',
    });
  });

  it('answers "which misconception is option 2?" without counting', () => {
    // The property the shape change buys. Under the array, the same question
    // required knowing `correct_index` and counting past it — and the answer
    // changed silently whenever either moved.
    for (const correctIndex of [0, 1, 3]) {
      expect(misconceptionsFor('x', correctIndex)['2']).toBe('x-misconception-opt2');
    }
  });

  it('omits the correct option’s key, which the CHECK requires', () => {
    for (const correctIndex of [0, 1, 2, 3]) {
      expect(misconceptionsFor('x', correctIndex)[String(correctIndex)]).toBeUndefined();
    }
  });

  it('uses a STRING grade everywhere', () => {
    expect(typeof makeStudent('s').grade).toBe('string');
    expect(typeof makeChapter('c').grade).toBe('string');
    expect(typeof makeRagChunk('r').grade).toBe('string');
  });

  it('gives a chapter a positive chapter_number and a non-blank English title', () => {
    const chapter = makeChapter('c');
    expect(chapter.chapterNumber).toBeGreaterThan(0);
    expect(chapter.titleEn.trim().length).toBeGreaterThan(0);
  });

  it('gives a chunk a 1024-dimension embedding and non-blank text', () => {
    const chunk = makeRagChunk('r');
    expect(chunk.embedding).toHaveLength(1024);
    expect(chunk.chunkText.trim().length).toBeGreaterThan(0);
  });

  it('lets an override replace any field', () => {
    expect(makeStudent('s', { grade: '11', preferredLanguage: 'hi' })).toMatchObject({
      grade: '11',
      preferredLanguage: 'hi',
    });
  });
});
