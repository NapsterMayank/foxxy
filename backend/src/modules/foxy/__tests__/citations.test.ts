import { describe, expect, it } from 'vitest';
import {
  CITATION_OPEN,
  MAX_CITATION_ID_CHARS,
  createCitationFilter,
  verifyCitations,
  type CitableChunk,
} from '../domain/citations';

/**
 * ============================================================================
 * "THAT VERIFICATION STEP IS THE DIFFERENCE BETWEEN A CITATION AND A
 * DECORATION." — plan §8.5.
 *
 * The three properties this file exists to pin, in order of how much damage
 * losing one would do:
 *
 *  1. A FABRICATED CITATION IS STRIPPED, and stripped BEFORE the text is sent —
 *     not corrected afterwards, not flagged, not passed through with a warning.
 *  2. A MARKER SPLIT ACROSS STREAMED CHUNKS is still recognised. This is the
 *     NORMAL case rather than an edge case: a model emits a few characters at a
 *     time, so `[chunk:` and its id almost never arrive together.
 *  3. AN UNTERMINATED MARKER DOES NOT SWALLOW THE ANSWER. Without a bound, one
 *     stray `[` stops the response mid-sentence forever, with no error anywhere
 *     — the worst failure shape there is.
 * ============================================================================
 */

const REAL_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const INVENTED = '99999999-9999-4999-8999-999999999999';

const CHUNKS: readonly CitableChunk[] = [
  { id: REAL_ID, chapterNumber: 10, chapterTitle: 'The Human Eye' },
  { id: OTHER_ID, chapterNumber: 11, chapterTitle: 'Light' },
];

/** Streams a string one character at a time — the harshest possible split. */
function pushCharByChar(text: string, chunks: readonly CitableChunk[]): {
  text: string;
  citationIds: string[];
  fabricated: string[];
} {
  const filter = createCitationFilter(chunks);
  let out = '';
  for (const character of text) out += filter.push(character).text;
  out += filter.flush().text;
  return {
    text: out,
    citationIds: filter.citations().map((citation) => citation.chunkId),
    fabricated: [...filter.fabricated()],
  };
}

describe('citation verification — the fabrication case', () => {
  it('STRIPS a citation to a chunk that was never retrieved', () => {
    const result = verifyCitations(
      `Light bends. [chunk:${INVENTED}] That is refraction.`,
      CHUNKS,
    );

    expect(result.text).toBe('Light bends.  That is refraction.');
    expect(result.citations).toEqual([]);
    expect(result.fabricated).toEqual([INVENTED]);
  });

  it('never lets a fabricated id reach the emitted text, even one character at a time', () => {
    const streamed = pushCharByChar(`Light bends. [chunk:${INVENTED}] Done.`, CHUNKS);

    expect(streamed.text).not.toContain(INVENTED);
    expect(streamed.text).not.toContain(CITATION_OPEN);
    expect(streamed.citationIds).toEqual([]);
    expect(streamed.fabricated).toEqual([INVENTED]);
  });

  it('keeps the real citation and drops the invented one from the same answer', () => {
    const result = verifyCitations(
      `A [chunk:${REAL_ID}] and B [chunk:${INVENTED}].`,
      CHUNKS,
    );

    expect(result.citations.map((citation) => citation.chunkId)).toEqual([REAL_ID]);
    expect(result.fabricated).toEqual([INVENTED]);
    expect(result.text).toBe('A  and B .');
  });

  it('treats an empty marker as neither a citation nor a fabrication', () => {
    const result = verifyCitations('Light bends. [chunk:] Done.', CHUNKS);
    expect(result.citations).toEqual([]);
    expect(result.fabricated).toEqual([]);
    expect(result.text).toBe('Light bends.  Done.');
  });
});

describe('citation verification — the real case', () => {
  it('resolves a citation to the chapter it came from', () => {
    const result = verifyCitations(`Light bends. [chunk:${REAL_ID}]`, CHUNKS);
    expect(result.citations).toEqual([
      { chunkId: REAL_ID, chapterNumber: 10, chapterTitle: 'The Human Eye' },
    ]);
  });

  it('deduplicates a chunk cited three times', () => {
    const result = verifyCitations(
      `A [chunk:${REAL_ID}] B [chunk:${REAL_ID}] C [chunk:${REAL_ID}]`,
      CHUNKS,
    );
    expect(result.citations).toHaveLength(1);
  });

  it('keeps citations in first-seen order', () => {
    const result = verifyCitations(`A [chunk:${OTHER_ID}] B [chunk:${REAL_ID}]`, CHUNKS);
    expect(result.citations.map((citation) => citation.chunkId)).toEqual([OTHER_ID, REAL_ID]);
  });

  it('tolerates whitespace inside the marker', () => {
    const result = verifyCitations(`A [chunk: ${REAL_ID} ]`, CHUNKS);
    expect(result.citations.map((citation) => citation.chunkId)).toEqual([REAL_ID]);
  });

  it('carries a null chapter through rather than inventing one', () => {
    const result = verifyCitations(`A [chunk:${REAL_ID}]`, [
      { id: REAL_ID, chapterNumber: null, chapterTitle: null },
    ]);
    expect(result.citations[0]).toEqual({
      chunkId: REAL_ID,
      chapterNumber: null,
      chapterTitle: null,
    });
  });
});

describe('the incremental filter — split frames', () => {
  it('recognises a marker split across two pushes', () => {
    const filter = createCitationFilter(CHUNKS);
    const first = filter.push('Light bends. [chu');
    const second = filter.push(`nk:${REAL_ID}] Done.`);

    // The half-marker is HELD BACK, never emitted as literal text.
    expect(first.text).toBe('Light bends. ');
    expect(second.text).toBe(' Done.');
    expect(filter.citations().map((citation) => citation.chunkId)).toEqual([REAL_ID]);
  });

  it('emits the prose in front of an unclosed marker without waiting for it', () => {
    const filter = createCitationFilter(CHUNKS);
    // The sentence must not stall behind a citation the model has not finished.
    expect(filter.push('Light bends and refracts. [chunk:111').text).toBe(
      'Light bends and refracts. ',
    );
  });

  it('holds back a trailing `[` that might become a marker', () => {
    const filter = createCitationFilter(CHUNKS);
    expect(filter.push('Light bends.[').text).toBe('Light bends.');
    // …and releases it once it turns out not to be one.
    expect(filter.push('see below]').text).toBe('[see below]');
  });

  it('reassembles the answer byte for byte when there are no markers at all', () => {
    const answer = 'Light bends when it enters a denser medium. This is refraction.';
    expect(pushCharByChar(answer, CHUNKS).text).toBe(answer);
  });

  it('returns nothing for an empty push', () => {
    const filter = createCitationFilter(CHUNKS);
    expect(filter.push('')).toEqual({ text: '', citations: [], fabricated: [] });
  });
});

describe('the incremental filter — the unterminated marker', () => {
  it('RELEASES an unterminated marker as ordinary text on flush, never discards it', () => {
    const filter = createCitationFilter(CHUNKS);
    filter.push('Light bends. [chunk:abc');
    // Discarding would silently truncate an answer whose only sin was a
    // bracket, and the student would have no way to know a sentence went
    // missing.
    expect(filter.flush().text).toBe('[chunk:abc');
  });

  it('gives up and releases the opener once it runs past any plausible id length', () => {
    const filter = createCitationFilter(CHUNKS);
    const long = 'x'.repeat(MAX_CITATION_ID_CHARS + 5);
    const result = filter.push(`Light. [chunk:${long} and the answer continues`);

    // WITHOUT THIS BOUND the rest of the answer would be swallowed forever.
    expect(result.text).toContain('[chunk:');
    expect(result.text).toContain('and the answer continues');
  });

  it('flushes cleanly when nothing is held back', () => {
    const filter = createCitationFilter(CHUNKS);
    filter.push('Light bends.');
    expect(filter.flush()).toEqual({ text: '', citations: [], fabricated: [] });
  });
});

describe('the filter is bound to ONE turn', () => {
  it('does not verify against chunks the model was never shown', () => {
    // The only correct answer to "was this chunk retrieved" is "was it
    // retrieved FOR THIS TURN". A filter that could consult the corpus would
    // happily verify a fabrication.
    const result = verifyCitations(`A [chunk:${OTHER_ID}]`, [CHUNKS[0]!]);
    expect(result.citations).toEqual([]);
    expect(result.fabricated).toEqual([OTHER_ID]);
  });
});
