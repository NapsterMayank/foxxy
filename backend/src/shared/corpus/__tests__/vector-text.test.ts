import { describe, expect, it } from 'vitest';
import { parseVectorText, toVectorText } from '../vector-text';
import { EMBEDDING_DIMENSIONS } from '../../constants/curriculum';

function literal(fill: (index: number) => number, width = EMBEDDING_DIMENSIONS): string {
  return `[${Array.from({ length: width }, (_unused, index) => fill(index)).join(',')}]`;
}

describe('parseVectorText — the width is the point', () => {
  it('parses a full-width vector', () => {
    const result = parseVectorText(literal((index) => index / 10000));
    expect(result.ok).toBe(true);
    expect(result.ok && result.vector?.length).toBe(EMBEDDING_DIMENSIONS);
  });

  it('REFUSES a vector of the wrong width, naming both numbers', () => {
    /**
     * `rag_chunks.embedding` is `vector(1024)`. A mis-parsed vector is either
     * rejected 3,000 rows into a transaction — with a message that names
     * neither the chunk nor the position — or, in a column without the
     * dimension, silently accepted, after which every cosine distance computed
     * against it is meaningless. TypeScript cannot check the length of an array
     * read out of a file; this is the only place that can.
     */
    const result = parseVectorText(literal(() => 0.5, 768));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('768');
    expect(!result.ok && result.reason).toContain('1024');
  });

  it('treats an ABSENT embedding as a fact, not an error', () => {
    // 20 real chunks have no vector (D-078). They are imported with a NULL and
    // stay reachable by full-text search.
    for (const absent of [null, undefined, '']) {
      const result = parseVectorText(absent);
      expect(result.ok).toBe(true);
      expect(result.ok && result.vector).toBeNull();
    }
  });

  it('NEVER fabricates a vector for an absent one', () => {
    // A zero vector would be a plausible point in the space that retrieval
    // would happily return, and it would mean nothing.
    const result = parseVectorText(null);
    expect(result.ok && result.vector).not.toEqual(
      Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0),
    );
  });

  it('rejects a non-finite component rather than storing it', () => {
    const withNaN = `[${['NaN', ...Array.from({ length: EMBEDDING_DIMENSIONS - 1 }, () => '0.1')].join(',')}]`;
    const result = parseVectorText(withNaN);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('component 0');
  });

  it('rejects anything that is not a bracketed literal', () => {
    for (const bad of ['0.1,0.2', '[]', 42, {}]) {
      expect(parseVectorText(bad).ok).toBe(false);
    }
  });

  it('accepts an already-parsed array, so a future extract format is not a silent loss', () => {
    const array = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.25);
    const result = parseVectorText(array);
    expect(result.ok && result.vector?.length).toBe(EMBEDDING_DIMENSIONS);
    expect(parseVectorText([1, 'two', 3]).ok).toBe(false);
  });
});

describe('the round trip through the text form perturbs nothing', () => {
  it('reproduces the source literal exactly', () => {
    /**
     * Postgres prints a float in its shortest round-tripping form and so does
     * JavaScript, so parse-then-join is the identity on a literal Postgres
     * produced. Asserted rather than assumed: if it were not true, every one of
     * the 4,666 imported vectors would be slightly wrong, every distance would
     * be slightly wrong, and nothing would fail.
     */
    const source = literal((index) => (index % 2 === 0 ? -0.006236853 : 0.04410643));
    const parsed = parseVectorText(source);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.vector !== null && toVectorText(parsed.vector)).toBe(source);
  });
});
