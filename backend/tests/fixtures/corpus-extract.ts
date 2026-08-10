import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { makeEmbedding, toVectorLiteral } from './embedding';

/**
 * A SYNTHETIC `.corpus-extract/`, written to a temp directory.
 *
 * ===========================================================================
 * WHY THE IMPORT IS TESTED AGAINST THIS AND NOT ONLY AGAINST THE REAL EXTRACT.
 *
 * The real `.corpus-extract/` is 77 MB and gitignored — it exists on one
 * machine and will not survive a fresh clone or a CI runner. A test suite whose
 * only coverage of a 700-line import script depended on that directory would be
 * a suite that reports "import: covered" while running nothing at all, which is
 * the same failure mode as the hardcoded migration list (D-046, D-075): a claim
 * about the world that nothing checks.
 *
 * So the import is exercised twice, and the two are complementary:
 *
 *   THIS FIXTURE      always runs. Small, deterministic, and shaped to contain
 *                     every case that matters — the three source spellings of
 *                     one chapter, the hybrid `concept_graph` row, an optionless
 *                     question, a chunk with no vector, an orphan misconception,
 *                     one chapter over the reserve threshold and one under it.
 *
 *   `corpus-import-real.test.ts`   runs only where the real extract is present,
 *                     and asserts the MEASURED counts (4,686 / 2,741 / 639 /
 *                     176 / 57). It is the check that the shapes still match the
 *                     source; this fixture cannot be, because it is written from
 *                     the same understanding the importer holds.
 *
 * ===========================================================================
 * THE VALUES ARE RAW, AS THE SOURCE HOLDS THEM.
 *
 * Chunks spell the grade `'Grade 6'` and the subject `'Mathematics'`; questions
 * spell them `'6'` and `'math'`; `concept_graph` is the hybrid, `'Grade 6'` with
 * `'math'` (D-076). Writing canonical values here would make the fixture agree
 * with the importer by construction and test nothing about normalisation, which
 * is the single most expensive thing this import can get wrong: unnormalised,
 * those three rows describe three different chapters and neither half joins.
 *
 * The embeddings are the deterministic synthetic vectors from `embedding.ts`
 * and carry NO meaning. They exercise the pgvector column, the HNSW index and
 * the distance operator; they say nothing about retrieval quality.
 */

/** Enough to clear `MIN_QUESTIONS_FOR_RESERVE` (15) with room to spare. */
const RESERVE_READY_QUESTIONS = 20;
/** Deliberately under the threshold, so "no reserve" is exercised too. */
const THIN_QUESTIONS = 4;

export interface FixtureExtractShape {
  readonly dir: string;
  readonly chunkCount: number;
  readonly eligibleQuestionCount: number;
  readonly excludedQuestionCount: number;
  readonly conceptCount: number;
  readonly edgeCount: number;
  readonly misconceptionCount: number;
  /** The chapter with enough questions to carry a reserve. */
  readonly reserveChapterKey: string;
  /** The chapter with too few. */
  readonly thinChapterKey: string;
}

function ndjson(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

/**
 * A source uuid that is stable across runs, so the derived UUIDv5s are too.
 *
 * `prefix` must be hex — the ids end up in `uuid` columns, and a fixture that
 * writes `q3000000-...` produces an insert error rather than the assertion
 * failure that would explain it.
 */
function id(prefix: string, index: number): string {
  if (!/^[0-9a-f]{2}$/.test(prefix)) {
    throw new Error(`fixture id prefix ${prefix} is not two hex characters`);
  }
  return `${prefix}000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

export function writeFixtureExtract(): FixtureExtractShape {
  const dir = mkdtempSync(resolve(tmpdir(), 'corpus-fixture-'));
  mkdirSync(dir, { recursive: true });

  const chunks: unknown[] = [];
  let cursor = 0;

  const pushChunk = (
    grade: string,
    subject: string,
    chapterNumber: number,
    chapterTitle: string | null,
    text: string,
    chunkIndex: number,
    embedded: boolean,
  ): void => {
    cursor += 1;
    chunks.push({
      id: id('c1', cursor),
      grade,
      subject,
      chapter_number: chapterNumber,
      chapter_title: chapterTitle,
      chunk_text: text,
      chunk_index: chunkIndex,
      chunk_type: 'concept_explanation',
      board: 'CBSE',
      topic: 'Whole Numbers',
      concept: 'Place value',
      difficulty_level: 2,
      content_layer: 'foundation',
      language: 'en',
      // The pgvector TEXT form, exactly as `to_jsonb` renders it.
      embedding: embedded ? toVectorLiteral(makeEmbedding(`chunk-${String(cursor)}`)) : null,
      // Both source spellings of the one model, so the normaliser is exercised
      // — and `mistral-embed` on the un-embedded chunk, exactly as the real
      // extract stamps its 20 vectorless rows. An unrecognised model normalises
      // to NULL rather than passing through: a chunk whose vector may not be in
      // our space must not claim to be.
      embedding_model: embedded ? (cursor % 2 === 0 ? 'voyage-3' : 'voyage/voyage-3') : 'mistral-embed',
      word_count: 40,
      token_count: 55,
      quality_score: 0.8,
      is_active: true,
    });
  };

  // The reserve-ready chapter: Grade 6 Mathematics chapter 1, spelled the way
  // the CHUNKS table spells it.
  for (let index = 0; index < 24; index += 1) {
    pushChunk(
      'Grade 6',
      'Mathematics',
      1,
      index === 0 ? 'Knowing Our Numbers' : null,
      // One chunk carries the distinctive phrase the full-text test searches
      // for, so "the GIN path returns rows" is asserted against a real query
      // rather than against `select *`.
      index === 3
        ? 'The place value of a digit tells you what the digit is worth in a numeral.'
        : `Whole numbers passage number ${String(index)} about comparing and ordering numbers.`,
      index,
      // One chunk with NO vector, per D-078: real content, reachable by
      // full-text search, imported with a NULL rather than dropped.
      index !== 7,
    );
  }

  // The thin chapter: Grade 7 Science chapter 2.
  for (let index = 0; index < 3; index += 1) {
    pushChunk(
      'Grade 7',
      'Science',
      2,
      index === 0 ? 'Nutrition in Plants' : null,
      `Photosynthesis passage number ${String(index)}.`,
      index,
      true,
    );
  }

  const questions: unknown[] = [];
  for (let index = 0; index < RESERVE_READY_QUESTIONS; index += 1) {
    questions.push({
      id: id('a1', index),
      // The QUESTION table's spelling of the same chapter as the chunks above.
      grade: '6',
      subject: 'math',
      chapter_number: 1,
      question_text: `What is the place value of the digit in position ${String(index)}?`,
      options: ['Ones', 'Tens', 'Hundreds', 'Thousands'],
      correct_answer_index: index % 4,
      explanation: 'Place value is determined by the position of the digit.',
      // The INTEGER scale the source really uses (D-098): 1 easy, 2 medium, 3 hard.
      difficulty: (index % 3) + 1,
      // American spelling on some, so the alias is exercised.
      bloom_level: index % 2 === 0 ? 'analyze' : 'understand',
    });
  }

  for (let index = 0; index < THIN_QUESTIONS; index += 1) {
    questions.push({
      id: id('a2', index),
      grade: '7',
      subject: 'science',
      chapter_number: 2,
      question_text: `Which part of the plant makes food, variant ${String(index)}?`,
      options: ['Root', 'Stem', 'Leaf', 'Flower'],
      correct_answer_index: 2,
      explanation: 'Leaves contain chlorophyll and carry out photosynthesis.',
      difficulty: 2,
      bloom_level: 'remember',
    });
  }

  // THE EXCLUSIONS, one per reason the real extract actually produces.
  const excluded: unknown[] = [
    {
      id: id('a3', 1),
      grade: '6',
      subject: 'math',
      chapter_number: 1,
      question_text: 'A question whose options were never generated.',
      options: [],
      correct_answer_index: null,
      explanation: 'Explanation without options.',
      difficulty: 2,
      bloom_level: 'understand',
    },
    {
      id: id('a3', 2),
      grade: '6',
      subject: 'math',
      chapter_number: 1,
      question_text: 'A question whose four options are not four distinct options.',
      options: ['1274', '1274', '1274', '1274'],
      correct_answer_index: 0,
      explanation: 'Unanswerable.',
      difficulty: 2,
      bloom_level: 'understand',
    },
    {
      id: id('a3', 3),
      grade: '6',
      subject: 'math',
      chapter_number: 1,
      question_text: 'A question tagged with something that is not a Bloom level.',
      options: ['A', 'B', 'C', 'D'],
      correct_answer_index: 1,
      explanation: 'Valid in every way except the taxonomy label.',
      difficulty: 2,
      bloom_level: 'infer',
    },
    {
      id: id('a3', 4),
      // Outside pilot scope. Expected and enormous in the real extract.
      grade: '11',
      subject: 'math',
      chapter_number: 1,
      question_text: 'A grade 11 question.',
      options: ['A', 'B', 'C', 'D'],
      correct_answer_index: 1,
      explanation: 'Out of scope.',
      difficulty: 2,
      bloom_level: 'understand',
    },
  ];
  questions.push(...excluded);

  const concepts: unknown[] = [
    {
      id: id('cc', 1),
      grade: '6',
      subject: 'math',
      chapter_number: 1,
      title: 'Place value',
      title_hi: 'स्थानीय मान',
      concept_number: 1,
      slug: 'place-value',
      learning_objective: 'Read and write large numbers.',
      explanation: 'Each digit has a place value determined by its position.',
      explanation_hi: 'प्रत्येक अंक का एक स्थानीय मान होता है।',
      key_formula: null,
      example_content: '5,432 = 5000 + 400 + 30 + 2',
      common_mistakes: ['Ignoring a zero placeholder', 'Reading digits right to left'],
    },
    {
      id: id('cc', 2),
      grade: '6',
      subject: 'math',
      chapter_number: 1,
      title: 'Comparing numbers',
      title_hi: null,
      concept_number: 2,
      slug: null,
      learning_objective: 'Order numbers by size.',
      explanation: 'Compare digit by digit from the left.',
      explanation_hi: null,
      key_formula: null,
      example_content: null,
      common_mistakes: [],
    },
    {
      id: id('cc', 3),
      grade: '7',
      subject: 'science',
      chapter_number: 2,
      title: 'Photosynthesis',
      title_hi: null,
      concept_number: 1,
      slug: null,
      learning_objective: 'Explain how plants make food.',
      explanation: 'Chlorophyll captures light energy.',
      explanation_hi: null,
      key_formula: null,
      example_content: null,
      common_mistakes: [],
    },
  ];

  const edges: unknown[] = [
    {
      id: id('ce', 1),
      // THE HYBRID: chunk-style grade, question-style subject.
      grade: 'Grade 6',
      subject: 'math',
      chapter_number: 1,
      concept_code: 'math_6_ch1',
      concept_name: 'Chapter 1 — Math',
      prerequisite_codes: ['math_6_ch0'],
      bloom_level: 'understand',
      cognitive_load: 2,
    },
    {
      id: id('ce', 2),
      grade: 'Grade 7',
      subject: 'science',
      chapter_number: 2,
      concept_code: 'science_7_ch2',
      concept_name: 'Chapter 2 — Science',
      prerequisite_codes: [],
      bloom_level: 'remember',
      cognitive_load: 3,
    },
  ];

  const misconceptions: unknown[] = [
    {
      id: id('bb', 1),
      subject: 'math',
      // Resolves against `concept_graph`, so `is_orphan` must be false.
      concept_code: 'math_6_ch1',
      pattern_code: 'PLACE.VALUE.ZERO',
      description: 'Treats 502 as 52 by dropping the zero placeholder.',
      detection_rule: { trigger: 'place_value', wrong_pattern: 'zero_dropped' },
      remediation_strategy: 'Expand the number column by column.',
      remediation_concept_codes: ['math_6_ch1'],
      severity: 4,
    },
    {
      id: id('bb', 2),
      subject: 'science',
      // Resolves against nothing. Imported, FLAGGED, counted — never dropped.
      concept_code: 'science.9.ch1.nowhere',
      pattern_code: 'PHOTO.LIGHT.ONLY',
      description: 'Believes plants need only light, not water or carbon dioxide.',
      detection_rule: { trigger: 'photosynthesis', wrong_pattern: 'light_only' },
      remediation_strategy: 'Run the covered-leaf experiment.',
      remediation_concept_codes: [],
      severity: 3,
    },
    {
      id: id('bb', 3),
      // Outside the pilot subject vocabulary — a skip, never a guess.
      subject: 'history_sr',
      concept_code: null,
      pattern_code: 'HIST.CHRONOLOGY',
      description: 'Out of scope.',
      detection_rule: null,
      remediation_strategy: null,
      remediation_concept_codes: [],
      severity: 1,
    },
  ];

  writeFileSync(resolve(dir, 'chunks.ndjson'), ndjson(chunks), 'utf8');
  writeFileSync(resolve(dir, 'questions.ndjson'), ndjson(questions), 'utf8');
  writeFileSync(resolve(dir, 'concepts.ndjson'), ndjson(concepts), 'utf8');
  writeFileSync(resolve(dir, 'concept-graph.ndjson'), ndjson(edges), 'utf8');
  writeFileSync(resolve(dir, 'misconceptions.ndjson'), ndjson(misconceptions), 'utf8');

  return {
    dir,
    chunkCount: chunks.length,
    eligibleQuestionCount: RESERVE_READY_QUESTIONS + THIN_QUESTIONS,
    excludedQuestionCount: excluded.length,
    conceptCount: concepts.length,
    edgeCount: edges.length,
    // The `history_sr` row is skipped, so two of the three land.
    misconceptionCount: 2,
    reserveChapterKey: '6|mathematics|1',
    thinChapterKey: '7|science|2',
  };
}
