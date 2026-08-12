import type { Logger } from '@/platform/logger/index';
import {
  createKnowledgeRepository,
  type KnowledgeDbHandle,
} from './knowledge.repository';
import { createKnowledgeService, type KnowledgeService } from './knowledge.service';

/**
 * ============================================================================
 * knowledge — THE PUBLIC SURFACE.
 *
 * This is the only file another module may import (00-ARCHITECTURE.md,
 * Foundation 1, enforced by ESLint `no-restricted-imports`). Everything else in
 * this directory is private.
 *
 * Owns: the prerequisite concept graph. 176 edges were imported with the corpus
 * and, until this module, NOTHING READ THEM. That is the gap it closes.
 *
 * NO HTTP ENDPOINTS, for the same reason `retrieval` has none (D-122): the graph
 * is curriculum structure consumed in-process by whatever decides what a student
 * does next. An endpoint returning it would be an unauthenticated way to page
 * the syllabus, and a caller choosing the filters could choose a grade the
 * student is not in.
 * ============================================================================
 *
 * THE THREE THINGS ABOUT THIS MODULE MOST LIKELY TO BE UNDONE BY ACCIDENT.
 *
 * 1. `concept_graph.concept_code` DOES NOT JOIN TO `chapter_concepts`, and no
 *    key is invented to make it look like it does. They are two independently
 *    generated vocabularies with no shared column — the schema says so and the
 *    measurement agrees. Prerequisite reasoning therefore lands at CHAPTER
 *    granularity, which is stated in the return types rather than apologised for
 *    in a comment. A future PR that "fixes" this with a fuzzy title match or a
 *    string-munged code is the regression.
 *
 * 2. CHAPTER PROJECTION CREATES CYCLES THAT THE CONCEPT GRAPH DOES NOT HAVE.
 *    Measured: 0 cycles over 176 concept edges, 3 cycles once projected, all in
 *    grade 7 mathematics, all caused by a coarse and a fine authoring scheme
 *    overlaid on the same chapters. A cycle is therefore NOT corruption and must
 *    not be "repaired" by dropping an edge — both edges are true. It is returned
 *    as a diagnosable closed path so a human can decide which scheme wins.
 *
 * 3. COVERAGE IS MEASURED AGAINST EVERY CHAPTER IN SCOPE, never against the
 *    chapters the graph already knows about. The second denominator always
 *    reports 100% and is the reason a thin graph can look finished. 128 of 137
 *    chapters carry a row today; the nine that do not are named, not just
 *    counted.
 */

export interface KnowledgeModuleDeps {
  /** §3.1: the `core` pool. These are small curriculum reads, not vector scans. */
  readonly db: KnowledgeDbHandle;
  readonly logger: Logger;
}

export interface KnowledgeModule {
  /** The only object other modules should hold. */
  readonly service: KnowledgeService;
}

export function createKnowledgeModule(deps: KnowledgeModuleDeps): KnowledgeModule {
  return {
    service: createKnowledgeService({
      repository: createKnowledgeRepository(deps.db),
      logger: deps.logger,
    }),
  };
}

/**
 * ---------------------------------------------------------------------------
 * The five use cases.
 *
 *   getConceptsForChapter   The authored concepts of a chapter. NOT joinable to
 *                           the graph — different vocabulary, by design.
 *   getPrerequisites        Direct prerequisites of a graph concept.
 *   getDependents           The reverse edge.
 *   findLearningPath        Transitive prerequisites as an ordered CHAPTER list,
 *                           or the cycle that makes one impossible.
 *   getGraphCoverage        How much of a grade and subject the graph reaches,
 *                           including whether it can be ordered at all.
 * ---------------------------------------------------------------------------
 */
export type { KnowledgeService } from './knowledge.service';
export type { KnowledgeRepository } from './knowledge.repository';

export type {
  ChapterConcept,
  ChapterDescriptor,
  ChapterNodeId,
  ConceptCode,
  HydratedLearningPath,
} from './knowledge.types';

/**
 * The graph primitives.
 *
 * Exported because `signals` and any future planner must reason about a path
 * with the SAME projection the service uses. A caller with its own copy of the
 * self-loop rule or the cycle check would be reporting a different graph.
 */
export {
  findLearningPath,
  indexByConceptCode,
  projectToChapterGraph,
  resolveDependents,
  resolvePrerequisites,
  topologicalOrder,
} from './domain/chapter-graph';
export type {
  ChapterProjection,
  ConceptGraphNode,
  LearningPathResult,
  NeighbourLookup,
  ResolvedNeighbour,
} from './domain/chapter-graph';

export { canPlanFor, computeGraphCoverage, coverageRatio } from './domain/graph-coverage';
export type { ChapterInScope, GraphCoverage } from './domain/graph-coverage';
