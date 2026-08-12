import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  BLOOM_LEVELS,
  DIFFICULTIES,
  DISTRACTORS_PER_QUESTION,
  EMBEDDING_DIMENSIONS,
  GRADES,
  OPTIONS_PER_QUESTION,
} from '../../../shared/constants/curriculum';
import { tsvector, vector } from '../column-types';

/**
 * content schema — 01-BACKEND-IMPLEMENTATION-PLAN.md §4, "content".
 *
 * Owns chapters, questions and RAG chunks. Assigned the `core` connection pool
 * (04-RESILIENCE-PLAN.md §3.1, wired in `src/app/module-pools.ts`) — note that
 * `retrieval` and `foxy` READ `rag_chunks` on the `ai` pool, which is the whole
 * point of §3.1: an expensive vector scan cannot hold a connection that an
 * ordinary chapter listing needs.
 */

const gradeList = sql.raw(GRADES.map((grade) => `'${grade}'`).join(', '));
const difficultyList = sql.raw(DIFFICULTIES.map((value) => `'${value}'`).join(', '));
const bloomList = sql.raw(BLOOM_LEVELS.map((value) => `'${value}'`).join(', '));

/**
 * The legal keys of `questions.distractor_misconceptions`: the option indexes,
 * as strings, because a jsonb object's keys are always text.
 *
 * Derived from `OPTIONS_PER_QUESTION` rather than written out, so widening a
 * question to five options cannot leave a constraint silently policing four.
 */
const optionKeyList = sql.raw(
  Array.from({ length: OPTIONS_PER_QUESTION }, (_unused, index) => `'${index}'`).join(', '),
);

/**
 * A CBSE chapter. The unit everything else hangs off: mastery is per chapter,
 * practice is per chapter, and retrieval filters by grade and subject.
 *
 * UNIQUE (grade, subject_code, chapter_number) is the natural key. The uuid is
 * the surrogate that foreign keys point at, so renumbering a chapter — which
 * the board does between syllabus revisions — does not orphan a student's
 * mastery history.
 *
 * `title_hi` is NULLABLE. P7 requires the UI to be bilingual, but a Hindi title
 * that has not been written yet must be absent rather than an English string
 * wearing a Hindi column name: a null is a visible gap the UI can fall back
 * from, whereas a copied English title is a silent claim to have translated it.
 */
export const chapters = pgTable(
  'chapters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** TEXT, "6".."12". See the long note on `students.grade`. */
    grade: text('grade').notNull(),
    subjectCode: text('subject_code').notNull(),
    chapterNumber: integer('chapter_number').notNull(),
    titleEn: text('title_en').notNull(),
    titleHi: text('title_hi'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('chapters_grade_subject_number_unique').on(
      table.grade,
      table.subjectCode,
      table.chapterNumber,
    ),
    check('chapters_grade_check', sql`${table.grade} in (${gradeList})`),
    check('chapters_chapter_number_check', sql`${table.chapterNumber} > 0`),
    check('chapters_title_en_check', sql`length(btrim(${table.titleEn})) > 0`),
    // NO separate (grade, subject_code) index: the UNIQUE index above is a
    // btree on exactly those columns in exactly that order, so it already
    // serves "every chapter for grade 8 Science, in order". A second index on
    // the same leading columns would cost every write and answer no query the
    // first cannot.
  ],
);

/**
 * A multiple-choice question.
 *
 * THE FOUR-OPTION RULE IS A DATABASE CONSTRAINT, NOT A VALIDATION (§8.3: "a
 * question with other than 4 options is rejected"). Application validation
 * protects the paths that run it; a CHECK protects the paths nobody remembered
 * — the bulk import, the admin fix-up, the psql session at 2am. A question with
 * three options renders a broken quiz for every student who draws it, and the
 * only place that can refuse it once and for all is Postgres.
 *
 * `correct_index` 0..3 combined with exactly four options means the index can
 * never point past the end of the array. Two cheap constraints that together
 * remove a whole class of runtime failure.
 *
 * ---------------------------------------------------------------------------
 * THE TWO ONE-WAY DOORS ON THIS TABLE (PROGRESS.md §8).
 *
 * Both columns are added NOW even though the data arrives later, because the
 * cost of adding them later is not a migration — it is re-authoring content.
 *
 * `distractor_misconceptions` — WHY the student picked that wrong option.
 * Without it a parent digest can only say "60 percent in Science", which is
 * what every competitor already says. "She is confusing mass with weight" is
 * the product. Retrofitting it means a human re-reading every question.
 *
 * `is_held_out` — questions reserved for INDEPENDENT mastery checks and never
 * served in practice. The moment a question has been practised, its answer may
 * have been memorised, and it can never again measure anything. Contamination
 * is irreversible: you cannot un-serve a question. Reserving the pool has to
 * happen before the first student sees the bank, which is now.
 * ---------------------------------------------------------------------------
 */
export const questions = pgTable(
  'questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    questionText: text('question_text').notNull(),
    /** Exactly four. Enforced by `questions_options_shape_check` below. */
    options: jsonb('options').notNull(),
    correctIndex: integer('correct_index').notNull(),
    explanation: text('explanation').notNull(),
    difficulty: text('difficulty').notNull(),
    bloomLevel: text('bloom_level').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /**
     * ONE-WAY DOOR 1. Three misconception codes, one per WRONG option.
     *
     * A JSONB OBJECT KEYED BY OPTION INDEX, not a positional array:
     *
     *     {"0": "confuses_mass_weight", "2": "unit_conversion_step", "3": "sign_error_negative"}
     *
     * The key equal to `correct_index` is ABSENT — a correct option has no
     * misconception to describe. Exactly three entries, every key in "0".."3".
     *
     * WHY THIS SHAPE, changed in migration 0003 before any data existed
     * (D-048). It was first specified as a positional array aligned by option
     * index ascending, skipping `correct_index`. That alignment is a rule held
     * outside the data, so reordering the options or correcting `correct_index`
     * re-points every code at a different option — and nothing errors. The
     * parent digest simply begins reporting the wrong misconception, which is
     * the one output this product exists to get right. Keys make the alignment
     * a property OF the value: reordering options can no longer move a code,
     * and correcting `correct_index` is refused outright by the CHECK unless
     * the codes are corrected with it.
     *
     * NULL until an author supplies the codes — absent is honest, a row of
     * placeholder codes is not.
     */
    distractorMisconceptions: jsonb('distractor_misconceptions'),
    /** ONE-WAY DOOR 2. Reserved for mastery checks; never served in practice. */
    isHeldOut: boolean('is_held_out').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * ONE constraint, not two, and a CASE rather than an AND chain. Both
     * details were found by a test rather than reasoned out in advance:
     *
     *  - POSTGRES DOES NOT GUARANTEE THE EVALUATION ORDER OF `AND`. Written as
     *    `jsonb_typeof(x) = 'array' and jsonb_array_length(x) = 4`, an
     *    `options` value of `{"a":1}` did not produce a constraint violation —
     *    it produced the raw error `cannot get array length of a non-array`,
     *    because the planner was free to evaluate the right operand first.
     *    `CASE` is the only construct that guarantees short-circuiting.
     *  - Two separate constraints meant a three-option question could be
     *    refused by EITHER, and it happened to be refused by the emptiness one.
     *    A test asserting "rejected because it has the wrong number of options"
     *    then failed while the database was behaving perfectly. One constraint
     *    is one message.
     *
     * `jsonb - text` removes matching string elements from an array, so an
     * empty-string option shortens it — that is how emptiness is detected
     * without a subquery, which a CHECK may not contain. That same restriction
     * is why "all four options are DISTINCT" is NOT expressible here and stays
     * a module-level rule.
     */
    check(
      'questions_options_check',
      sql`case when jsonb_typeof(${table.options}) = 'array'
                then jsonb_array_length(${table.options}) = ${sql.raw(String(OPTIONS_PER_QUESTION))}
                 and jsonb_array_length(${table.options} - '') = ${sql.raw(String(OPTIONS_PER_QUESTION))}
                else false
           end`,
    ),
    check(
      'questions_correct_index_check',
      sql`${table.correctIndex} >= 0 and ${table.correctIndex} < ${sql.raw(String(OPTIONS_PER_QUESTION))}`,
    ),
    check('questions_question_text_check', sql`length(btrim(${table.questionText})) > 0`),
    check('questions_explanation_check', sql`length(btrim(${table.explanation})) > 0`),
    check('questions_difficulty_check', sql`${table.difficulty} in (${difficultyList})`),
    check('questions_bloom_level_check', sql`${table.bloomLevel} in (${bloomList})`),
    /**
     * The misconception object — three rules in one constraint (D-048).
     *
     *  1. exactly three entries;
     *  2. every key is an option index, "0".."3";
     *  3. the key equal to `correct_index` is ABSENT.
     *
     * Rule 3 is the one that earns the shape change. It makes the constraint
     * reject the exact edit that used to corrupt the data silently: correcting
     * `correct_index` on a question whose codes were authored for the old
     * answer now fails loudly instead of re-labelling three misconceptions.
     *
     * Same CASE reasoning as the options check above — Postgres does not
     * guarantee `AND` evaluation order, so a non-object value must be rejected
     * by a branch rather than by an operand that happens to run second.
     *
     * WHY THESE PARTICULAR OPERATORS: a CHECK may not contain a subquery, which
     * rules out `jsonb_object_keys` (set-returning) and any aggregate.
     * `jsonb_path_query_array(x, '$.keyvalue()')` is a plain IMMUTABLE scalar
     * function that yields one array element per entry, so its length is the
     * entry count; `jsonb - text[]` deletes the four legal keys at once, and an
     * empty remainder means nothing illegal was present; `?` tests one key.
     *
     * NULL is allowed — the codes are authored later, and absent is honest
     * where a row of placeholders would not be.
     */
    check(
      'questions_distractor_misconceptions_check',
      sql`case
            when ${table.distractorMisconceptions} is null then true
            when jsonb_typeof(${table.distractorMisconceptions}) <> 'object' then false
            else jsonb_array_length(
                   jsonb_path_query_array(${table.distractorMisconceptions}, '$.keyvalue()')
                 ) = ${sql.raw(String(DISTRACTORS_PER_QUESTION))}
                 and ${table.distractorMisconceptions} - array[${optionKeyList}] = '{}'::jsonb
                 and not (${table.distractorMisconceptions} ? (${table.correctIndex})::text)
          end`,
    ),
    /**
     * THE serving query: "give me practice questions for this chapter".
     * `is_held_out` is in the index rather than left to a filter so that the
     * held-out reserve is excluded by the access path itself — the cheapest
     * possible reminder that practice must never see those rows.
     */
    index('questions_chapter_active_held_out_idx').on(
      table.chapterId,
      table.isActive,
      table.isHeldOut,
    ),
  ],
);

/**
 * The NCERT corpus — the substrate every grounded Foxy answer stands on.
 *
 * POPULATED BY A ONE-TIME IMPORT, not by hand (plan §4). The existing
 * production table `rag_content_chunks` holds ~16,000 rows, so this table is
 * shaped to make that import a COLUMN MAPPING rather than a transform: every
 * column below that also exists there keeps its source name, type and default.
 * A transform step is a place for 16,000 rows to be quietly corrupted.
 *
 * Deliberate departures from the source, each with a reason:
 *
 *  - `chapter_id` is NEW and NULLABLE. The source has no such column; §4
 *    requires it. The import leaves it null and a backfill joins
 *    (grade, subject, chapter_number) to `chapters`. Nullable permanently,
 *    because a chunk whose chapter is not in the syllabus table is still
 *    retrievable content and must not be lost to a NOT NULL.
 *  - `search_vector` is GENERATED ALWAYS ... STORED rather than a plain
 *    column. The import must NOT map it. This is the one place the straight
 *    mapping is broken on purpose: a hand-maintained tsvector goes stale the
 *    first time someone edits `chunk_text` and forgets, and a stale tsvector
 *    does not fail — the chunk simply stops appearing in keyword search,
 *    forever, silently. Regenerating 16,000 rows costs seconds.
 *  - `grade` carries the "6".."12" CHECK. The corpus is expected to satisfy it;
 *    if it does not, the import fails loudly on the offending row, which is the
 *    correct outcome — retrieval hard-filters by grade (§8.4 step 3), so a
 *    chunk with an out-of-range grade is unreachable content occupying an index.
 *    Pre-flight: `select distinct grade from rag_content_chunks`.
 *  - `language` deliberately carries NO check. Grade is a product invariant;
 *    language is a label, and a corpus that turns out to use 'en-IN' should not
 *    block a 16,000-row import at 2am.
 */
export const ragChunks = pgTable(
  'rag_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** NEW, nullable. Backfilled after import by (grade, subject, number). */
    chapterId: uuid('chapter_id').references(() => chapters.id, { onDelete: 'set null' }),
    chunkText: text('chunk_text').notNull(),
    chunkIndex: integer('chunk_index').notNull().default(0),
    chunkType: text('chunk_type').notNull().default('paragraph'),
    board: text('board').notNull().default('CBSE'),
    /** TEXT, "6".."12". Never an integer. */
    grade: text('grade').notNull(),
    subject: text('subject').notNull(),
    chapterNumber: integer('chapter_number'),
    chapterTitle: text('chapter_title'),
    topic: text('topic'),
    concept: text('concept'),
    difficultyLevel: integer('difficulty_level').default(2),
    contentLayer: text('content_layer').default('foundation'),
    language: text('language').default('en'),
    /**
     * voyage-3, 1024 dimensions. THE DIMENSION IS LOAD-BEARING: it matches the
     * existing corpus exactly, which is what makes the import a copy instead of
     * a re-embedding run costing money and days. Changing it invalidates every
     * stored vector at once.
     *
     * Nullable, because the source permits an un-embedded row and an import
     * that drops those rows is an import that loses content.
     */
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text('embedding_model'),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }),
    wordCount: integer('word_count'),
    tokenCount: integer('token_count'),
    qualityScore: doublePrecision('quality_score'),
    isActive: boolean('is_active').notNull().default(true),
    /**
     * GENERATED — never written. Chapter title, topic and concept are weighted
     * 'A' and the body 'B', so a keyword match in the heading outranks the same
     * word buried in a paragraph.
     *
     * The `language` CASE picks the text search configuration: 'english' stems
     * and removes English stopwords, which is wrong for Devanagari, so Hindi
     * chunks use 'simple' (tokenise, do not stem). Both `to_tsvector` calls use
     * the two-argument form with a literal configuration, which is IMMUTABLE
     * and therefore legal in a generated column; the one-argument form depends
     * on a session GUC and is not.
     */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`case when language = 'hi'
            then setweight(to_tsvector('simple', coalesce(chapter_title, '') || ' ' || coalesce(topic, '') || ' ' || coalesce(concept, '')), 'A')
              || setweight(to_tsvector('simple', coalesce(chunk_text, '')), 'B')
            else setweight(to_tsvector('english', coalesce(chapter_title, '') || ' ' || coalesce(topic, '') || ' ' || coalesce(concept, '')), 'A')
              || setweight(to_tsvector('english', coalesce(chunk_text, '')), 'B')
          end`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('rag_chunks_grade_check', sql`${table.grade} in (${gradeList})`),
    check('rag_chunks_chunk_text_check', sql`length(btrim(${table.chunkText})) > 0`),
    check('rag_chunks_chunk_index_check', sql`${table.chunkIndex} >= 0`),
    /**
     * HNSW, cosine — the dense half of §8.4.
     *
     * PARAMETERS: m = 16, ef_construction = 128. See the migration header for
     * the full reasoning; the short version is that m = 16 (the pgvector
     * default) is ample graph connectivity for a corpus of this size, while
     * ef_construction is DOUBLED from the default 64 because build cost on
     * 16,000 rows is seconds and the recall it buys is permanent.
     *
     * NOT PARTIAL, deliberately, unlike the filter index below. A partial HNSW
     * index is unusable by any query that omits its predicate, and the fallback
     * is a sequential scan over every vector — which on the `ai` pool's 5s
     * statement timeout reads as an outage rather than a slow query. The
     * filtering index can afford that fallback; this one cannot.
     */
    index('rag_chunks_embedding_hnsw')
      .using('hnsw', sql`${table.embedding} vector_cosine_ops`)
      .with({ m: 16, ef_construction: 128 }),
    /** GIN — the sparse half of §8.4. */
    index('rag_chunks_search_vector_gin').using('gin', table.searchVector),
    /**
     * The hard filter every retrieval query applies (§8.4 step 3: "a grade 7
     * query never returns grade 9 content"), PARTIAL on `is_active`.
     *
     * The partial predicate and the `is_active` requirement are one index
     * rather than two: retrieval never wants inactive chunks, so indexing them
     * is pure cost, and folding the predicate in makes an index that omits
     * `is_active` impossible to build by accident. A query that forgets the
     * predicate falls back to a sequential scan of a small table — acceptable,
     * unlike the vector case above.
     */
    index('rag_chunks_grade_subject_idx')
      .on(table.grade, table.subject)
      .where(sql`is_active`),
    /**
     * The FK column, indexed.
     *
     * An UNINDEXED foreign key is the classic quiet performance bug: every
     * `delete from chapters` has to sequentially scan this table to apply the
     * ON DELETE SET NULL, and it is also the access path for the post-import
     * backfill that populates the column in the first place.
     */
    index('rag_chunks_chapter_idx').on(table.chapterId),
  ],
);

export type ChapterRow = typeof chapters.$inferSelect;
export type NewChapterRow = typeof chapters.$inferInsert;
export type QuestionRow = typeof questions.$inferSelect;
export type NewQuestionRow = typeof questions.$inferInsert;
export type RagChunkRow = typeof ragChunks.$inferSelect;
export type NewRagChunkRow = typeof ragChunks.$inferInsert;
