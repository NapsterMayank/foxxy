import { describe, expect, it } from 'vitest';
import { MAX_QUERY_CHARS, detectLanguage, normaliseQuery } from '../domain/query-normalisation';

describe('query normalisation', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(normaliseQuery('  what   is\n\nrefraction ?  ').text).toBe('what is refraction ?');
  });

  it('preserves case, because Postgres folds it and voyage-3 uses it', () => {
    expect(normaliseQuery('Newton and the Second Law').text).toBe('Newton and the Second Law');
  });

  it('NFKC-normalises, so two encodings of the same text are one query', () => {
    // The same visible string, composed and decomposed. Without normalisation
    // these are two different queries, two different embeddings and two
    // different cache keys for something a reader cannot tell apart.
    //
    // Built from CODE POINTS rather than typed as literals: as literals the
    // two would be whatever the editor happened to save, and this test would
    // silently compare a string with itself.
    const composed = 'caf' + String.fromCharCode(0x00e9);
    const decomposed = 'cafe' + String.fromCharCode(0x0301);

    expect(composed).not.toBe(decomposed);
    expect(normaliseQuery(composed).text).toBe(normaliseQuery(decomposed).text);
  });

  it('reports an empty query rather than producing one', () => {
    expect(normaliseQuery('   \n\t ').isEmpty).toBe(true);
    expect(normaliseQuery('a').isEmpty).toBe(false);
  });

  describe('truncation', () => {
    it('leaves a query at the limit alone', () => {
      const atLimit = 'a'.repeat(MAX_QUERY_CHARS);
      const result = normaliseQuery(atLimit);

      expect(result.truncated).toBe(false);
      expect(result.text).toHaveLength(MAX_QUERY_CHARS);
    });

    it('cuts one character past the limit, and SAYS it did', () => {
      const overLimit = 'a'.repeat(MAX_QUERY_CHARS + 1);
      const result = normaliseQuery(overLimit);

      expect(result.truncated).toBe(true);
      expect(result.text).toHaveLength(MAX_QUERY_CHARS);
    });
  });
});

describe('language detection', () => {
  it('reads Devanagari as Hindi', () => {
    expect(detectLanguage('प्रकाश संश्लेषण क्या है')).toBe('hi');
  });

  it('reads a mixed script as Hindi, because the sparse half must not stem it', () => {
    // One Devanagari token is enough. The configuration this drives is
    // 'simple' vs 'english', and English stemming applied to Devanagari is
    // worse than no stemming at all (D-040).
    expect(detectLanguage('what is प्रकाश संश्लेषण')).toBe('hi');
  });

  it('reads Latin script as English', () => {
    expect(detectLanguage('what is photosynthesis')).toBe('en');
  });

  it('reads HINGLISH as English — and that is about the tsquery, not the student', () => {
    /**
     * "prakash sanshleshan kya hai" is Hindi written in Latin letters. It
     * reads 'en' here and that is CORRECT for the only thing this value
     * decides: the Postgres text-search configuration. Using 'simple' on Latin
     * text would stop matching English chunks by stem, and English chunks are
     * most of the corpus.
     *
     * It is NOT a claim about what language the student speaks, and nothing may
     * use it to choose a reply language.
     */
    expect(detectLanguage('prakash sanshleshan kya hai')).toBe('en');
  });

  it('reads an empty string as English rather than throwing', () => {
    expect(detectLanguage('')).toBe('en');
  });
});
