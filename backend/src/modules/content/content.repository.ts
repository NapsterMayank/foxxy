import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import type { DbHandle } from '@/platform/db/index';
import { schema } from '@/platform/db/index';
import type { BloomLevel, Difficulty, Grade } from '@/shared/constants/curriculum';
import type {
  ChapterFilter,
  ChapterRecord,
  ChunkRecord,
  QuestionQuery,
  QuestionRecord,
} from './content.types';

/**
 * ALL database access for the content module — §7, rule 4.
 *
 * Enforced by ESLint: `@/platform/db` and `drizzle-orm` are importable only
 * from a `*.repository.ts` file.
 */

const { chapters, questions, ragChunks } = schema;

export type ContentDbHandle = DbHandle;

/**
 * WHICH POOL OF QUESTIONS A QUERY WANTS.
 *
 * A named union, NOT a boolean, and not a parameter with a default. This is
 * the mechanical half of the held-out reserve (PROGRESS.md §8, one-way door 2)
 * and the shape of the parameter is the protection:
 *
 *   `heldOut = false` as a default is a value a caller never has to think
 *   about, which means a caller who thinks about it wrongly — or copies a call
 *   site — reaches the reserve by omission. And reaching it once is
 *   irreversible: a question that has been served in practice may have been
 *   memorised, so it can never measure anything again. You cannot un-serve a
 *   question.
 *
 * A required discriminated value forces every call site to say, in words,
 * which pool it is asking for. The service never exposes it at all — it offers
 * two separately named functions (see `content.service.ts`).
 */
export type QuestionPool = 'practice' | 'held-out';

interface ChapterRow {
  id: string;
  grade: string;
  subjectCode: string;
  chapterNumber: number;
  titleEn: string;
  titleHi: string | null;
  isActive: boolean;
}

/** `grade` is narrowed on the strength of `chapters_grade_check`. */
function toChapterRecord(row: ChapterRow): ChapterRecord {
  return {
    id: row.id,
    grade: row.grade as Grade,
    subjectCode: row.subjectCode,
    chapterNumber: row.chapterNumber,
    titleEn: row.titleEn,
    titleHi: row.titleHi,
    isActive: row.isActive,
  };
}

interface QuestionRow {
  id: string;
  chapterId: string;
  questionText: string;
  options: unknown;
  correctIndex: number;
  explanation: string;
  difficulty: string;
  bloomLevel: string;
  distractorMisconceptions: unknown;
  isHeldOut: boolean;
}

/**
 * jsonb arrives as `unknown`, so it is NARROWED rather than cast.
 *
 * `as string[]` would compile and then hand a malformed row straight through
 * to a quiz screen, where four options render as `undefined`. The CHECK
 * constraint makes that all but impossible — which is exactly why a violation
 * reaching here means something is wrong that a silent cast would hide.
 */
function toOptions(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((option) => typeof option === 'string')) {
    throw new Error('questions.options is not an array of strings');
  }
  return value;
}

/**
 * The misconception object, narrowed.
 *
 * Shape as of migration 0003: keys are option indexes as strings, the correct
 * option's key absent (D-048). Anything else is a row that predates the
 * migration or was written around the constraint, and it is refused rather
 * than half-read.
 */
function toMisconceptions(value: unknown): Readonly<Record<string, string>> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('questions.distractor_misconceptions is not an object keyed by option index');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, code]) => typeof code === 'string')) {
    throw new Error('questions.distractor_misconceptions holds a non-string code');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function toQuestionRecord(row: QuestionRow): QuestionRecord {
  return {
    id: row.id,
    chapterId: row.chapterId,
    questionText: row.questionText,
    options: toOptions(row.options),
    correctIndex: row.correctIndex,
    explanation: row.explanation,
    // Narrowed on the strength of `questions_difficulty_check` and
    // `questions_bloom_level_check`.
    difficulty: row.difficulty as Difficulty,
    bloomLevel: row.bloomLevel as BloomLevel,
    distractorMisconceptions: toMisconceptions(row.distractorMisconceptions),
    isHeldOut: row.isHeldOut,
  };
}

interface ChunkRow {
  id: string;
  chapterId: string | null;
  chunkText: string;
  chunkIndex: number;
  grade: string;
  subject: string;
  chapterNumber: number | null;
  chapterTitle: string | null;
  topic: string | null;
  concept: string | null;
  language: string | null;
  qualityScore: number | null;
}

function toChunkRecord(row: ChunkRow): ChunkRecord {
  return {
    id: row.id,
    chapterId: row.chapterId,
    chunkText: row.chunkText,
    chunkIndex: row.chunkIndex,
    grade: row.grade as Grade,
    subject: row.subject,
    chapterNumber: row.chapterNumber,
    chapterTitle: row.chapterTitle,
    topic: row.topic,
    concept: row.concept,
    language: row.language ?? 'en',
    qualityScore: row.qualityScore,
  };
}

export interface ContentRepository {
  listChapters(filter: ChapterFilter): Promise<ChapterRecord[]>;
  findChapterById(id: string): Promise<ChapterRecord | null>;
  /** `pool` is required. See the note on `QuestionPool`. */
  findQuestions(query: QuestionQuery, pool: QuestionPool): Promise<QuestionRecord[]>;
  findChunksByIds(ids: readonly string[]): Promise<ChunkRecord[]>;
}

export function createContentRepository(handle: ContentDbHandle): ContentRepository {
  const { db } = handle;

  return {
    /**
     * INACTIVE CHAPTERS ARE NEVER RETURNED, and the predicate is unconditional
     * rather than a filter option. `is_active = false` is how a chapter is
     * withdrawn; a listing that could be asked to include withdrawn chapters
     * is one that will be, by a caller passing a flag through from a query
     * string.
     *
     * Ordered by (grade, subject, chapter_number) — which is both the order a
     * syllabus is read in and the exact column order of
     * `chapters_grade_subject_number_unique`, so the sort is index-backed
     * rather than a sort node.
     */
    async listChapters(filter: ChapterFilter): Promise<ChapterRecord[]> {
      const conditions: SQL[] = [eq(chapters.isActive, true)];
      if (filter.grade !== undefined) conditions.push(eq(chapters.grade, filter.grade));
      if (filter.subjectCode !== undefined) {
        conditions.push(eq(chapters.subjectCode, filter.subjectCode));
      }

      const rows = await db
        .select()
        .from(chapters)
        .where(and(...conditions))
        .orderBy(asc(chapters.grade), asc(chapters.subjectCode), asc(chapters.chapterNumber))
        .limit(filter.limit);

      return rows.map(toChapterRecord);
    },

    async findChapterById(id: string): Promise<ChapterRecord | null> {
      const rows = await db
        .select()
        .from(chapters)
        .where(and(eq(chapters.id, id), eq(chapters.isActive, true)))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toChapterRecord(row);
    },

    /**
     * Questions for one chapter, hard-filtered by grade and subject.
     *
     * THE JOIN IS THE FILTER. `questions` carries no grade or subject of its
     * own — they belong to the chapter — so grade and subject are enforced by
     * joining `chapters` and constraining there. That makes "questions are
     * filtered by grade and subject" (§8.3) a property of the QUERY rather
     * than of the caller passing the right chapter id, and it means a chapter
     * id from the wrong grade returns an empty list instead of grade 9
     * questions to a grade 7 student.
     *
     * Withdrawn chapters and inactive questions are both excluded here and
     * cannot be asked for.
     *
     * `is_held_out` is matched against the requested pool. The three
     * predicates — chapter, active, held-out — are the exact leading columns
     * of `questions_chapter_active_held_out_idx`, so the reserve is separated
     * by the ACCESS PATH itself rather than by a filter applied after the rows
     * are read.
     */
    async findQuestions(query: QuestionQuery, pool: QuestionPool): Promise<QuestionRecord[]> {
      const rows = await db
        .select({
          id: questions.id,
          chapterId: questions.chapterId,
          questionText: questions.questionText,
          options: questions.options,
          correctIndex: questions.correctIndex,
          explanation: questions.explanation,
          difficulty: questions.difficulty,
          bloomLevel: questions.bloomLevel,
          distractorMisconceptions: questions.distractorMisconceptions,
          isHeldOut: questions.isHeldOut,
        })
        .from(questions)
        .innerJoin(chapters, eq(chapters.id, questions.chapterId))
        .where(
          and(
            eq(questions.chapterId, query.chapterId),
            eq(questions.isActive, true),
            eq(questions.isHeldOut, pool === 'held-out'),
            eq(chapters.isActive, true),
            eq(chapters.grade, query.grade),
            eq(chapters.subjectCode, query.subjectCode),
          ),
        )
        .orderBy(asc(questions.id))
        .limit(query.limit);

      return rows.map(toQuestionRecord);
    },

    /**
     * Hydrates chunks by id — what `retrieval` calls after it has ranked.
     *
     * Deliberately minimal: no vector, no tsvector, no embedding metadata.
     * `retrieval` has already done the ranking on the `ai` pool and needs the
     * TEXT and the citation fields; shipping a 1024-float array back per chunk
     * for fifty chunks would be several megabytes of traffic per answer for
     * data nobody reads.
     *
     * An EMPTY id list short-circuits. `in ()` is not valid SQL, and an
     * abstaining retrieval turn legitimately produces no ids — that path must
     * return an empty array rather than raise (§8.4: "an empty result abstains
     * rather than throwing").
     */
    async findChunksByIds(ids: readonly string[]): Promise<ChunkRecord[]> {
      if (ids.length === 0) return [];

      const rows = await db
        .select({
          id: ragChunks.id,
          chapterId: ragChunks.chapterId,
          chunkText: ragChunks.chunkText,
          chunkIndex: ragChunks.chunkIndex,
          grade: ragChunks.grade,
          subject: ragChunks.subject,
          chapterNumber: ragChunks.chapterNumber,
          chapterTitle: ragChunks.chapterTitle,
          topic: ragChunks.topic,
          concept: ragChunks.concept,
          language: ragChunks.language,
          qualityScore: ragChunks.qualityScore,
        })
        .from(ragChunks)
        .where(and(inArray(ragChunks.id, [...ids]), eq(ragChunks.isActive, true)));

      return rows.map(toChunkRecord);
    },
  };
}
