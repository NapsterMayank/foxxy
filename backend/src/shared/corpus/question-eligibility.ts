/**
 * WHICH SOURCE QUESTIONS MAY BE IMPORTED, AND WHY THE REST MAY NOT.
 *
 * ===========================================================================
 * THE MEASURED FACT THIS MODULE EXISTS FOR.
 *
 * Of the ~3,791 source questions in pilot scope, only ~2,746 carry four
 * options. The other ~1,045 carry an EMPTY options array. They are not
 * damaged in transit and they are not a parsing artefact — the source's
 * generation pipeline wrote the stem, the answer index and the explanation, and
 * never wrote the options.
 *
 * A question with no options cannot be answered, cannot be scored, and violates
 * the four-option CHECK on `questions.options` (D-039). The import cannot
 * "fix" them; the only honest outcomes are to exclude them or to regenerate
 * them, and regeneration is a content job, not an import job.
 *
 * ===========================================================================
 * EXCLUDED IS NOT DROPPED. THAT DISTINCTION IS THE WHOLE MODULE.
 *
 * The easy implementation is a `.filter()`, and it is the wrong one: it makes
 * a quarter of the question bank vanish with no record of which quarter. The
 * chapter that lost all fifteen of its questions looks identical to a chapter
 * that never had any, and the regeneration job that should target exactly those
 * 1,045 ids has nothing to target.
 *
 * So `partitionQuestions` returns BOTH sides, every exclusion carries the id and
 * a named reason, and the importer writes the excluded set to a report file
 * before it writes a single row. A number in a log line is not a report — it
 * cannot be fed back into anything.
 */

import {
  OPTIONS_PER_QUESTION,
  type BloomLevel,
  type Difficulty,
} from '../constants/curriculum';
import {
  normaliseBloomLevel,
  normaliseDifficulty,
  toChapterKey,
  type ChapterKey,
  type ChapterKeyRejection,
} from './normalise';
import type { SourceQuestion } from './source-shapes';

/**
 * Why a source question was not imported.
 *
 * Every one of these maps to a CHECK constraint or to pilot scope, so the list
 * is not a matter of taste: importing a row that fails any of them aborts the
 * transaction, which on a 3,791-row insert means discovering it after the good
 * rows are already gone.
 */
export type QuestionRejection =
  | ChapterKeyRejection
  | 'options-not-an-array'
  | 'options-wrong-count'
  | 'options-empty-string'
  | 'options-not-distinct'
  | 'correct-index-out-of-range'
  | 'question-text-empty'
  | 'explanation-empty'
  | 'difficulty-invalid'
  | 'bloom-level-invalid';

export interface ExcludedQuestion {
  readonly id: string;
  readonly reason: QuestionRejection;
}

/** A source question reduced to exactly what our `questions` table accepts. */
export interface EligibleQuestion {
  readonly sourceId: string;
  readonly chapter: ChapterKey;
  readonly questionText: string;
  readonly options: readonly [string, string, string, string];
  readonly correctIndex: number;
  readonly explanation: string;
  readonly difficulty: Difficulty;
  readonly bloomLevel: BloomLevel;
}

export interface QuestionPartition {
  readonly eligible: readonly EligibleQuestion[];
  readonly excluded: readonly ExcludedQuestion[];
}

function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Narrows the source's `unknown` options to four distinct non-empty strings.
 *
 * The order of the checks is the order the reasons should be REPORTED in, which
 * is not the same as the order a CHECK constraint would evaluate them. D-039
 * records what happens when two overlapping constraints can both refuse the
 * same row: the message names whichever rule happened to run first, and a
 * three-option question gets reported as "an option was empty". Here the count
 * is checked before the contents, so a three-option question is always reported
 * as a three-option question.
 *
 * DISTINCTNESS is checked here and NOT by a CHECK constraint, because a CHECK
 * may not contain a subquery and distinctness needs aggregation — this is the
 * content-module rule D-039 left homeless, finally given a home on the one
 * write path that exists (open item 4).
 */
function narrowOptions(
  raw: unknown,
): { readonly ok: true; readonly options: readonly [string, string, string, string] } | {
  readonly ok: false;
  readonly reason: QuestionRejection;
} {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'options-not-an-array' };
  }

  const values: unknown[] = raw;

  if (values.length !== OPTIONS_PER_QUESTION) {
    return { ok: false, reason: 'options-wrong-count' };
  }

  const strings: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return { ok: false, reason: 'options-empty-string' };
    }
    strings.push(value);
  }

  if (new Set(strings.map((option) => option.trim())).size !== OPTIONS_PER_QUESTION) {
    return { ok: false, reason: 'options-not-distinct' };
  }

  const [a, b, c, d] = strings;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    // Unreachable: the length was checked above. Present because the tuple type
    // is the thing that stops `correctIndex` pointing past the end, and a cast
    // would remove exactly the guarantee this function exists to provide.
    return { ok: false, reason: 'options-wrong-count' };
  }

  return { ok: true, options: [a, b, c, d] };
}

function classify(row: SourceQuestion): EligibleQuestion | QuestionRejection {
  const chapter = toChapterKey(row);
  if (!chapter.ok) {
    return chapter.reason;
  }

  const options = narrowOptions(row.options);
  if (!options.ok) {
    return options.reason;
  }

  if (
    typeof row.correct_answer_index !== 'number' ||
    !Number.isInteger(row.correct_answer_index) ||
    row.correct_answer_index < 0 ||
    row.correct_answer_index >= OPTIONS_PER_QUESTION
  ) {
    return 'correct-index-out-of-range';
  }

  if (!isNonEmpty(row.question_text)) {
    return 'question-text-empty';
  }

  if (!isNonEmpty(row.explanation)) {
    return 'explanation-empty';
  }

  // THROUGH THE NORMALISER, not through `.trim()`. The source stores difficulty
  // as an integer 1-5 (D-098); the previous `.trim()` was a TypeError waiting
  // for the first row. `normaliseBloomLevel` folds American `analyze` onto
  // British `analyse` and refuses `infer` / `predict`, which are not Bloom
  // levels and get no guess.
  const difficulty = normaliseDifficulty(row.difficulty);
  if (difficulty === null) {
    return 'difficulty-invalid';
  }

  const bloomLevel = normaliseBloomLevel(row.bloom_level);
  if (bloomLevel === null) {
    return 'bloom-level-invalid';
  }

  return {
    sourceId: row.id,
    chapter: chapter.key,
    questionText: row.question_text,
    options: options.options,
    correctIndex: row.correct_answer_index,
    explanation: row.explanation,
    difficulty,
    bloomLevel,
  };
}

/**
 * Splits the source questions into the ones that may be imported and the ones
 * that may not, with a reason for every exclusion.
 *
 * Returns both halves. There is no variant that returns only the eligible ones,
 * for the same reason `getQuestionsForChapter` has no parameter that could
 * return a held-out question (D-052): the protection has to be the SHAPE of the
 * interface, because the discipline of the caller is what fails.
 */
export function partitionQuestions(rows: readonly SourceQuestion[]): QuestionPartition {
  const eligible: EligibleQuestion[] = [];
  const excluded: ExcludedQuestion[] = [];

  for (const row of rows) {
    const outcome = classify(row);
    if (typeof outcome === 'string') {
      excluded.push({ id: row.id, reason: outcome });
    } else {
      eligible.push(outcome);
    }
  }

  return { eligible, excluded };
}

/** Counts by reason, for the import report's summary line. */
export function countByReason(
  excluded: readonly ExcludedQuestion[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of excluded) {
    counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  }
  return counts;
}
