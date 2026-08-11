/**
 * GENERATED — DO NOT EDIT.
 *
 * Source of truth: backend/src/shared/. Regenerate with
 * `npm run contracts:sync` from `frontend/`. `contracts-drift.test.ts`
 * fails when this file and its backend original disagree.
 */

/**
 * The curriculum vocabulary — the small closed sets that both the database
 * schema and every module have to agree on.
 *
 * They live in `shared/` rather than in a schema file for two reasons. The
 * schema files import each other (`learner.chapter_mastery` references
 * `content.chapters`, `content` needs the grade list), and a constant defined
 * in one of them makes that a cycle — which under drizzle-kit's CommonJS
 * transpilation is a temporal-dead-zone crash at generate time, not a warning.
 * More importantly, modules CANNOT import `platform/db` at all (ESLint
 * `no-restricted-imports`, plan §7.4), so a constant that only exists beside
 * the tables is a constant every module has to re-declare — and a re-declared
 * list is a list that drifts from the CHECK constraint enforcing it.
 *
 * One declaration, used by the CHECK constraint AND by the Zod contract.
 */

/**
 * GRADES ARE STRINGS. "6" to "12", never 6 to 12 — plan §3, hard rules.
 *
 * The failure this prevents is not a crash. `"6" !== 6` makes a filter match
 * nothing, so an integer grade shows up as an empty question list on one
 * screen for one cohort, and looks like missing content rather than a bug.
 */
export const GRADES = ['6', '7', '8', '9', '10', '11', '12'] as const;
export type Grade = (typeof GRADES)[number];

export function isGrade(value: unknown): value is Grade {
  return typeof value === 'string' && (GRADES as readonly string[]).includes(value);
}

/**
 * THE CANONICAL SUBJECT VOCABULARY (D-076).
 *
 * There is exactly one spelling of a subject in this system, and it is here.
 *
 * The source corpus does not agree with itself. Measured across the five tables
 * the pilot import reads, the same subject appears as `'Mathematics'` in
 * `rag_content_chunks` and as `'math'` in `question_bank`, `chapter_concepts`,
 * `concept_graph` and `misconception_patterns` — and `concept_graph` is a hybrid
 * that spells the GRADE like the chunks table and the SUBJECT like the question
 * table. Any two of those five joined without normalisation return zero rows,
 * and zero rows from a join reads as "this chapter has no questions" rather than
 * as a bug.
 *
 * `subject_code` columns carry no CHECK constraint, deliberately — a chapter is
 * curriculum data and the product will add subjects long before it adds a
 * migration. The vocabulary is enforced at the IMPORT boundary instead, which is
 * the only place source spellings ever enter.
 *
 * PILOT SCOPE IS TWO SUBJECTS. Grades 6-10, Mathematics and Science. Adding a
 * third means adding it here AND adding its source aliases to
 * `shared/corpus/normalise.ts` — an unmapped alias THROWS rather than passing
 * the raw string through, because a subject that silently keeps its source
 * spelling is a subject whose chapters split into two sets that never join.
 */
export const SUBJECTS = ['mathematics', 'science'] as const;
export type Subject = (typeof SUBJECTS)[number];

export function isSubject(value: unknown): value is Subject {
  return typeof value === 'string' && (SUBJECTS as readonly string[]).includes(value);
}

/**
 * The grades the pilot import covers: 6-10.
 *
 * A SUBSET of `GRADES`, not a replacement for it. The schema's CHECK still
 * admits '11' and '12' because the product does; the pilot simply has no
 * verified content for them yet (see the verification status note under D-079),
 * and importing an unverified grade would put content in front of students that
 * nobody has checked.
 */
export const PILOT_GRADES = ['6', '7', '8', '9', '10'] as const;
export type PilotGrade = (typeof PILOT_GRADES)[number];

export function isPilotGrade(value: unknown): value is PilotGrade {
  return typeof value === 'string' && (PILOT_GRADES as readonly string[]).includes(value);
}

/**
 * The one embedding model the corpus is allowed to claim.
 *
 * The source stamps the same vectors `'voyage/voyage-3'` and `'voyage-3'`
 * (D-076). Both are voyage-3 at 1024 dimensions and retrieval does not care —
 * but any exact-match filter, and any "which model produced this?" audit, sees
 * two models and gets the answer wrong. Normalised on the way in.
 */
export const EMBEDDING_MODEL = 'voyage-3';

/** The two languages the product ships in (P7). */
export const LANGUAGES = ['en', 'hi'] as const;
export type LanguageCode = (typeof LANGUAGES)[number];

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** Authored difficulty. Ordinal — the ladder order is easy < medium < hard. */
export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/**
 * Bloom's revised taxonomy, lowest to highest.
 *
 * British "analyse", matching the register the schema already uses
 * (`last_practised_at`). Bloom's is a technical term and is not translated for
 * the Hindi UI (P7).
 */
export const BLOOM_LEVELS = [
  'remember',
  'understand',
  'apply',
  'analyse',
  'evaluate',
  'create',
] as const;
export type BloomLevel = (typeof BLOOM_LEVELS)[number];

/**
 * How many options every question carries. Not a default, not a maximum —
 * exactly four, enforced by a CHECK constraint on `questions.options`.
 */
export const OPTIONS_PER_QUESTION = 4;

/** One misconception code per WRONG option, hence one fewer than the options. */
export const DISTRACTORS_PER_QUESTION = OPTIONS_PER_QUESTION - 1;

/** The embedding width of the existing corpus: voyage-3, 1024 dimensions. */
export const EMBEDDING_DIMENSIONS = 1024;
