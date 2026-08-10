/**
 * GRAPH COVERAGE — how much of a grade and subject the prerequisite graph
 * actually covers, computed so the gap stays visible.
 *
 * ===========================================================================
 * WHY THIS EXISTS AT ALL.
 *
 * 176 edges were imported and, until this module, nothing read them. The risk
 * with a graph that thin is not that it is wrong — it is that a feature built on
 * it looks like it works. A "recommended path" screen over a chapter with no
 * graph row renders an empty list, which is indistinguishable from "you are
 * ready for everything". Coverage is what tells those two apart, and it is
 * reported as counts rather than a grade so nobody can round it into a claim.
 *
 * THE HONEST DENOMINATOR IS EVERY CHAPTER IN SCOPE, not every chapter that has a
 * graph row. Measuring the graph against itself always reports 100%.
 *
 * ===========================================================================
 * `orderable` IS PART OF COVERAGE, NOT A SEPARATE HEALTH CHECK.
 *
 * A grade whose chapters are all covered but whose projection contains a cycle
 * cannot produce a learning path, so its effective coverage for the one feature
 * this graph exists to serve is zero. Grade 7 mathematics is exactly that case:
 * 15 of 15 chapters carry graph rows, and its chapter projection has three
 * cycles (see `chapter-graph.ts`). Reporting `chaptersWithGraph: 15` and stopping
 * would be true and misleading in the same sentence.
 *
 * Pure: every input arrives as an argument.
 */

import {
  type ChapterNodeId,
  type ConceptGraphNode,
  findLearningPath,
  projectToChapterGraph,
  topologicalOrder,
} from './chapter-graph';

/** A chapter in scope, whether or not the graph has anything to say about it. */
export interface ChapterInScope {
  readonly chapterId: ChapterNodeId;
  readonly chapterNumber: number;
}

/**
 * Coverage for one (grade, subject).
 *
 * Counts, plus the two facts a caller cannot recompute without re-walking the
 * graph: whether an order exists, and which chapters are invisible to it.
 */
export interface GraphCoverage {
  readonly grade: string;
  readonly subjectCode: string;
  /** Every chapter in scope — the denominator. */
  readonly chaptersTotal: number;
  /** Chapters carrying at least one `concept_graph` row. */
  readonly chaptersWithGraph: number;
  /** `concept_graph` rows in scope. */
  readonly conceptNodes: number;
  /** Rows declaring at least one prerequisite. A node with none orders nothing. */
  readonly nodesWithPrerequisites: number;
  /** Distinct chapter-to-chapter edges after projection. */
  readonly chapterEdges: number;
  /** Same-chapter edges the projection removed. */
  readonly selfLoopsDropped: number;
  /**
   * Chapters in scope with no graph row. Named, not just counted — a caller
   * deciding whether to show a path needs to know if THIS chapter is one of them.
   */
  readonly chaptersWithoutGraph: readonly ChapterNodeId[];
  /**
   * False when the chapter projection contains a cycle. See the header: this is
   * a coverage fact, not a separate diagnostic.
   */
  readonly orderable: boolean;
  /** The cycle that made `orderable` false, closed. Empty when orderable. */
  readonly cycle: readonly ChapterNodeId[];
}

/**
 * The share of in-scope chapters the graph reaches, 0-1, rounded to three places.
 *
 * A SEPARATE FUNCTION rather than a field, deliberately. A ratio stored beside
 * its numerator and denominator is a third copy of the same fact that can
 * disagree with them, and the disagreement always survives longer than the bug
 * that caused it. Callers that want a percentage compute one.
 */
export function coverageRatio(coverage: GraphCoverage): number {
  if (coverage.chaptersTotal === 0) {
    return 0;
  }
  return Math.round((coverage.chaptersWithGraph / coverage.chaptersTotal) * 1000) / 1000;
}

/**
 * Computes coverage from the chapters in scope and the graph rows in scope.
 *
 * Nodes whose `chapterId` is not in `chaptersInScope` are IGNORED rather than
 * counted, because a caller asking about grade 8 should not have its numbers
 * moved by a grade 7 row that the query happened to return. The 19 grade-8-maths
 * edges pointing back into grade 7 are real and are the reason this matters.
 */
export function computeGraphCoverage(input: {
  readonly grade: string;
  readonly subjectCode: string;
  readonly chaptersInScope: readonly ChapterInScope[];
  readonly nodes: readonly ConceptGraphNode[];
}): GraphCoverage {
  const scope = new Set(input.chaptersInScope.map((chapter) => chapter.chapterId));
  const nodesInScope = input.nodes.filter((node) => scope.has(node.chapterId));

  const covered = new Set(nodesInScope.map((node) => node.chapterId));
  const chaptersWithoutGraph = input.chaptersInScope
    .filter((chapter) => !covered.has(chapter.chapterId))
    .map((chapter) => chapter.chapterId)
    .sort();

  // Projected over the nodes in scope only. An edge leaving the scope has no
  // chapter on the far side to order against, so it cannot contribute an
  // ordering constraint here even though it is a true prerequisite.
  const projection = projectToChapterGraph(nodesInScope);
  let chapterEdges = 0;
  for (const targets of projection.prerequisitesOf.values()) {
    chapterEdges += targets.length;
  }

  const order = topologicalOrder(projection);

  return {
    grade: input.grade,
    subjectCode: input.subjectCode,
    chaptersTotal: input.chaptersInScope.length,
    chaptersWithGraph: covered.size,
    conceptNodes: nodesInScope.length,
    nodesWithPrerequisites: nodesInScope.filter((node) => node.prerequisiteCodes.length > 0).length,
    chapterEdges,
    selfLoopsDropped: projection.selfLoopsDropped,
    chaptersWithoutGraph,
    orderable: order.ok,
    // `topologicalOrder` cannot fail on a missing chapter — it only ever walks
    // chapters it found itself — so its result type has exactly two cases and
    // this needs no third branch.
    cycle: order.ok ? [] : order.cycle,
  };
}

/**
 * Whether a learning path can be produced for one specific chapter.
 *
 * Narrower than `orderable`, and the distinction is the point: grade 7
 * mathematics is not orderable as a whole, yet most of its chapters are not on
 * the cycle and can still be given a path. Refusing every chapter in the grade
 * because three of them contradict each other would hide a working feature
 * behind a data defect.
 */
export function canPlanFor(
  nodes: readonly ConceptGraphNode[],
  chapterId: ChapterNodeId,
): boolean {
  return findLearningPath(projectToChapterGraph(nodes), chapterId).ok;
}
