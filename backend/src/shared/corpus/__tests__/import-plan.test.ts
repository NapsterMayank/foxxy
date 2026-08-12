import { describe, expect, it } from 'vitest';
import { buildImportPlan } from '../import-plan';
import type {
  SourceChapterConcept,
  SourceChunk,
  SourceConceptEdge,
  SourceExtract,
  SourceMisconception,
  SourceQuestion,
} from '../source-shapes';

/**
 * The plan is the whole import as data, decided before anything is written.
 *
 * These tests drive it with an extract shaped exactly like the source — grades
 * spelled three ways, subjects spelled two, a hybrid table, optionless
 * questions, a chunk with no vector, an orphan misconception — and assert the
 * decisions, not the SQL.
 */

function chunk(overrides: Partial<SourceChunk> = {}): SourceChunk {
  return {
    id: 'chunk-1',
    grade: 'Grade 6',
    subject: 'Mathematics',
    chapter_number: 1,
    chapter_title: 'Knowing Our Numbers',
    chunk_text: 'A number line helps compare numbers.',
    chunk_index: 0,
    chunk_type: 'paragraph',
    board: 'CBSE',
    topic: null,
    concept: null,
    difficulty_level: 2,
    content_layer: 'foundation',
    language: 'en',
    embedding: Array.from({ length: 8 }, () => 0.1),
    embedding_model: 'voyage/voyage-3',
    embedded_at: null,
    word_count: 7,
    token_count: 9,
    quality_score: 0.8,
    is_active: true,
    ...overrides,
  };
}

function question(overrides: Partial<SourceQuestion> = {}): SourceQuestion {
  return {
    id: 'q-1',
    grade: '6',
    subject: 'math',
    chapter_number: 1,
    question_text: 'Which is largest?',
    options: ['1', '2', '3', '4'],
    correct_answer_index: 3,
    explanation: 'Four is the largest.',
    // AN INTEGER, as the source actually stores it (D-098). 1 = easy.
    difficulty: 1,
    bloom_level: 'remember',
    ...overrides,
  };
}

function concept(overrides: Partial<SourceChapterConcept> = {}): SourceChapterConcept {
  return {
    id: 'c-1',
    grade: '6',
    subject: 'math',
    chapter_number: 1,
    title: 'Place value',
    title_hi: 'स्थानीय मान',
    concept_number: 1,
    slug: 'place-value',
    learning_objective: 'Read and write large numbers.',
    explanation: 'Each digit has a place value.',
    explanation_hi: 'प्रत्येक अंक का एक स्थानीय मान होता है।',
    key_formula: null,
    example_content: '5,432 = 5000 + 400 + 30 + 2',
    common_mistakes: [],
    ...overrides,
  };
}

function edge(overrides: Partial<SourceConceptEdge> = {}): SourceConceptEdge {
  return {
    id: 'e-1',
    grade: 'Grade 6',
    subject: 'math',
    chapter_number: 1,
    concept_code: 'place_value',
    concept_name: 'Place value',
    prerequisite_codes: ['counting'],
    bloom_level: 'understand',
    cognitive_load: 3,
    ...overrides,
  };
}

function misconception(overrides: Partial<SourceMisconception> = {}): SourceMisconception {
  return {
    id: 'm-1',
    subject: 'math',
    concept_code: 'place_value',
    pattern_code: 'ignores_zero_placeholder',
    description: 'Treats 502 as 52.',
    detection_rule: { trigger: 'place_value', wrong_pattern: 'zero_dropped' },
    remediation_strategy: 'Expand the number column by column.',
    remediation_concept_codes: ['place_value'],
    severity: 3,
    ...overrides,
  };
}

function extract(overrides: Partial<SourceExtract> = {}): SourceExtract {
  return {
    chunks: [],
    questions: [],
    concepts: [],
    conceptEdges: [],
    misconceptions: [],
    ...overrides,
  };
}

describe('chapters are derived from all three sources, not one', () => {
  it('creates a chapter known only to the chunks table', () => {
    const plan = buildImportPlan(extract({ chunks: [chunk()] }));
    expect(plan.chapters.map((c) => c.chapterKey)).toEqual(['6|mathematics|1']);
  });

  it('creates a chapter known only to the question table', () => {
    const plan = buildImportPlan(extract({ questions: [question({ chapter_number: 9 })] }));
    expect(plan.chapters.map((c) => c.chapterKey)).toEqual(['6|mathematics|9']);
  });

  it('creates a chapter known only to the concepts or the graph', () => {
    const plan = buildImportPlan(
      extract({
        concepts: [concept({ chapter_number: 4 })],
        conceptEdges: [edge({ chapter_number: 5 })],
      }),
    );
    expect(plan.chapters.map((c) => c.chapterKey)).toEqual(['6|mathematics|4', '6|mathematics|5']);
  });

  it('collapses the three source spellings of one chapter into ONE chapter', () => {
    /**
     * The failure this prevents is the expensive one. Unnormalised, these three
     * rows describe three different chapters — `Grade 6/Mathematics/1`,
     * `6/math/1` and `Grade 6/math/1` — and the chunks would link to a chapter
     * that has no questions while the questions sat under a chapter with no
     * content. Both halves would look present and neither would join.
     */
    const plan = buildImportPlan(
      extract({
        chunks: [chunk({ grade: 'Grade 6', subject: 'Mathematics' })],
        questions: [question({ grade: '6', subject: 'math' })],
        conceptEdges: [edge({ grade: 'Grade 6', subject: 'math' })],
      }),
    );

    expect(plan.chapters).toHaveLength(1);
    expect(plan.chunks[0]?.chapterKey).toBe('6|mathematics|1');
    expect(plan.conceptEdges[0]?.chapterKey).toBe('6|mathematics|1');
  });

  it('takes the title from the lowest-indexed chunk that has one', () => {
    const plan = buildImportPlan(
      extract({
        chunks: [
          chunk({ id: 'b', chunk_index: 7, chapter_title: 'Wrong One' }),
          chunk({ id: 'a', chunk_index: 0, chapter_title: 'Knowing Our Numbers' }),
        ],
      }),
    );

    expect(plan.chapters[0]?.titleEn).toBe('Knowing Our Numbers');
    expect(plan.chapters[0]?.titleIsPlaceholder).toBe(false);
  });

  it('gives a title-less chapter a VISIBLE placeholder, not a plausible guess', () => {
    // `chapters.title_en` is NOT NULL with a non-empty CHECK, and only the
    // chunks table carries a title. A chapter known solely from questions would
    // otherwise abort the insert.
    const plan = buildImportPlan(extract({ questions: [question({ chapter_number: 3 })] }));

    expect(plan.chapters[0]?.titleEn).toBe('Chapter 3');
    expect(plan.chapters[0]?.titleIsPlaceholder).toBe(true);
  });
});

describe('chunks', () => {
  it('imports a chunk with NO EMBEDDING and records its id', () => {
    /**
     * D-078. The chunks with no vector are real content, reachable by full-text
     * search, and dropping them would make the corpus quietly smaller than the
     * source — the one outcome an import must never produce silently. They are
     * imported with a NULL embedding and listed so they can be re-embedded.
     */
    const plan = buildImportPlan(
      extract({
        chunks: [chunk({ id: 'has-vector' }), chunk({ id: 'no-vector', embedding: null })],
      }),
    );

    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunksWithoutEmbedding).toEqual(['no-vector']);
  });

  it('normalises both embedding-model labels onto one', () => {
    const plan = buildImportPlan(
      extract({
        chunks: [
          chunk({ id: 'a', embedding_model: 'voyage/voyage-3' }),
          chunk({ id: 'b', embedding_model: 'voyage-3' }),
        ],
      }),
    );

    expect(plan.chunks.map((c) => c.embeddingModel)).toEqual(['voyage-3', 'voyage-3']);
  });

  it('rejects an out-of-scope chunk with a reason rather than dropping it', () => {
    const plan = buildImportPlan(
      extract({
        chunks: [
          chunk({ id: 'g11', grade: 'Grade 11' }),
          chunk({ id: 'english', subject: 'English' }),
        ],
      }),
    );

    expect(plan.chunks).toEqual([]);
    expect(plan.rejectedChunks).toEqual([
      { id: 'g11', reason: 'grade-outside-pilot' },
      { id: 'english', reason: 'subject-unrecognised' },
    ]);
  });

  it('never plans a chunk without a chapter to link it to', () => {
    // "Every imported chunk has a chapter_id" is one of the import's stated
    // verification criteria, and it holds by construction: a chunk that could
    // not produce a chapter key is rejected, and a chapter key that exists is
    // always in `chapters` because `chapters` is derived from these same keys.
    const plan = buildImportPlan(
      extract({ chunks: [chunk({ id: 'a' }), chunk({ id: 'b', chapter_number: 2 })] }),
    );

    const chapterKeys = new Set(plan.chapters.map((c) => c.chapterKey));
    for (const planned of plan.chunks) {
      expect(chapterKeys.has(planned.chapterKey)).toBe(true);
    }
  });
});

describe('concept_graph is chapter-scoped, because there is no other key', () => {
  it('links an edge by the chapter triple and keeps its prerequisite codes', () => {
    /**
     * D-077 follow-up, stated as a limitation rather than papered over:
     * `concept_graph.concept_code` does NOT join to `chapter_concepts`. There is
     * no shared key and none is invented here. The only usable link is
     * `(grade, subject, chapter_number)`, so an edge is chapter-scoped and the
     * concept-level graph the product eventually wants is not something this
     * import can produce.
     */
    const plan = buildImportPlan(
      extract({ conceptEdges: [edge({ prerequisite_codes: ['counting', 'digits'] })] }),
    );

    expect(plan.conceptEdges[0]?.chapterKey).toBe('6|mathematics|1');
    expect(plan.conceptEdges[0]?.prerequisiteCodes).toEqual(['counting', 'digits']);
  });

  it('keeps an edge with no prerequisites as an empty list, not a null', () => {
    const plan = buildImportPlan(extract({ conceptEdges: [edge({ prerequisite_codes: null })] }));
    expect(plan.conceptEdges[0]?.prerequisiteCodes).toEqual([]);
  });
});

describe('misconceptions are imported orphaned, and the orphans are counted', () => {
  it('flags a misconception whose concept code is not in the graph', () => {
    const plan = buildImportPlan(
      extract({
        conceptEdges: [edge({ concept_code: 'place_value' })],
        misconceptions: [
          misconception({ id: 'resolved', concept_code: 'place_value' }),
          misconception({ id: 'orphan', concept_code: 'nowhere_to_be_found' }),
          misconception({ id: 'no-code', concept_code: null }),
        ],
      }),
    );

    expect(plan.misconceptions.map((m) => [m.sourceId, m.orphan])).toEqual([
      ['resolved', false],
      ['orphan', true],
      ['no-code', true],
    ]);
  });

  it('skips a misconception whose subject is outside pilot scope', () => {
    // No grade column exists on this table, so subject is the only scope there
    // is — and an unrecognised one is a skip, never a guess.
    const plan = buildImportPlan(
      extract({ misconceptions: [misconception({ subject: 'history_sr' })] }),
    );
    expect(plan.misconceptions).toEqual([]);
  });
});

describe('the reserve is computed over ELIGIBLE questions only', () => {
  it('does not let optionless questions push a chapter over the threshold', () => {
    /**
     * A chapter with 14 usable questions and 6 broken ones has 20 rows and 14
     * questions. Counting the rows would cross the 15 threshold and reserve 6 of
     * the 14 usable ones, leaving 8 to practise — a reserve funded by questions
     * that do not exist.
     */
    const usable = Array.from({ length: 14 }, (_, i) => question({ id: `ok-${String(i)}` }));
    const broken = Array.from({ length: 6 }, (_, i) =>
      question({ id: `bad-${String(i)}`, options: [] }),
    );

    const plan = buildImportPlan(extract({ questions: [...usable, ...broken] }));

    expect(plan.questions).toHaveLength(14);
    expect(plan.excludedQuestions).toHaveLength(6);
    expect(plan.reserves.get('6|mathematics|1')?.belowThreshold).toBe(true);
    expect(plan.reserves.get('6|mathematics|1')?.heldOut).toEqual([]);
  });

  it('never holds out a question that was excluded', () => {
    const usable = Array.from({ length: 20 }, (_, i) => question({ id: `ok-${String(i)}` }));
    const broken = [question({ id: 'bad', options: [] })];

    const plan = buildImportPlan(extract({ questions: [...usable, ...broken] }));
    const heldOut = plan.reserves.get('6|mathematics|1')?.heldOut ?? [];

    expect(heldOut.length).toBeGreaterThan(0);
    expect(heldOut).not.toContain('bad');
  });
});

describe('readiness reporting', () => {
  it('scores every derived chapter, including ones with nothing but questions', () => {
    const plan = buildImportPlan(
      extract({
        chunks: Array.from({ length: 20 }, (_, i) =>
          chunk({ id: `chunk-${String(i)}`, chunk_index: i }),
        ),
        concepts: Array.from({ length: 3 }, (_, i) => concept({ id: `c-${String(i)}` })),
        questions: Array.from({ length: 20 }, (_, i) => question({ id: `q-${String(i)}` })),
      }),
    );

    expect(plan.readiness).toEqual([
      {
        chapterKey: '6|mathematics|1',
        questions: 20,
        chunks: 20,
        concepts: 3,
        reserveReady: true,
        demoReady: true,
      },
    ]);
  });

  it('reports a chapter that has content but not enough of it', () => {
    const plan = buildImportPlan(
      extract({
        chunks: [chunk()],
        concepts: [concept()],
        questions: [question()],
      }),
    );

    expect(plan.readiness[0]?.reserveReady).toBe(false);
    expect(plan.readiness[0]?.demoReady).toBe(false);
  });
});

describe('the plan is a pure function of the extract', () => {
  it('produces an identical plan when built twice', () => {
    // What makes the import re-runnable: no clock, no randomness, no insertion
    // order. Two runs decide the same reserve, so `is_held_out` cannot drift.
    const input = extract({
      chunks: [chunk({ id: 'a' }), chunk({ id: 'b', chapter_number: 2 })],
      questions: Array.from({ length: 20 }, (_, i) => question({ id: `q-${String(i)}` })),
      concepts: [concept()],
      conceptEdges: [edge()],
      misconceptions: [misconception()],
    });

    const first = buildImportPlan(input);
    const second = buildImportPlan(input);

    expect(JSON.stringify(second.chapters)).toEqual(JSON.stringify(first.chapters));
    expect([...second.reserves.values()]).toEqual([...first.reserves.values()]);
    expect(second.readiness).toEqual(first.readiness);
  });
});
