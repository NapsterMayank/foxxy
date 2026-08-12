/**
 * The shapes the SOURCE corpus arrives in, before anything is normalised.
 *
 * ===========================================================================
 * WHY THESE TYPES EXIST SEPARATELY FROM THE SCHEMA TYPES.
 *
 * It would be shorter to read the source straight into the shape of our own
 * tables. That is exactly the transform D-040 refuses: a single step that both
 * RESHAPES and VALIDATES is a step where a wrong row and a right row take the
 * same path, and 4,686 of them go past too fast to look at.
 *
 * So the pipeline is two typed stages with a named boundary between them. A
 * `Source*` row is whatever the old system happens to hold — grades spelled five
 * different ways, subjects spelled two, embeddings that are sometimes absent.
 * Nothing downstream of `normalise.ts` may accept one.
 *
 * ===========================================================================
 * EVERY FIELD IS `| null` UNLESS THE SOURCE GUARANTEES OTHERWISE.
 *
 * These are not our columns and we do not control their constraints. A field
 * typed non-null here is a claim about a database this repository cannot see,
 * and the cost of being wrong is a crash partway through an import that has
 * already written half its rows. Optionality is the honest default; the
 * normalisers are where absence turns into either a value or a rejection.
 *
 * ===========================================================================
 * CORRECTED 10 AUGUST 2026 AGAINST THE EXTRACTED FILES (D-098).
 *
 * The first version of this file was written from the reconnaissance notes,
 * before `.corpus-extract/` existed. Four of the five shapes were wrong, and
 * three of the four were wrong in the SILENT direction — a mis-named optional
 * field reads as `undefined`, the normaliser returns `null`, and the row is
 * skipped with a plausible-looking reason:
 *
 *  | Declared | Actually in the file | Consequence had it shipped |
 *  |---|---|---|
 *  | `SourceQuestion.difficulty: string` | a NUMBER, 1-5 | `.trim()` on a number — a TypeError on row 1. LOUD, and the only one of the four that was |
 *  | `SourceChapterConcept.concept_name` | `title` | every one of the 639 concepts skipped |
 *  | `SourceChapterConcept.explanation_en` | `explanation` | every explanation silently null |
 *  | `SourceMisconception.misconception_code` | `pattern_code` | every one of the 57 patterns skipped |
 *  | `SourceMisconception.description_en` / `description_hi` | `description`, no Hindi at all | descriptions silently null |
 *
 * The lesson is the reason the two-stage pipeline exists at all: the shape of
 * the source is a MEASUREMENT, never an expectation. Every field below was read
 * out of the NDJSON with a key scan, and `tests/integration/corpus-import.test.ts`
 * re-reads the real files so that a future extract with a renamed column fails
 * a test rather than quietly importing nothing.
 */

/**
 * A 1024-dimension voyage-3 vector, or `null` for a chunk that has none.
 *
 * The Grade 9 Science chunks with no vector are imported WITH the null rather
 * than skipped (D-078). They are real content and they are reachable by
 * full-text search; dropping them would make the corpus quietly smaller than
 * the source, which is the one outcome an import must never produce silently.
 *
 * The WIDTH is not encoded in this type and cannot be: TypeScript will not
 * check the length of an array read out of a database. It is checked at
 * runtime, once, in `chunk-import.ts`, against `EMBEDDING_DIMENSIONS`.
 */
export type SourceEmbedding = readonly number[] | null;

/** `rag_content_chunks` — grades as `'Grade 6'`, subjects as `'Mathematics'`. */
export interface SourceChunk {
  readonly id: string;
  readonly grade: string | null;
  readonly subject: string | null;
  readonly chapter_number: number | null;
  readonly chapter_title: string | null;
  readonly chunk_text: string | null;
  readonly chunk_index: number | null;
  readonly chunk_type: string | null;
  readonly board: string | null;
  readonly topic: string | null;
  readonly concept: string | null;
  readonly difficulty_level: number | null;
  readonly content_layer: string | null;
  readonly language: string | null;
  readonly embedding: SourceEmbedding;
  readonly embedding_model: string | null;
  readonly embedded_at: string | null;
  readonly word_count: number | null;
  readonly token_count: number | null;
  readonly quality_score: number | null;
  readonly is_active: boolean | null;
}

/** `question_bank` — grades as `'6'`, subjects as `'math'`. */
export interface SourceQuestion {
  readonly id: string;
  readonly grade: string | null;
  readonly subject: string | null;
  readonly chapter_number: number | null;
  readonly question_text: string | null;
  /**
   * `unknown`, not `string[]`, and that is the point.
   *
   * 1,045 of the 3,791 in-scope rows carry an EMPTY array here, and nothing in
   * the source stops a row carrying an object, a string, or three options
   * instead of four. Typing it as an array would make `options.length` compile
   * and then throw at runtime on the one row that is not one. It is narrowed
   * once, in `question-eligibility.ts`, and every rejection is reported.
   */
  readonly options: unknown;
  readonly correct_answer_index: number | null;
  readonly explanation: string | null;
  /**
   * AN INTEGER, 1-5 — not `'easy' | 'medium' | 'hard'`. See `normaliseDifficulty`.
   *
   * `number | string` rather than `number`, because the union is what forces
   * the call site through the normaliser instead of through `.trim()` or a
   * comparison that happens to compile.
   */
  readonly difficulty: number | string | null;
  /** American `analyze` on 735 rows; also two values that are not Bloom levels. */
  readonly bloom_level: string | null;
}

/**
 * `chapter_concepts` — grades as `'6'`, subjects as `'math'`.
 *
 * The name-bearing column is `title`, NOT `concept_name`, and the English
 * explanation is `explanation`, NOT `explanation_en`. Both were wrong in the
 * first draft and both failed silently (D-098).
 */
export interface SourceChapterConcept {
  readonly id: string;
  readonly grade: string | null;
  readonly subject: string | null;
  readonly chapter_number: number | null;
  readonly title: string | null;
  readonly title_hi: string | null;
  /** Position within the chapter. Not unique across chapters. */
  readonly concept_number: number | null;
  readonly slug: string | null;
  readonly learning_objective: string | null;
  readonly explanation: string | null;
  readonly explanation_hi: string | null;
  readonly key_formula: string | null;
  readonly example_content: string | null;
  /**
   * `unknown` for the same reason `SourceQuestion.options` is: it is a jsonb
   * array in the source and nothing there guarantees its element type. Narrowed
   * once, in `planConcepts`.
   */
  readonly common_mistakes: unknown;
}

/**
 * `concept_graph` — THE HYBRID, and the one that is easy to get wrong.
 *
 * Grades are spelled `'Grade 6'` like the CHUNKS table; subjects are spelled
 * `'math'` like the QUESTION table. Normalising it with either table's rule
 * alone gets exactly half of it right, and the half that is wrong produces no
 * error — just a chapter key that matches nothing.
 */
export interface SourceConceptEdge {
  readonly id: string;
  readonly grade: string | null;
  readonly subject: string | null;
  readonly chapter_number: number | null;
  readonly concept_code: string | null;
  readonly concept_name: string | null;
  readonly prerequisite_codes: readonly string[] | null;
  readonly bloom_level: string | null;
  /** Intrinsic load, as the source scored it. Carried through unvalidated. */
  readonly cognitive_load: number | null;
}

/**
 * `misconception_patterns` — NO GRADE COLUMN AT ALL.
 *
 * Subject-scoped and nothing finer, so these rows cannot be filtered by grade
 * and cannot be attached to a chapter. They are imported subject-scoped, which
 * is all the source supports.
 *
 * The identifying column is `pattern_code`, not `misconception_code`, the
 * description column is `description`, and THERE IS NO HINDI DESCRIPTION AT
 * ALL — the first draft declared `description_hi` and there is no such column
 * (D-098). That is a P7 gap in the source, recorded rather than papered over.
 */
export interface SourceMisconception {
  readonly id: string;
  readonly subject: string | null;
  readonly concept_code: string | null;
  readonly pattern_code: string | null;
  readonly description: string | null;
  /** A jsonb matcher, e.g. `{trigger, wrong_pattern}`. Opaque to the import. */
  readonly detection_rule: unknown;
  readonly remediation_strategy: string | null;
  readonly remediation_concept_codes: readonly string[] | null;
  /** The source's 1-5 urgency score. Carried through unvalidated. */
  readonly severity: number | null;
}

/** Everything one extraction run produces, in one value. */
export interface SourceExtract {
  readonly chunks: readonly SourceChunk[];
  readonly questions: readonly SourceQuestion[];
  readonly concepts: readonly SourceChapterConcept[];
  readonly conceptEdges: readonly SourceConceptEdge[];
  readonly misconceptions: readonly SourceMisconception[];
}
