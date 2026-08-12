import { describe, expect, it } from 'vitest';
import {
  chapterKeyOf,
  normaliseChapterNumber,
  normaliseEmbeddingModel,
  normaliseGrade,
  normalisePilotGrade,
  normaliseSubject,
  toChapterKey,
} from '../normalise';

/**
 * D-076 — the five source tables disagree with each other about how a grade and
 * a subject are spelled. These tests are the record of what was measured and
 * the guard against the normaliser being "simplified" into something that
 * passes unknown values through.
 */

describe('normaliseGrade', () => {
  it('strips the "Grade " prefix rag_content_chunks and concept_graph carry', () => {
    expect(normaliseGrade('Grade 6')).toBe('6');
    expect(normaliseGrade('Grade 10')).toBe('10');
  });

  it('accepts the bare form question_bank and chapter_concepts carry', () => {
    expect(normaliseGrade('6')).toBe('6');
    expect(normaliseGrade('10')).toBe('10');
  });

  it('survives the whitespace and casing a hand-maintained corpus accumulates', () => {
    // Not hypothetical tidiness: `'Grade  9'` with two spaces reaching the
    // '6'..'12' CHECK aborts an import partway through, after rows are written.
    expect(normaliseGrade('  grade 9 ')).toBe('9');
    expect(normaliseGrade('GRADE\t7')).toBe('7');
    expect(normaliseGrade(' 8 ')).toBe('8');
  });

  it('returns null — never the input — for anything it does not recognise', () => {
    /**
     * THE LOAD-BEARING TEST IN THIS FILE.
     *
     * A normaliser with a fallthrough turns an unknown spelling into something
     * that looks canonical. `'Class 6'` passed through would reach a CHECK and
     * abort; `'5'` passed through would reach it too. Both are better than the
     * third case — a value that PASSES the CHECK and is wrong.
     */
    expect(normaliseGrade('Class 6')).toBeNull();
    expect(normaliseGrade('5')).toBeNull();
    expect(normaliseGrade('13')).toBeNull();
    expect(normaliseGrade('06')).toBeNull();
    expect(normaliseGrade('')).toBeNull();
    expect(normaliseGrade(null)).toBeNull();
    expect(normaliseGrade(undefined)).toBeNull();
  });

  it('does not strip a prefix that is not the prefix', () => {
    expect(normaliseGrade('Grade6')).toBeNull();
    expect(normaliseGrade('Upgrade 6')).toBeNull();
  });
});

describe('normalisePilotGrade', () => {
  it('accepts 6 to 10', () => {
    for (const grade of ['6', '7', '8', '9', '10']) {
      expect(normalisePilotGrade(`Grade ${grade}`)).toBe(grade);
    }
  });

  it('refuses 11 and 12, which are real grades outside pilot scope', () => {
    // Distinct from "not a grade". The import report counts them separately
    // because one is expected and enormous and the other is a finding.
    expect(normaliseGrade('11')).toBe('11');
    expect(normalisePilotGrade('11')).toBeNull();
    expect(normalisePilotGrade('12')).toBeNull();
  });
});

describe('normaliseSubject', () => {
  it('maps every measured source spelling onto one canonical value', () => {
    // rag_content_chunks says 'Mathematics'; the other four say 'math'. Joined
    // without this, they return zero rows — which reads as "no questions for
    // this chapter", not as a bug.
    expect(normaliseSubject('Mathematics')).toBe('mathematics');
    expect(normaliseSubject('math')).toBe('mathematics');
    expect(normaliseSubject('Science')).toBe('science');
    expect(normaliseSubject('science')).toBe('science');
  });

  it('treats an already-canonical value through the same path', () => {
    expect(normaliseSubject('mathematics')).toBe('mathematics');
  });

  it('tidies whitespace, case and separators, which cannot merge two subjects', () => {
    expect(normaliseSubject('  MATH ')).toBe('mathematics');
    expect(normaliseSubject('Social-Studies')).toBeNull();
  });

  it('returns null for a subject outside pilot scope rather than guessing', () => {
    /**
     * `history_sr` was explicitly flagged by the reconnaissance as needing a
     * DECISION, not a string-manipulation outcome (D-076). Anything general
     * enough to unify 'Mathematics' with 'math' is general enough to invent a
     * mapping for this, and an invented subject code splits a subject into two
     * sets that never join.
     */
    expect(normaliseSubject('history_sr')).toBeNull();
    expect(normaliseSubject('Social Studies')).toBeNull();
    expect(normaliseSubject('English')).toBeNull();
    expect(normaliseSubject('')).toBeNull();
    expect(normaliseSubject(null)).toBeNull();
  });
});

describe('normaliseEmbeddingModel', () => {
  it('collapses the two labels the source uses for one model', () => {
    expect(normaliseEmbeddingModel('voyage-3')).toBe('voyage-3');
    expect(normaliseEmbeddingModel('voyage/voyage-3')).toBe('voyage-3');
    expect(normaliseEmbeddingModel('  Voyage/Voyage-3 ')).toBe('voyage-3');
  });

  it('returns null for a model we cannot vouch for the width or space of', () => {
    // A chunk stamped `mistral-embed` is not a voyage-3 chunk, and pretending it
    // is puts two incompatible embedding spaces in one column — where cosine
    // distance still returns a number and the number means nothing.
    expect(normaliseEmbeddingModel('mistral-embed')).toBeNull();
    expect(normaliseEmbeddingModel('voyage-2')).toBeNull();
    expect(normaliseEmbeddingModel('')).toBeNull();
    expect(normaliseEmbeddingModel(null)).toBeNull();
  });
});

describe('normaliseChapterNumber', () => {
  it('accepts positive integers', () => {
    expect(normaliseChapterNumber(1)).toBe(1);
    expect(normaliseChapterNumber(14)).toBe(14);
  });

  it('refuses everything the chapters CHECK would refuse, and fractions', () => {
    expect(normaliseChapterNumber(0)).toBeNull();
    expect(normaliseChapterNumber(-1)).toBeNull();
    expect(normaliseChapterNumber(1.5)).toBeNull();
    expect(normaliseChapterNumber(Number.NaN)).toBeNull();
    expect(normaliseChapterNumber(null)).toBeNull();
  });
});

describe('toChapterKey', () => {
  it('normalises the chunk-table spelling', () => {
    expect(toChapterKey({ grade: 'Grade 9', subject: 'Science', chapter_number: 3 })).toEqual({
      ok: true,
      key: { grade: '9', subject: 'science', chapterNumber: 3 },
    });
  });

  it('normalises the question-table spelling', () => {
    expect(toChapterKey({ grade: '9', subject: 'science', chapter_number: 3 })).toEqual({
      ok: true,
      key: { grade: '9', subject: 'science', chapterNumber: 3 },
    });
  });

  it('normalises the concept_graph HYBRID, which is the one that is easy to miss', () => {
    /**
     * `concept_graph` spells the grade like the CHUNKS table (`'Grade 6'`) and
     * the subject like the QUESTION table (`'math'`). Applying either table's
     * rule alone gets exactly half of it right — and the wrong half produces no
     * error, just a chapter key that matches nothing.
     *
     * The point of this test is that all three rows above produce the SAME key.
     */
    expect(toChapterKey({ grade: 'Grade 6', subject: 'math', chapter_number: 2 })).toEqual({
      ok: true,
      key: { grade: '6', subject: 'mathematics', chapterNumber: 2 },
    });
  });

  it('makes the three source spellings of one chapter converge on one key', () => {
    const fromChunks = toChapterKey({ grade: 'Grade 7', subject: 'Mathematics', chapter_number: 4 });
    const fromQuestions = toChapterKey({ grade: '7', subject: 'math', chapter_number: 4 });
    const fromGraph = toChapterKey({ grade: 'Grade 7', subject: 'math', chapter_number: 4 });

    expect(fromChunks.ok && fromQuestions.ok && fromGraph.ok).toBe(true);
    if (fromChunks.ok && fromQuestions.ok && fromGraph.ok) {
      expect(chapterKeyOf(fromQuestions.key)).toBe(chapterKeyOf(fromChunks.key));
      expect(chapterKeyOf(fromGraph.key)).toBe(chapterKeyOf(fromChunks.key));
    }
  });

  it('names WHICH part failed, because the reasons mean different things', () => {
    expect(toChapterKey({ grade: '11', subject: 'math', chapter_number: 1 })).toEqual({
      ok: false,
      reason: 'grade-outside-pilot',
    });
    expect(toChapterKey({ grade: 'Class 6', subject: 'math', chapter_number: 1 })).toEqual({
      ok: false,
      reason: 'grade-unrecognised',
    });
    expect(toChapterKey({ grade: '6', subject: 'history_sr', chapter_number: 1 })).toEqual({
      ok: false,
      reason: 'subject-unrecognised',
    });
    expect(toChapterKey({ grade: '6', subject: 'math', chapter_number: 0 })).toEqual({
      ok: false,
      reason: 'chapter-number-invalid',
    });
  });
});
