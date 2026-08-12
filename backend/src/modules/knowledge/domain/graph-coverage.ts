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
 * ===========================================================================
 * `orderable` IS MEASURED ON THE GRAPH THE FEATURE ACTUALLY WALKS, AND IT WAS
 * ONCE MEASURED ON A DIFFERENT ONE.
 *
 * `findLearningPath` projects EVERY node in the corpus, because 19 grade-8
 * mathematics prerequisites point back into grade 7 and a path that stopped at
 * the grade boundary would be silently incomplete. This function used to project
 * only the nodes IN SCOPE — a different graph — and report `orderable` from that.
 *
 * Measured, 10 August 2026, grade 8 mathematics:
 *
 *     chaptersTotal 14 · chaptersWithGraph 14 · ratio 1.0
 *     orderable true · cycle []            <- the report
 *     findLearningPath: 14 of 14 chapters -> { ok: false, reason: 'cycle' }
 *
 * In isolation grade 8 is acyclic, so the scoped projection was right about the
 * graph it was given and the graph it was given is one nobody ever walks. The
 * report read healthiest exactly where the feature was dead. That is D-129's own
 * argument recurring inside the instrument built to detect it.
 *
 * So: `orderable` and `plannableChapters` are both computed over the CORPUS
 * projection, one `findLearningPath` per covered chapter — the same call, on
 * the same graph, that the feature makes. `orderableWithinScope` keeps the old
 * scoped reading as a subordinate DIAGNOSTIC, because the disagreement between
 * the two is the finding: it separates "this grade contradicts itself"
 * (grade 7 mathematics) from "this grade is internally fine and its
 * out-of-grade prerequisite is not" (grade 8 mathematics). It is never the
 * answer to "can this grade be planned".
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
   * In-scope chapters for which `findLearningPath` ACTUALLY RETURNS A PATH,
   * over the corpus projection — the same call the feature makes.
   *
   * THE ONLY NUMBER ON THIS OBJECT THAT MEANS "THE FEATURE WORKS HERE".
   * `chaptersWithGraph` counts rows; this counts answers. Grade 8 mathematics
   * measured 14 and 0 respectively.
   *
   * Its denominator is `chaptersWithGraph`, not `chaptersTotal`: a chapter with
   * no graph row was never going to be plannable and is already counted in
   * `chaptersWithoutGraph`. Adding it here would blame the cycle for a gap it
   * did not cause.
   */
  readonly plannableChapters: number;
  /**
   * False when any covered chapter cannot be given a learning path over the
   * CORPUS projection. See the header: this is a coverage fact, not a separate
   * diagnostic, and it is deliberately not the scoped reading.
   */
  readonly orderable: boolean;
  /**
   * The old SCOPED reading — whether the in-scope nodes alone can be ordered.
   *
   * A DIAGNOSTIC AND NOT A VERDICT. `orderableWithinScope: true` with
   * `orderable: false` is the grade 8 mathematics signature: internally
   * consistent, and every path it needs runs through a grade 7 cycle. Never
   * show this to anybody as "can this grade be planned".
   */
  readonly orderableWithinScope: boolean;
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
 * Computes coverage from the chapters in scope and EVERY graph row the caller
 * can see.
 *
 * `nodes` IS THE WHOLE CORPUS, not a pre-filtered slice, and both readings are
 * taken from it here:
 *
 *   - the COUNTS (`conceptNodes`, `chapterEdges`, `selfLoopsDropped`,
 *     `orderableWithinScope`) are scoped, because a caller asking about grade 8
 *     should not have its numbers moved by a grade 7 row the query happened to
 *     return;
 *   - `plannableChapters` and `orderable` are NOT scoped, because the feature
 *     they describe is not. The 19 grade-8-maths edges pointing back into
 *     grade 7 are real, `findLearningPath` follows them, and a report that
 *     pretended otherwise said 14/14 about a grade where nothing was plannable.
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

  const scopedOrder = topologicalOrder(projection);

  // THE GRAPH THE FEATURE WALKS. One `findLearningPath` per covered chapter,
  // over the corpus projection — the identical call `knowledge.service` makes,
  // so a chapter counted here is a chapter that really does produce a path.
  const corpusProjection = projectToChapterGraph(input.nodes);
  let plannableChapters = 0;
  let cycle: readonly ChapterNodeId[] = [];
  for (const chapterId of [...covered].sort()) {
    const result = findLearningPath(corpusProjection, chapterId);
    if (result.ok) {
      plannableChapters += 1;
      continue;
    }
    // The FIRST cycle, in sorted chapter order so the report is deterministic.
    // Reported in full rather than as a boolean: "there is a cycle" is not
    // diagnosable and `a -> b -> c -> a` is.
    if (result.reason === 'cycle' && cycle.length === 0) {
      cycle = result.cycle;
    }
  }

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
    plannableChapters,
    // Every covered chapter answers, or the grade does not order. With no
    // covered chapters this is vacuously true, which is correct: nothing is
    // claimed about a grade the graph has never heard of, and
    // `chaptersWithGraph: 0` is the number that says so.
    orderable: plannableChapters === covered.size,
    orderableWithinScope: scopedOrder.ok,
    cycle,
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
