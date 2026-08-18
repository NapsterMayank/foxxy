import type { Actor } from '@/platform/authz/index';
import type { BloomLevel, Difficulty, Grade } from '@/shared/constants/curriculum';

/**
 * Internal types for the content module. Nothing here is public except where
 * `index.ts` re-exports it deliberately.
 */

export type ContentActor = Actor;

export interface ChapterRecord {
  readonly id: string;
  /** A STRING, "6".."12". Never a number. */
  readonly grade: Grade;
  readonly subjectCode: string;
  readonly chapterNumber: number;
  readonly titleEn: string;
  readonly titleHi: string | null;
  readonly isActive: boolean;
}

/**
 * A question, SERVER-SIDE ONLY.
 *
 * This type deliberately has no counterpart in `shared/contracts/`. It carries
 * `correctIndex` and `distractorMisconceptions`, and the shared contract folder
 * is imported by the frontend — a wire shape holding the answer is one import
 * away from a client that can read it before submitting.
 */
export interface QuestionRecord {
  readonly id: string;
  readonly chapterId: string;
  readonly questionText: string;
  /** Exactly four, guaranteed by `questions_options_check`. */
  readonly options: readonly string[];
  /** 0..3, guaranteed by `questions_correct_index_check`. */
  readonly correctIndex: number;
  readonly explanation: string;
  readonly difficulty: Difficulty;
  readonly bloomLevel: BloomLevel;
  /**
   * Misconception codes KEYED BY OPTION INDEX, the correct option's key
   * absent — migration 0003, D-048. `null` until an author supplies them.
   *
   * Read it as `misconceptions[String(selectedIndex)]`. Under the previous
   * positional array the same lookup required knowing `correct_index` and
   * counting, which is how a reordering used to mislabel every code in silence.
   */
  readonly distractorMisconceptions: Readonly<Record<string, string>> | null;
  /** TRUE = reserved for independent mastery checks. Never served in practice. */
  readonly isHeldOut: boolean;
}

/** A corpus chunk. The shape `retrieval` will hydrate its search hits with. */
export interface ChunkRecord {
  readonly id: string;
  readonly chapterId: string | null;
  readonly chunkText: string;
  readonly chunkIndex: number;
  readonly grade: Grade;
  readonly subject: string;
  readonly chapterNumber: number | null;
  readonly chapterTitle: string | null;
  readonly topic: string | null;
  readonly concept: string | null;
  /**
   * `string`, not `LanguageCode`, and that is deliberate rather than lazy.
   *
   * `rag_chunks.language` carries NO CHECK constraint (see the schema note):
   * grade is a product invariant, language is a label, and a corpus that turns
   * out to use 'en-IN' must not block a 16,000-row import at 2am. Typing this
   * as the narrow union would be a claim the database does not back.
   */
  readonly language: string;
  readonly qualityScore: number | null;
}

/** The filter every chapter listing applies. */
export interface ChapterFilter {
  readonly grade?: Grade | undefined;
  readonly subjectCode?: string | undefined;
  readonly limit: number;
}

/**
 * What a question request must state.
 *
 * `grade` and `subjectCode` are REQUIRED, not optional. §8.3 requires
 * questions to be filtered by grade and subject, and an optional filter is one
 * a caller forgets — at which point a grade 7 student is served a grade 9
 * question and the only symptom is that practice suddenly feels hard.
 */
export interface QuestionQuery {
  readonly chapterId: string;
  readonly grade: Grade;
  readonly subjectCode: string;
  readonly limit: number;
}

/**
 * One concept of a chapter, as this module reads it.
 *
 * Mirrors `chapterConceptSchema` on the wire. It is a separate declaration
 * because the module type may one day carry fields the wire must not — the same
 * separation `QuestionRecord` keeps, and for the same reason.
 */
export interface ConceptRecord {
  readonly id: string;
  readonly conceptNumber: number | null;
  readonly titleEn: string;
  readonly titleHi: string | null;
  readonly learningObjective: string | null;
  readonly explanationEn: string | null;
  readonly explanationHi: string | null;
  readonly exampleContent: string | null;
  readonly keyFormula: string | null;
  readonly commonMistakes: readonly string[];
}
