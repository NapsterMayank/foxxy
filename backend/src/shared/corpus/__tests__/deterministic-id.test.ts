import { describe, expect, it } from 'vitest';
import { corpusId, uuidV5, CORPUS_ID_NAMESPACE } from '../deterministic-id';

/**
 * The property these tests protect is not "the function works". It is "running
 * the import twice does not duplicate the corpus", and that property lives
 * entirely in this file's determinism.
 */

describe('uuidV5 conforms to RFC 4122', () => {
  it('produces a version-5, RFC-variant uuid', () => {
    const value = uuidV5('anything');
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('matches the RFC 4122 worked example', () => {
    /**
     * THE ONE TEST HERE THAT IS NOT SELF-REFERENTIAL.
     *
     * Every other assertion in this file compares this implementation to
     * itself: "the same input gives the same output" is true of a function that
     * hashes the wrong bytes, sets the wrong version nibble, or forgets the
     * variant entirely. This one compares it to an EXTERNAL oracle — the
     * canonical DNS-namespace example, `uuid5(NAMESPACE_DNS, 'python.org')`,
     * whose value is published and is not derived from this code.
     */
    const dns = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
    expect(uuidV5('python.org', dns)).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('is stable across calls', () => {
    expect(uuidV5('stable')).toBe(uuidV5('stable'));
  });

  it('separates inputs that differ by one character', () => {
    expect(uuidV5('a')).not.toBe(uuidV5('b'));
  });
});

describe('corpusId keeps the id spaces apart', () => {
  const sourceId = '00263bcc-8ebf-444f-aae2-720274682bb1';

  it('gives the same source id a DIFFERENT id per destination table', () => {
    /**
     * A question and a chunk come from different tables in a database we do not
     * control, so they can carry the same source uuid. Without the kind prefix
     * they would derive the same primary key in two different tables — harmless
     * today, and impossible to debug the day it is not.
     */
    const ids = [
      corpusId('question', sourceId),
      corpusId('chunk', sourceId),
      corpusId('concept', sourceId),
      corpusId('edge', sourceId),
      corpusId('misconception', sourceId),
      corpusId('chapter', sourceId),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('derives a chapter id from the chapter KEY, not from a source row', () => {
    // `chapters` is DERIVED — the source has no chapters table — so its identity
    // is the triple that derived it. This is also what lets a chunk's
    // `chapter_id` be computed before the chapter has been inserted.
    expect(corpusId('chapter', '8|science|4')).toBe(corpusId('chapter', '8|science|4'));
    expect(corpusId('chapter', '8|science|4')).not.toBe(corpusId('chapter', '8|science|5'));
  });

  it('pins the namespace, because changing it duplicates the whole corpus', () => {
    /**
     * NOT A TAUTOLOGY, despite looking like one. Every id in the database is a
     * function of this constant. Change it — for tidiness, in a merge, by
     * regenerating it "because it was random anyway" — and the next import does
     * not update 7,500 rows, it inserts a second complete copy beside them, with
     * no constraint violated and nothing in the log.
     *
     * This assertion is the tripwire: the value cannot move without somebody
     * deciding to move it.
     */
    expect(CORPUS_ID_NAMESPACE).toBe('6f4c9d2e-1b73-4f8a-9c5d-2a7e0b6f31d4');
    expect(corpusId('question', sourceId)).toBe('f8f5f72a-8b8c-5540-9ebb-d207f16ce1d3');
  });
});
