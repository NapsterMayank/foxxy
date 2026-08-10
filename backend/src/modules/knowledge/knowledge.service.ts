import type { Logger } from '@/platform/logger/index';
import {
  type ConceptGraphNode,
  type NeighbourLookup,
  findLearningPath as findPath,
  projectToChapterGraph,
  resolveDependents,
  resolvePrerequisites,
} from './domain/chapter-graph';
import { type GraphCoverage, computeGraphCoverage } from './domain/graph-coverage';
import type { KnowledgeRepository } from './knowledge.repository';
import type {
  ChapterConcept,
  ChapterDescriptor,
  ChapterNodeId,
  ConceptCode,
  HydratedLearningPath,
} from './knowledge.types';

/**
 * `knowledge` — the use cases, orchestrating reads onto the pure graph functions.
 *
 * ===========================================================================
 * NO DECISION IS MADE HERE. Every graph rule — projection, self-loops, cycle
 * detection, ordering, coverage arithmetic — lives in `domain/` where it is
 * tested without a database. This file loads rows, calls a pure function, and
 * hydrates the answer. A conditional in this file that changes a graph outcome
 * is the regression.
 *
 * ===========================================================================
 * RESULTS ARE RE-ORDERED AFTER HYDRATION (D-060).
 *
 * `getChaptersByIds` uses `IN (...)` and returns rows in whatever order the
 * planner chose. A learning path whose whole value is its ORDER cannot trust
 * that: trusting it scrambles the sequence while returning perfectly valid
 * chapters, so nothing errors, the screen still renders, and the prerequisite is
 * quietly no longer first. The path is rebuilt from the domain's ordering, and a
 * chapter that failed to hydrate is dropped with a warning rather than left as a
 * hole in the sequence.
 */

export interface KnowledgeService {
  /**
   * The authored concepts of one chapter.
   *
   * These come from `chapter_concepts` and CANNOT be passed to the prerequisite
   * functions below — different vocabulary, no shared key. The two halves of
   * this module meet at `chapter_id` and nowhere else.
   */
  getConceptsForChapter(chapterId: ChapterNodeId): Promise<ChapterConcept[]>;
  /** Direct prerequisites of a graph concept. Unknown codes return `found: false`. */
  getPrerequisites(conceptCode: ConceptCode): Promise<NeighbourLookup>;
  /** Direct dependents of a graph concept. */
  getDependents(conceptCode: ConceptCode): Promise<NeighbourLookup>;
  /**
   * Every chapter this one transitively requires, prerequisites first.
   *
   * Corpus-wide, so a grade 8 path may legitimately include grade 7 chapters —
   * 19 such edges exist and stopping at the grade boundary would silently
   * truncate the answer.
   */
  findLearningPath(chapterId: ChapterNodeId): Promise<HydratedLearningPath>;
  /** How much of one (grade, subject) the graph actually reaches. */
  getGraphCoverage(grade: string, subjectCode: string): Promise<GraphCoverage>;
}

export interface KnowledgeServiceDeps {
  readonly repository: KnowledgeRepository;
  readonly logger: Logger;
}

export function createKnowledgeService(deps: KnowledgeServiceDeps): KnowledgeService {
  const { repository, logger } = deps;

  /**
   * Hydrates chapter ids into descriptors, PRESERVING the given order.
   *
   * Missing ids are dropped and logged. A chapter row deleted between the graph
   * read and the hydration read is possible, and a path silently containing
   * `undefined` is worse than a path one chapter short with a log line saying so.
   */
  const hydrate = async (
    chapterIds: readonly ChapterNodeId[],
  ): Promise<ChapterDescriptor[]> => {
    const rows = await repository.getChaptersByIds(chapterIds);
    const byId = new Map(rows.map((row) => [row.chapterId, row]));
    const ordered: ChapterDescriptor[] = [];
    for (const id of chapterIds) {
      const row = byId.get(id);
      if (row === undefined) {
        logger.warn(
          { chapterId: id },
          'knowledge: chapter in the graph has no chapters row; dropped from the path',
        );
        continue;
      }
      ordered.push(row);
    }
    return ordered;
  };

  const loadNodes = (): Promise<ConceptGraphNode[]> => repository.listAllConceptGraphNodes();

  return {
    getConceptsForChapter(chapterId: ChapterNodeId): Promise<ChapterConcept[]> {
      return repository.listConceptsForChapter(chapterId);
    },

    async getPrerequisites(conceptCode: ConceptCode): Promise<NeighbourLookup> {
      return resolvePrerequisites(await loadNodes(), conceptCode);
    },

    async getDependents(conceptCode: ConceptCode): Promise<NeighbourLookup> {
      return resolveDependents(await loadNodes(), conceptCode);
    },

    async findLearningPath(chapterId: ChapterNodeId): Promise<HydratedLearningPath> {
      const result = findPath(projectToChapterGraph(await loadNodes()), chapterId);

      if (result.ok) {
        return { ok: true, path: await hydrate(result.path) };
      }
      if (result.reason === 'unknown_chapter') {
        return { ok: false, reason: 'unknown_chapter', chapterId: result.chapterId };
      }

      // A cycle is authored data disagreeing with itself, not a fault — see the
      // header of `domain/chapter-graph.ts`. It is logged at warn because
      // somebody has to fix the corpus, and returned in full because the caller
      // is the one who can say which chapter the student was asking about.
      logger.warn(
        { chapterId, cycleLength: result.cycle.length },
        'knowledge: chapter prerequisite projection contains a cycle; no path can be produced',
      );
      return { ok: false, reason: 'cycle', cycle: await hydrate(result.cycle) };
    },

    async getGraphCoverage(grade: string, subjectCode: string): Promise<GraphCoverage> {
      const [chaptersInScope, nodes] = await Promise.all([
        repository.listChaptersInScope(grade, subjectCode),
        loadNodes(),
      ]);

      return computeGraphCoverage({
        grade,
        subjectCode,
        chaptersInScope: chaptersInScope.map((chapter) => ({
          chapterId: chapter.chapterId,
          chapterNumber: chapter.chapterNumber,
        })),
        nodes,
      });
    },
  };
}
