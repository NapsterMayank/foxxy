import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbHandle } from '@/platform/db/index';
import { chapters } from '@/platform/db/schema/content';
import { chapterConcepts, conceptGraph } from '@/platform/db/schema/pedagogy';
import type { ConceptGraphNode } from './domain/chapter-graph';
import type { ChapterConcept, ChapterDescriptor, ChapterNodeId } from './knowledge.types';

/**
 * ALL database access for `knowledge` — §7, rule 4.
 *
 * ===========================================================================
 * THE WHOLE GRAPH IS LOADED IN ONE QUERY, AND THAT IS A DECISION.
 *
 * `concept_graph` holds 176 rows. Not 176 per grade — 176 in total, across the
 * entire imported corpus. A recursive CTE walking prerequisites in SQL would be
 * the right shape for a graph with a million edges and is the wrong shape for
 * this one: it would put the traversal, the cycle detection and the self-loop
 * rule inside Postgres, where none of them can be unit-tested, in exchange for
 * avoiding a 176-row read.
 *
 * So the repository does one thing — it returns rows — and every graph decision
 * lives in `domain/`, pure and tested. If the graph ever grows by two orders of
 * magnitude this is the file to revisit, and the domain functions do not change.
 *
 * `is_active` is respected on every read. An edge deactivated by a later import
 * must stop constraining an order, and a deactivated chapter must stop appearing
 * in a path.
 *
 * CROSS-GRADE EDGES ARE NOT FILTERED OUT. `listAllConceptGraphNodes` deliberately
 * takes no grade: 19 grade-8 mathematics prerequisites point back into grade 7,
 * and a path for a grade 8 chapter that stopped at the grade boundary would be
 * silently incomplete in exactly the place the graph is most useful.
 */

export type KnowledgeDbHandle = DbHandle;

export interface KnowledgeRepository {
  /** Every active graph row, corpus-wide. See the header for why it is not scoped. */
  listAllConceptGraphNodes(): Promise<ConceptGraphNode[]>;
  /** Active chapters for one (grade, subject), in chapter order. */
  listChaptersInScope(grade: string, subjectCode: string): Promise<ChapterDescriptor[]>;
  /** Hydration for a path. Order is arbitrary — the caller re-orders (D-060). */
  getChaptersByIds(chapterIds: readonly ChapterNodeId[]): Promise<ChapterDescriptor[]>;
  /** `chapter_concepts` for one chapter, in ordinal order. */
  listConceptsForChapter(chapterId: ChapterNodeId): Promise<ChapterConcept[]>;
}

export function createKnowledgeRepository(handle: KnowledgeDbHandle): KnowledgeRepository {
  const { db } = handle;

  return {
    async listAllConceptGraphNodes(): Promise<ConceptGraphNode[]> {
      const rows = await db
        .select({
          conceptCode: conceptGraph.conceptCode,
          conceptName: conceptGraph.conceptName,
          chapterId: conceptGraph.chapterId,
          prerequisiteCodes: conceptGraph.prerequisiteCodes,
        })
        .from(conceptGraph)
        .where(eq(conceptGraph.isActive, true))
        // Sorted in SQL so that the domain receives a stable input. Determinism
        // that depends on the planner's row order is not determinism.
        .orderBy(asc(conceptGraph.conceptCode));

      return rows.map((row) => ({
        conceptCode: row.conceptCode,
        conceptName: row.conceptName,
        chapterId: row.chapterId,
        prerequisiteCodes: row.prerequisiteCodes,
      }));
    },

    async listChaptersInScope(grade: string, subjectCode: string): Promise<ChapterDescriptor[]> {
      const rows = await db
        .select({
          chapterId: chapters.id,
          grade: chapters.grade,
          subjectCode: chapters.subjectCode,
          chapterNumber: chapters.chapterNumber,
          titleEn: chapters.titleEn,
          titleHi: chapters.titleHi,
        })
        .from(chapters)
        .where(
          and(
            eq(chapters.grade, grade),
            eq(chapters.subjectCode, subjectCode),
            eq(chapters.isActive, true),
          ),
        )
        .orderBy(asc(chapters.chapterNumber));

      return rows;
    },

    async getChaptersByIds(
      chapterIds: readonly ChapterNodeId[],
    ): Promise<ChapterDescriptor[]> {
      if (chapterIds.length === 0) {
        // `inArray` with an empty list generates `in ()`, which is a syntax
        // error in Postgres. An empty path is an ordinary outcome, not an error.
        return [];
      }
      const rows = await db
        .select({
          chapterId: chapters.id,
          grade: chapters.grade,
          subjectCode: chapters.subjectCode,
          chapterNumber: chapters.chapterNumber,
          titleEn: chapters.titleEn,
          titleHi: chapters.titleHi,
        })
        .from(chapters)
        .where(inArray(chapters.id, [...chapterIds]));

      return rows;
    },

    async listConceptsForChapter(chapterId: ChapterNodeId): Promise<ChapterConcept[]> {
      const rows = await db
        .select({
          id: chapterConcepts.id,
          chapterId: chapterConcepts.chapterId,
          conceptNumber: chapterConcepts.conceptNumber,
          titleEn: chapterConcepts.titleEn,
          titleHi: chapterConcepts.titleHi,
          learningObjective: chapterConcepts.learningObjective,
        })
        .from(chapterConcepts)
        .where(
          and(eq(chapterConcepts.chapterId, chapterId), eq(chapterConcepts.isActive, true)),
        )
        .orderBy(asc(chapterConcepts.conceptNumber), asc(chapterConcepts.titleEn));

      return rows;
    },
  };
}
