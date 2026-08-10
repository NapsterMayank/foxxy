import {
  DISTRACTORS_PER_QUESTION,
  OPTIONS_PER_QUESTION,
  type BloomLevel,
  type Difficulty,
  type Grade,
  type LanguageCode,
} from '../../src/shared/constants/curriculum';
import { makeEmbedding } from './embedding';

/**
 * Fixture factories — plan §9.5: "each test builds its own data through a
 * fixture factory", no shared mutable state.
 *
 * EVERY FACTORY PRODUCES A ROW THAT SATISFIES EVERY CHECK CONSTRAINT. That is
 * the contract of this file and the reason it is worth having: a test that
 * wants to prove a constraint REJECTS something starts from a valid row and
 * breaks exactly one field, so the assertion is about that field and nothing
 * else. A fixture that is only accidentally valid turns every such test into a
 * guess about which constraint actually fired.
 *
 * Each factory takes a `seed` and a partial override. The seed makes the row
 * deterministic and distinguishable; the override is how a test says what it
 * actually cares about.
 */

/** The shape a `chapters` row is inserted with. */
export interface ChapterFixture {
  grade: Grade;
  subjectCode: string;
  chapterNumber: number;
  titleEn: string;
  titleHi: string | null;
  isActive: boolean;
}

/** The shape a `questions` row is inserted with. */
export interface QuestionFixture {
  questionText: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  difficulty: Difficulty;
  bloomLevel: BloomLevel;
  isActive: boolean;
  /**
   * Keyed by OPTION INDEX as a string, correct option absent. Not an array —
   * see `misconceptionsFor` and migration 0003.
   */
  distractorMisconceptions: Record<string, string> | null;
  isHeldOut: boolean;
}

/** The shape a `rag_chunks` row is inserted with. Note: NO `searchVector`. */
export interface RagChunkFixture {
  chunkText: string;
  chunkIndex: number;
  chunkType: string;
  board: string;
  grade: Grade;
  subject: string;
  chapterNumber: number | null;
  chapterTitle: string | null;
  topic: string | null;
  concept: string | null;
  difficultyLevel: number;
  contentLayer: string;
  language: LanguageCode;
  embedding: number[];
  embeddingModel: string;
  wordCount: number;
  tokenCount: number;
  qualityScore: number;
  isActive: boolean;
}

/** The shape a `students` row is inserted with. */
export interface StudentFixture {
  displayName: string;
  /** A STRING. "6".."12". See the note on `students.grade`. */
  grade: Grade;
  board: string;
  preferredLanguage: LanguageCode;
}

export function makeChapter(seed: string, overrides: Partial<ChapterFixture> = {}): ChapterFixture {
  return {
    grade: '8',
    subjectCode: 'science',
    chapterNumber: 1,
    titleEn: `Chapter ${seed}`,
    titleHi: `अध्याय ${seed}`,
    isActive: true,
    ...overrides,
  };
}

/**
 * A valid four-option question, misconception codes included.
 *
 * The default carries `distractorMisconceptions` rather than leaving it null,
 * because the column is one-way door 1 and a fixture that omits it lets every
 * downstream test be written as though the column does not exist. The default
 * should look like the world we are building, not the world before it.
 *
 * ALIGNMENT, matching the COMMENT ON COLUMN in migration 0003: the codes are a
 * jsonb OBJECT KEYED BY OPTION INDEX, with the correct option's key absent.
 * The helper below derives them from `correctIndex`, so a test that changes
 * the correct answer cannot end up with codes the constraint refuses.
 */
export function makeQuestion(
  seed: string,
  overrides: Partial<QuestionFixture> = {},
): QuestionFixture {
  const correctIndex = overrides.correctIndex ?? 0;
  const options =
    overrides.options ??
    Array.from({ length: OPTIONS_PER_QUESTION }, (_unused, index) => `${seed} option ${index}`);

  return {
    questionText: `Question ${seed}?`,
    options,
    correctIndex,
    explanation: `Because of ${seed}.`,
    difficulty: 'medium',
    bloomLevel: 'understand',
    isActive: true,
    distractorMisconceptions: misconceptionsFor(seed, correctIndex),
    isHeldOut: false,
    ...overrides,
  };
}

/**
 * The misconception codes for a question, in the shape the column requires: an
 * object keyed by option index as a string, with `correctIndex` absent.
 *
 * Exported because the keying rule has exactly one implementation. A test that
 * wants "the code for option 2" asks for `codes['2']` — which is the point of
 * migration 0003. Under the previous positional array the same question was
 * "which element is option 2?", and the answer depended on `correct_index`,
 * which is precisely how a reordering mislabels everything in silence.
 */
export function misconceptionsFor(seed: string, correctIndex: number): Record<string, string> {
  const codes: Record<string, string> = {};
  for (let index = 0; index < OPTIONS_PER_QUESTION; index += 1) {
    if (index === correctIndex) continue;
    codes[String(index)] = `${seed}-misconception-opt${index}`;
  }
  // An out-of-range `correctIndex` — 4, or -1 — skips nothing and leaves FOUR
  // entries, which the constraint refuses for having the wrong entry count
  // rather than for the reason the test is about. Trimming to three is
  // deliberate: a test that supplies a deliberately invalid correct_index is
  // testing `questions_correct_index_check`, and it must actually reach the
  // database to do that. An earlier version threw here instead, and the effect
  // was two constraint tests failing inside the fixture without ever issuing a
  // statement — green constraint, red suite, message pointing at the wrong
  // file entirely.
  const keys = Object.keys(codes).slice(0, DISTRACTORS_PER_QUESTION);
  return Object.fromEntries(keys.map((key) => [key, codes[key] ?? '']));
}

/**
 * A corpus chunk with a deterministic 1024-dimension embedding.
 *
 * `searchVector` is ABSENT from the fixture type on purpose: the column is
 * GENERATED ALWAYS ... STORED and Postgres refuses an insert that names it. A
 * fixture field for it would compile, fail at runtime, and read as a database
 * problem rather than a fixture one.
 */
export function makeRagChunk(
  seed: string,
  overrides: Partial<RagChunkFixture> = {},
): RagChunkFixture {
  const chunkText =
    overrides.chunkText ??
    `Photosynthesis is the process by which green plants make food. Reference ${seed}.`;

  return {
    chunkText,
    chunkIndex: 0,
    chunkType: 'paragraph',
    board: 'CBSE',
    grade: '8',
    subject: 'science',
    chapterNumber: 1,
    chapterTitle: 'Crop Production and Management',
    topic: 'Photosynthesis',
    concept: 'Food production in plants',
    difficultyLevel: 2,
    contentLayer: 'foundation',
    language: 'en',
    // Seeded from the SEED, not from the text: a test that overrides the text
    // to change what full-text search matches must not accidentally move the
    // vector too, or it can no longer tell which half of the hybrid pipeline
    // it just exercised.
    embedding: makeEmbedding(seed),
    embeddingModel: 'voyage-3',
    wordCount: chunkText.split(/\s+/).length,
    tokenCount: Math.ceil(chunkText.length / 4),
    qualityScore: 0.9,
    isActive: true,
    ...overrides,
  };
}

export function makeStudent(seed: string, overrides: Partial<StudentFixture> = {}): StudentFixture {
  return {
    displayName: `Student ${seed}`,
    grade: '8',
    board: 'CBSE',
    preferredLanguage: 'en',
    ...overrides,
  };
}
