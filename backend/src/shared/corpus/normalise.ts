/**
 * NORMALISATION — the one boundary the source's five spellings do not cross
 * (D-076).
 *
 * ===========================================================================
 * THE RULE: EVERY FUNCTION HERE EITHER RETURNS A CANONICAL VALUE OR RETURNS
 * `null`. NONE OF THEM PASSES ANYTHING THROUGH UNCHANGED.
 *
 * A normaliser with a fallthrough — `return raw` for anything it does not
 * recognise — is worse than no normaliser at all. It turns an unknown spelling
 * into a value that looks canonical, flows into `chapters.subject_code`, and
 * splits one subject into two sets that never join. The failure surfaces weeks
 * later as a chapter with no questions, and by then the rows are written.
 *
 * So an unrecognised value is `null`, the caller decides whether that is a skip
 * or an abort, and every skip is counted in the import report. Nothing is
 * dropped without a number next to it.
 *
 * ===========================================================================
 * WHY THE ALIAS TABLES ARE EXPLICIT AND NOT A `.toLowerCase().replace()`.
 *
 * A rule like "lowercase it and strip spaces" maps `'Mathematics'` to
 * `'mathematics'` and `'math'` to `'math'`, which are still two subjects. Any
 * rule general enough to unify those two is general enough to unify things that
 * are not the same subject — `'Social Studies'` and `'social_studies'` are, but
 * `'history_sr'` is a distinct decision the reconnaissance explicitly flagged as
 * needing one (D-076), not a string-manipulation outcome.
 *
 * An explicit table is longer and it is checkable. It also fails LOUDLY on a
 * spelling nobody has seen, which is the behaviour that matters.
 */

import {
  isGrade,
  isPilotGrade,
  isSubject,
  BLOOM_LEVELS,
  DIFFICULTIES,
  EMBEDDING_MODEL,
  type BloomLevel,
  type Difficulty,
  type Grade,
  type PilotGrade,
  type Subject,
} from '../constants/curriculum';

/**
 * Every source spelling of every canonical subject, measured across the five
 * tables the pilot reads.
 *
 * Keys are lower-cased and whitespace-trimmed before lookup — that much
 * normalisation is safe because it cannot MERGE two distinct subjects, only
 * tidy one. Everything beyond it is an explicit entry.
 */
const SUBJECT_ALIASES: Readonly<Record<string, Subject>> = {
  // rag_content_chunks
  mathematics: 'mathematics',
  science: 'science',
  // question_bank, chapter_concepts, concept_graph, misconception_patterns
  math: 'mathematics',
  maths: 'mathematics',
  // Seen in neither sample but a one-character difference from a real value, so
  // cheap to accept and expensive to discover at 2am mid-import.
  mathematic: 'mathematics',
  sciences: 'science',
};

/**
 * Strips the `Grade ` prefix `rag_content_chunks` and `concept_graph` carry.
 *
 * The prefix is matched case-insensitively and with any run of whitespace,
 * because the failure it guards against — `'Grade  9'` with two spaces reaching
 * the `'6'..'12'` CHECK — is an abort partway through a 4,686-row import.
 *
 * Returns `null` for anything that is not a grade the product recognises. Note
 * this is the FULL grade domain, `'6'`..`'12'`: pilot scope is a separate
 * question, asked by `normalisePilotGrade`, because "this is not a grade" and
 * "this is a grade the pilot does not cover" are different facts and the import
 * report counts them separately.
 */
export function normaliseGrade(raw: string | null | undefined): Grade | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const stripped = raw.trim().replace(/^grade\s+/i, '').trim();

  return isGrade(stripped) ? stripped : null;
}

/** `normaliseGrade`, narrowed to the pilot's grades 6-10. */
export function normalisePilotGrade(raw: string | null | undefined): PilotGrade | null {
  const grade = normaliseGrade(raw);

  return grade !== null && isPilotGrade(grade) ? grade : null;
}

/**
 * Maps a source subject spelling to the canonical vocabulary.
 *
 * Returns `null` — never the input — for anything unrecognised. See the header.
 */
export function normaliseSubject(raw: string | null | undefined): Subject | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');

  // A value that is ALREADY canonical passes through the same table rather than
  // by a separate branch, so there is one code path and one thing to test.
  if (isSubject(key)) {
    return key;
  }

  return SUBJECT_ALIASES[key] ?? null;
}

/**
 * Collapses the source's two labels for one model onto `'voyage-3'`.
 *
 * `'voyage/voyage-3'` and `'voyage-3'` are the same 1024-dimension model
 * (D-076). Anything else returns `null`: a chunk stamped with a model we do not
 * recognise is a chunk whose vector may not be 1024-wide or may not be in the
 * same space, and guessing is how a corpus ends up with two incompatible
 * embedding spaces in one column and a cosine distance that means nothing.
 *
 * `null` in, `null` out — an unstamped chunk is a fact, not an error.
 */
export function normaliseEmbeddingModel(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  const key = raw.trim().toLowerCase();

  if (key.length === 0) {
    return null;
  }

  return key === EMBEDDING_MODEL || key === `voyage/${EMBEDDING_MODEL}` ? EMBEDDING_MODEL : null;
}

/**
 * THE SOURCE STORES DIFFICULTY AS AN INTEGER, NOT AS OUR ORDINAL WORDS.
 *
 * This was found by reading the extracted file, not by reading the plan: every
 * one of the 3,791 `question_bank` rows carries `difficulty` as a NUMBER, and
 * the distribution is 1 × 1,023 · 2 × 1,816 · 3 × 937 · 4 × 8 · 5 × 7. The
 * previous `SourceQuestion` type declared it `string | null` and
 * `question-eligibility` called `.trim()` on it, which on a number is a
 * TypeError — the import would have died on its FIRST row (D-098).
 *
 * The mapping is 1 → easy, 2 → medium, 3 → hard, and **4 and 5 also map to
 * hard**. That last part is a judgement and it is written down rather than
 * hidden: our vocabulary has exactly three rungs (`DIFFICULTIES`), the source's
 * fourth and fifth rungs are unambiguously *harder* than its third, and there
 * are 15 such rows. Clamping is lossy in a direction that is safe — a question
 * shown as `hard` that was authored as 5 is mis-stated by a degree; a question
 * excluded is content lost.
 *
 * A STRING is also accepted, because a future extract may well carry the words:
 * `'Easy'` and `'medium'` both normalise. Anything else is `null`, per the
 * module rule — never a pass-through.
 */
export function normaliseDifficulty(raw: number | string | null | undefined): Difficulty | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 1) {
      return null;
    }
    if (raw < 2) {
      return 'easy';
    }
    return raw < 3 ? 'medium' : 'hard';
  }

  if (typeof raw !== 'string') {
    return null;
  }

  const key = raw.trim().toLowerCase();

  return (DIFFICULTIES as readonly string[]).includes(key) ? (key as Difficulty) : null;
}

/**
 * The one Bloom spelling difference the corpus actually contains.
 *
 * The source uses American `analyze` on 735 questions; our vocabulary is
 * British `analyse` (`BLOOM_LEVELS`). That is a SPELLING of the same level and
 * mapping it merges nothing.
 *
 * `infer` and `predict` — one question each — are NOT Bloom levels and get no
 * alias. `infer` sits somewhere between understand and analyse and `predict`
 * between apply and evaluate; picking one would be a guess written into the
 * data, where it would go on to drive question selection. They are excluded and
 * counted, which is what the exclusion report is for.
 */
const BLOOM_ALIASES: Readonly<Record<string, BloomLevel>> = {
  analyze: 'analyse',
};

export function normaliseBloomLevel(raw: string | null | undefined): BloomLevel | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const key = raw.trim().toLowerCase();

  if ((BLOOM_LEVELS as readonly string[]).includes(key)) {
    return key as BloomLevel;
  }

  return BLOOM_ALIASES[key] ?? null;
}

/**
 * A chapter number, or `null`.
 *
 * Rejects zero and negatives because `chapters.chapter_number` carries a
 * `> 0` CHECK, and rejects non-integers because a chapter is not fractional.
 * This is the only numeric normaliser that exists, and it exists because the
 * chapter number is a JOIN KEY: a bad one does not fail, it silently creates a
 * chapter nothing else links to.
 */
export function normaliseChapterNumber(raw: number | null | undefined): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    return null;
  }

  return raw;
}

/**
 * The identity of a chapter, as three normalised parts.
 *
 * This triple is the ONLY thing that links the five source tables to each other
 * — `concept_graph.concept_code` does not join to `chapter_concepts` and there
 * is no shared key to invent (D-077 follow-up). Everything the import links, it
 * links through here.
 */
export interface ChapterKey {
  readonly grade: PilotGrade;
  readonly subject: Subject;
  readonly chapterNumber: number;
}

/** A stable string form of a `ChapterKey`, for use as a Map key. */
export function chapterKeyOf(key: ChapterKey): string {
  return `${key.grade}|${key.subject}|${String(key.chapterNumber)}`;
}

/** Why a source row could not be reduced to a `ChapterKey`. */
export type ChapterKeyRejection =
  | 'grade-unrecognised'
  | 'grade-outside-pilot'
  | 'subject-unrecognised'
  | 'chapter-number-invalid';

export type ChapterKeyResult =
  | { readonly ok: true; readonly key: ChapterKey }
  | { readonly ok: false; readonly reason: ChapterKeyRejection };

/**
 * Reduces any source row's `(grade, subject, chapter_number)` to a canonical
 * `ChapterKey`, or says precisely why it could not.
 *
 * ONE function for all five tables, deliberately. The hybrid spelling in
 * `concept_graph` — chunk-style grade, question-style subject — is not a special
 * case here because neither normaliser was ever told which table it was serving.
 * A per-table normaliser would have made that hybrid a thing somebody had to
 * notice, and the reconnaissance flagged it as "easy to get wrong" precisely
 * because it is invisible.
 *
 * The four rejection reasons are distinct because they mean different things in
 * the report: `grade-outside-pilot` is expected and enormous (grades 11-12 and
 * every non-pilot subject), while `grade-unrecognised` on a pilot row is a
 * finding about the source that somebody should read.
 */
export function toChapterKey(row: {
  readonly grade: string | null;
  readonly subject: string | null;
  readonly chapter_number: number | null;
}): ChapterKeyResult {
  const subject = normaliseSubject(row.subject);
  if (subject === null) {
    return { ok: false, reason: 'subject-unrecognised' };
  }

  const anyGrade = normaliseGrade(row.grade);
  if (anyGrade === null) {
    return { ok: false, reason: 'grade-unrecognised' };
  }
  if (!isPilotGrade(anyGrade)) {
    return { ok: false, reason: 'grade-outside-pilot' };
  }

  const chapterNumber = normaliseChapterNumber(row.chapter_number);
  if (chapterNumber === null) {
    return { ok: false, reason: 'chapter-number-invalid' };
  }

  return { ok: true, key: { grade: anyGrade, subject, chapterNumber } };
}
