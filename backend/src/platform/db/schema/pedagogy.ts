import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { chapters } from './content';

/**
 * pedagogy schema — the three tables the corpus import needs and the baseline
 * did not have (migration `0001_pedagogy`).
 *
 * ===========================================================================
 * WHY THESE ARRIVE NOW AND NOT WITH A MODULE.
 *
 * The corpus extract carries 639 chapter concepts, 176 prerequisite edges and
 * 57 misconception patterns that exist NOWHERE ELSE. The source database has
 * been read for the last time (D-095) and its password is being rotated
 * (D-096). Content that is not landed by this import is content that has to be
 * re-authored, so the tables land ahead of the modules that will read them —
 * the same argument `practice.ts` and `tenants.ts` already carry.
 *
 * The columns are derived from `PlannedConcept`, `PlannedConceptEdge` and
 * `PlannedMisconception` in `shared/corpus/import-plan.ts`. That is deliberate:
 * the shapes were settled by a pure, tested module before any DDL existed, so
 * this file has no opinion of its own to drift from.
 *
 * ===========================================================================
 * NO `tenant_id` ON ANY OF THE THREE, AND THAT IS NOT AN OVERSIGHT.
 *
 * D-073 made `tenant_id` NOT NULL on the six tables carrying STUDENT-OWNED
 * data, and `assertCanAccess` denies a missing tenant on either side. None of
 * these three is student-owned: they are CURRICULUM, exactly like `chapters`,
 * `questions` and `rag_chunks`, none of which carries a tenant either. Grade 8
 * Science chapter 4's misconceptions are the same misconceptions in every
 * tenant, and giving them a tenant would mean either duplicating the corpus per
 * tenant or writing a NOT NULL column that only ever holds the default — which
 * is precisely the theatre D-073 rejected.
 *
 * The access boundary for this data is `chapter_id` → `chapters`, and the
 * student-facing question is "may this student see this chapter?", answered
 * where it already is.
 *
 * ===========================================================================
 * THE KNOWN LIMITATION, RECORDED IN SCHEMA RATHER THAN IN A COMMENT SOMEWHERE
 * ELSE: `concept_graph.concept_code` DOES NOT JOIN TO `chapter_concepts`.
 *
 * They are two independently-generated vocabularies. `chapter_concepts` has no
 * code column at all — its identity is a title and an ordinal — while
 * `concept_graph` codes look like `math_6_ch10`, `m8.rational.ops` and
 * `math.9.ch7.triangles`, three schemes from three generation runs. There is no
 * shared key, and NONE IS INVENTED HERE: no foreign key, no lookup table, no
 * string-munging join. The only honest link between a concept, an edge and a
 * misconception is the chapter, and that is the link the schema expresses.
 *
 * `misconception_patterns.is_orphan` is the same fact made countable: 39 of the
 * 57 patterns name a `concept_code` that no edge in scope carries.
 */

/**
 * A named concept within a chapter — the unit an explanation is written about.
 *
 * `chapter_id` is NOT NULL. A concept whose chapter could not be resolved is
 * rejected by the import with a reason rather than stored dangling, because a
 * concept with no chapter is unreachable by every read path there will ever be
 * (all of them start from a chapter) while still counting toward "639 concepts
 * imported".
 *
 * There is NO unique index on (chapter_id, title_en): the extract genuinely
 * contains two concepts with the same title in the same chapter. Identity is
 * the deterministic UUIDv5 of the source id, which is what makes the import
 * re-runnable.
 */
export const chapterConcepts = pgTable(
  'chapter_concepts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    /** Ordinal within the chapter. Not unique — the source repeats them. */
    conceptNumber: integer('concept_number'),
    slug: text('slug'),
    titleEn: text('title_en').notNull(),
    /** Present on 629 of 639 — the corpus is unusually good here (P7). */
    titleHi: text('title_hi'),
    learningObjective: text('learning_objective'),
    explanationEn: text('explanation_en'),
    explanationHi: text('explanation_hi'),
    exampleContent: text('example_content'),
    keyFormula: text('key_formula'),
    /**
     * A jsonb ARRAY of strings, never null — `[]` means "none recorded".
     *
     * Null and empty would be the same fact stored two ways, and every reader
     * would have to handle both. The default plus NOT NULL removes the choice.
     */
    commonMistakes: jsonb('common_mistakes').notNull().default(sql`'[]'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('chapter_concepts_chapter_idx').on(table.chapterId, table.conceptNumber),
  ],
);

/**
 * A prerequisite edge, scoped to a chapter because that is the only key there
 * is. See the file header.
 *
 * `prerequisite_codes` is a text ARRAY rather than an edge-per-row join table,
 * because that is the shape the source holds and because nothing yet traverses
 * it. Normalising a graph nobody walks is speculative work, and the array can
 * be exploded into rows by a later migration without re-reading a source
 * database that no longer answers.
 */
export const conceptGraph = pgTable(
  'concept_graph',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    /**
     * Unique across the whole table — verified in the extract: 176 rows, 176
     * distinct codes. The uniqueness is enforced because a duplicate code would
     * make `prerequisite_codes` ambiguous, which is the one thing that would
     * make this table unusable.
     */
    conceptCode: text('concept_code').notNull(),
    conceptName: text('concept_name'),
    /** Codes only — they may point at rows that do not exist, so NO foreign key. */
    prerequisiteCodes: text('prerequisite_codes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * NO CHECK, unlike `questions.bloom_level`.
     *
     * A question's level drives selection, so an unrecognised one must not be
     * stored. An edge's is descriptive metadata on a graph nothing reads yet,
     * and a CHECK here would mean dropping a prerequisite relationship — which
     * cannot be recovered — over a label that nothing consumes.
     */
    bloomLevel: text('bloom_level'),
    cognitiveLoad: integer('cognitive_load'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('concept_graph_concept_code_unique').on(table.conceptCode),
    index('concept_graph_chapter_idx').on(table.chapterId),
  ],
);

/**
 * A named way students get something wrong, with its remediation.
 *
 * SUBJECT-SCOPED AND NOTHING FINER, because the source table has no grade
 * column at all. These cannot be filtered by grade and cannot be attached to a
 * chapter; storing them subject-scoped is not a simplification, it is the whole
 * of what the source supports.
 *
 * `is_orphan` records, per row, that `concept_code` resolves to nothing in
 * `concept_graph`. It is stored rather than computed on read because the answer
 * depends on what was in scope AT IMPORT TIME, and a later import that widens
 * scope should be able to show that a pattern stopped being orphaned.
 */
export const misconceptionPatterns = pgTable(
  'misconception_patterns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectCode: text('subject_code').notNull(),
    /** May name a concept that does not exist. See `is_orphan`. No foreign key. */
    conceptCode: text('concept_code'),
    patternCode: text('pattern_code').notNull(),
    description: text('description'),
    /**
     * NO `description_hi`, and its absence is the record of a P7 gap.
     *
     * The source has no Hindi column on this table — not "usually null", the
     * column does not exist (D-098). A nullable `description_hi` here would
     * read as "translations are pending" when in fact nothing has ever been
     * written; the honest form is to add the column with the translations.
     */
    detectionRule: jsonb('detection_rule'),
    remediationStrategy: text('remediation_strategy'),
    remediationConceptCodes: text('remediation_concept_codes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    severity: integer('severity'),
    /** True when `concept_code` matched no `concept_graph` row at import time. */
    isOrphan: boolean('is_orphan').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('misconception_patterns_pattern_code_unique').on(table.patternCode),
    index('misconception_patterns_subject_idx').on(table.subjectCode),
  ],
);

export type ChapterConceptRow = typeof chapterConcepts.$inferSelect;
export type NewChapterConceptRow = typeof chapterConcepts.$inferInsert;
export type ConceptGraphRow = typeof conceptGraph.$inferSelect;
export type NewConceptGraphRow = typeof conceptGraph.$inferInsert;
export type MisconceptionPatternRow = typeof misconceptionPatterns.$inferSelect;
export type NewMisconceptionPatternRow = typeof misconceptionPatterns.$inferInsert;
