import { describe, expect, it } from 'vitest';
import type { ConceptGraphNode } from '../domain/chapter-graph';
import {
  type ChapterInScope,
  canPlanFor,
  computeGraphCoverage,
  coverageRatio,
} from '../domain/graph-coverage';

/**
 * THE MEASURED SHAPE OF THE REAL IMPORTED GRAPH, re-measured 10 August 2026.
 *
 * These are not targets and not fixtures — they are what a read of the corpus
 * returned, recorded here so that a later import that changes them fails a test
 * instead of quietly changing what the product claims. The whole imported corpus
 * is grades 6-10, mathematics and science: 137 chapters, 176 edges.
 *
 * ===========================================================================
 * `orderable` AND `withinScope` ARE BOTH RECORDED, AND THE ROWS WHERE THEY
 * DISAGREE ARE THE FINDING.
 *
 * `withinScope` is the old reading: the in-scope nodes projected alone. It says
 * grade 7 mathematics contradicts itself — 15 of 15 chapters covered and still
 * unorderable, because two authoring schemes overlaid on the same chapters
 * disagree once projected (see `chapter-graph.ts`).
 *
 * `orderable` and `plannable` are the reading that matches the feature:
 * `findLearningPath` over the WHOLE corpus. Grade 8 mathematics is the row that
 * only this reading can see — internally acyclic, `withinScope: true`, and 0 of
 * its 14 covered chapters produce a path, because all 19 of its cross-grade
 * prerequisites land in grade 7's cycle.
 *
 * Before this was measured the report for grade 8 mathematics read 14/14, ratio
 * 1.0, orderable true, cycle [] — the healthiest-looking row in the corpus, for
 * the grade where the feature was entirely dead.
 * ===========================================================================
 */
export const MEASURED_COVERAGE = [
  // grade, subject, chapters, chapters with a graph row, in-scope chapter
  // edges, plannable over the CORPUS, corpus-orderable, scoped-orderable.
  { grade: '6', subject: 'mathematics', chapters: 12, withGraph: 10, edges: 10, plannable: 10, orderable: true, withinScope: true },
  { grade: '7', subject: 'mathematics', chapters: 15, withGraph: 15, edges: 36, plannable: 2, orderable: false, withinScope: false },
  { grade: '8', subject: 'mathematics', chapters: 14, withGraph: 14, edges: 33, plannable: 0, orderable: false, withinScope: true },
  { grade: '9', subject: 'mathematics', chapters: 13, withGraph: 13, edges: 13, plannable: 13, orderable: true, withinScope: true },
  { grade: '10', subject: 'mathematics', chapters: 15, withGraph: 14, edges: 14, plannable: 14, orderable: true, withinScope: true },
  { grade: '6', subject: 'science', chapters: 12, withGraph: 12, edges: 12, plannable: 12, orderable: true, withinScope: true },
  { grade: '7', subject: 'science', chapters: 13, withGraph: 12, edges: 12, plannable: 12, orderable: true, withinScope: true },
  { grade: '8', subject: 'science', chapters: 13, withGraph: 13, edges: 21, plannable: 13, orderable: true, withinScope: true },
  { grade: '9', subject: 'science', chapters: 14, withGraph: 12, edges: 12, plannable: 12, orderable: true, withinScope: true },
  { grade: '10', subject: 'science', chapters: 16, withGraph: 13, edges: 13, plannable: 13, orderable: true, withinScope: true },
] as const;

const CH1 = 'ch-1';
const CH2 = 'ch-2';
const CH3 = 'ch-3';

function node(
  conceptCode: string,
  chapterId: string,
  prerequisiteCodes: readonly string[] = [],
): ConceptGraphNode {
  return { conceptCode, conceptName: null, chapterId, prerequisiteCodes };
}

function scope(...ids: readonly string[]): ChapterInScope[] {
  return ids.map((chapterId, i) => ({ chapterId, chapterNumber: i + 1 }));
}

describe('computeGraphCoverage', () => {
  it('measures against EVERY chapter in scope, not only the covered ones', () => {
    const coverage = computeGraphCoverage({
      grade: '6',
      subjectCode: 'mathematics',
      chaptersInScope: scope(CH1, CH2, CH3),
      nodes: [node('a', CH1), node('b', CH2, ['a'])],
    });
    expect(coverage.chaptersTotal).toBe(3);
    expect(coverage.chaptersWithGraph).toBe(2);
    expect(coverage.chaptersWithoutGraph).toEqual([CH3]);
  });

  it('names the uncovered chapters, so a caller can tell if THIS one is blind', () => {
    const coverage = computeGraphCoverage({
      grade: '9',
      subjectCode: 'science',
      chaptersInScope: scope(CH1, CH2, CH3),
      nodes: [node('a', CH2)],
    });
    expect(coverage.chaptersWithoutGraph).toEqual([CH1, CH3]);
  });

  it('ignores nodes outside the scope rather than letting them inflate the count', () => {
    const coverage = computeGraphCoverage({
      grade: '8',
      subjectCode: 'mathematics',
      chaptersInScope: scope(CH1),
      // A real case: grade 8 maths declares 19 prerequisites into grade 7.
      nodes: [node('g8', CH1, ['g7']), node('g7', 'grade-7-chapter')],
    });
    expect(coverage.conceptNodes).toBe(1);
    expect(coverage.chaptersWithGraph).toBe(1);
    // The out-of-scope prerequisite constrains nothing here — there is no
    // in-scope chapter on the far side of it.
    expect(coverage.chapterEdges).toBe(0);
  });

  it('counts nodes with prerequisites separately — a node with none orders nothing', () => {
    const coverage = computeGraphCoverage({
      grade: '6',
      subjectCode: 'science',
      chaptersInScope: scope(CH1, CH2),
      nodes: [node('a', CH1), node('b', CH2, ['a']), node('c', CH2)],
    });
    expect(coverage.conceptNodes).toBe(3);
    expect(coverage.nodesWithPrerequisites).toBe(1);
    expect(coverage.chapterEdges).toBe(1);
  });

  it('reports dropped self-loops as part of coverage', () => {
    const coverage = computeGraphCoverage({
      grade: '6',
      subjectCode: 'science',
      chaptersInScope: scope(CH1),
      nodes: [node('a', CH1), node('b', CH1, ['a'])],
    });
    expect(coverage.selfLoopsDropped).toBe(1);
    expect(coverage.chapterEdges).toBe(0);
    expect(coverage.chaptersWithGraph).toBe(1);
  });

  it('reports FULL coverage that is nevertheless NOT orderable — the grade 7 case', () => {
    const coverage = computeGraphCoverage({
      grade: '7',
      subjectCode: 'mathematics',
      chaptersInScope: scope(CH1, CH2),
      nodes: [
        node('m7.decimals.concept', CH2, ['m7.fractions.concept']),
        node('m7.fractions.concept', CH1),
        node('math_7_ch1', CH1, ['math_7_ch2']),
        node('math_7_ch2', CH2),
      ],
    });
    expect(coverage.chaptersWithGraph).toBe(coverage.chaptersTotal);
    expect(coverageRatio(coverage)).toBe(1);
    expect(coverage.orderable).toBe(false);
    expect(coverage.cycle.length).toBeGreaterThan(1);
  });

  it('leaves the cycle empty when the projection is orderable', () => {
    const coverage = computeGraphCoverage({
      grade: '6',
      subjectCode: 'mathematics',
      chaptersInScope: scope(CH1, CH2),
      nodes: [node('a', CH1), node('b', CH2, ['a'])],
    });
    expect(coverage.orderable).toBe(true);
    expect(coverage.cycle).toEqual([]);
  });

  it('handles a grade with no graph rows at all without dividing by zero', () => {
    const coverage = computeGraphCoverage({
      grade: '11',
      subjectCode: 'mathematics',
      chaptersInScope: scope(CH1, CH2),
      nodes: [],
    });
    expect(coverage.chaptersWithGraph).toBe(0);
    expect(coverageRatio(coverage)).toBe(0);
    expect(coverage.orderable).toBe(true);
  });

  it('returns zero rather than NaN when nothing is in scope', () => {
    const coverage = computeGraphCoverage({
      grade: '12',
      subjectCode: 'science',
      chaptersInScope: [],
      nodes: [],
    });
    expect(coverage.chaptersTotal).toBe(0);
    expect(coverageRatio(coverage)).toBe(0);
  });

  it('counts plannable chapters, and they equal the covered ones on a clean graph', () => {
    const coverage = computeGraphCoverage({
      grade: '9',
      subjectCode: 'science',
      chaptersInScope: scope(CH1, CH2, CH3),
      nodes: [node('a', CH1), node('b', CH2, ['a'])],
    });
    expect(coverage.plannableChapters).toBe(2);
    expect(coverage.chaptersWithGraph).toBe(2);
    expect(coverage.orderable).toBe(true);
  });

  it('counts NO plannable chapters when the in-scope graph contradicts itself', () => {
    const coverage = computeGraphCoverage({
      grade: '7',
      subjectCode: 'mathematics',
      chaptersInScope: scope(CH1, CH2, CH3),
      nodes: [
        node('m7.decimals.concept', CH2, ['m7.fractions.concept']),
        node('m7.fractions.concept', CH1),
        node('math_7_ch1', CH1, ['math_7_ch2']),
        node('math_7_ch2', CH2),
        // CH3 is clean and must still be counted — refusing a whole grade
        // because two of its chapters disagree would hide a working feature.
        node('clean', CH3),
      ],
    });
    expect(coverage.chaptersWithGraph).toBe(3);
    expect(coverage.plannableChapters).toBe(1);
    expect(coverage.orderable).toBe(false);
    expect(coverage.orderableWithinScope).toBe(false);
  });
});

describe('computeGraphCoverage — orderable describes the graph the FEATURE walks', () => {
  /**
   * THE GRADE 8 MATHEMATICS SIGNATURE, reproduced in miniature.
   *
   * Measured on the real corpus: 14 of 14 chapters covered, ratio 1.0,
   * `orderable: true`, `cycle: []` — and every one of those 14 chapters fails
   * `findLearningPath` with `reason: 'cycle'`. The grade is acyclic in
   * isolation; all 19 of its prerequisite edges point back into grade 7, whose
   * projection is not.
   *
   * The scoped projection was not wrong about its own graph. It was answering a
   * question about a graph nobody ever walks, and the answer read as health.
   */
  const G7_A = 'g7-chapter-a';
  const G7_B = 'g7-chapter-b';

  /** One in-scope chapter, depending on a grade-7 pair that contradicts itself. */
  const CROSS_GRADE: readonly ConceptGraphNode[] = [
    node('g8.concept', CH1, ['g7.fine.b']),
    // The grade 7 cycle: fine says A needs B, coarse says B needs A.
    node('g7.fine.b', G7_A, ['g7.fine.a']),
    node('g7.fine.a', G7_B),
    node('g7.coarse.a', G7_B, ['g7.coarse.b']),
    node('g7.coarse.b', G7_A),
  ];

  it('reports NOT orderable and 0 plannable for a grade whose prerequisites cycle out of scope', () => {
    const coverage = computeGraphCoverage({
      grade: '8',
      subjectCode: 'mathematics',
      chaptersInScope: scope(CH1),
      nodes: CROSS_GRADE,
    });

    expect(coverage.chaptersWithGraph).toBe(1);
    expect(coverageRatio(coverage)).toBe(1);
    // THE FIX. Both of these read the other way before it.
    expect(coverage.plannableChapters).toBe(0);
    expect(coverage.orderable).toBe(false);
    // And the cycle is NAMED, so somebody can go and fix the corpus.
    expect(coverage.cycle.length).toBeGreaterThan(1);
    expect(coverage.cycle[0]).toBe(coverage.cycle[coverage.cycle.length - 1]);
  });

  it('keeps the SCOPED reading as a diagnostic, and it disagrees — that is the finding', () => {
    // In isolation grade 8 is perfectly orderable. Reporting only this is what
    // made the healthiest-looking row in the corpus the one where nothing
    // worked.
    const coverage = computeGraphCoverage({
      grade: '8',
      subjectCode: 'mathematics',
      chaptersInScope: scope(CH1),
      nodes: CROSS_GRADE,
    });
    expect(coverage.orderableWithinScope).toBe(true);
    expect(coverage.orderable).toBe(false);
  });

  it('AGREES with canPlanFor, chapter by chapter — one graph, one answer', () => {
    /**
     * The two are the same question asked twice and they must never diverge:
     * `canPlanFor` is what a caller uses to decide whether to show a path, and
     * `plannableChapters` is what a report uses to say how many it could show.
     * The defect was exactly a divergence of this kind.
     */
    const nodes = [...CROSS_GRADE, node('clean', CH2)];
    const coverage = computeGraphCoverage({
      grade: '8',
      subjectCode: 'mathematics',
      chaptersInScope: scope(CH1, CH2),
      nodes,
    });
    const byCanPlanFor = [CH1, CH2].filter((chapterId) => canPlanFor(nodes, chapterId)).length;
    expect(coverage.plannableChapters).toBe(byCanPlanFor);
    expect(coverage.plannableChapters).toBe(1);
  });

  it('claims nothing about a grade the graph has never heard of', () => {
    // Vacuously orderable with zero plannable chapters. `chaptersWithGraph: 0`
    // is the number that says so; `orderable` is not asked to carry it.
    const coverage = computeGraphCoverage({
      grade: '11',
      subjectCode: 'mathematics',
      chaptersInScope: scope(CH1, CH2),
      nodes: [],
    });
    expect(coverage.plannableChapters).toBe(0);
    expect(coverage.chaptersWithGraph).toBe(0);
    expect(coverage.orderable).toBe(true);
    expect(coverage.cycle).toEqual([]);
  });
});

describe('computeGraphCoverage — the rest', () => {
  it('is deterministic across repeated evaluation', () => {
    const input = {
      grade: '6',
      subjectCode: 'mathematics',
      chaptersInScope: scope(CH1, CH2, CH3),
      nodes: [node('a', CH1), node('b', CH2, ['a'])],
    };
    expect(computeGraphCoverage(input)).toEqual(computeGraphCoverage(input));
  });
});

describe('coverageRatio', () => {
  it('rounds to three places rather than storing a fourth copy of the fact', () => {
    const coverage = computeGraphCoverage({
      grade: '10',
      subjectCode: 'science',
      chaptersInScope: scope(CH1, CH2, CH3),
      nodes: [node('a', CH1)],
    });
    expect(coverageRatio(coverage)).toBe(0.333);
  });
});

describe('canPlanFor', () => {
  it('allows a chapter that is not on the cycle even when the grade is unorderable', () => {
    const nodes = [
      // The contradicting pair, chapters 1 and 2.
      node('fine.b', CH2, ['fine.a']),
      node('fine.a', CH1),
      node('coarse.a', CH1, ['coarse.b']),
      node('coarse.b', CH2),
      // Chapter 3 is clean and depends on nothing.
      node('clean', CH3),
    ];
    expect(canPlanFor(nodes, CH3)).toBe(true);
    expect(canPlanFor(nodes, CH1)).toBe(false);
  });

  it('is false for a chapter the graph has never heard of', () => {
    expect(canPlanFor([node('a', CH1)], 'unknown')).toBe(false);
  });
});

describe('the measured corpus shape', () => {
  it('records grades 6-10 mathematics and science, 137 chapters, 176 edges', () => {
    const chapters = MEASURED_COVERAGE.reduce((sum, row) => sum + row.chapters, 0);
    const edges = MEASURED_COVERAGE.reduce((sum, row) => sum + row.edges, 0);
    expect(chapters).toBe(137);
    expect(edges).toBe(176);
  });

  it('records that 128 of 137 chapters carry a graph row — the gap is 9', () => {
    const withGraph = MEASURED_COVERAGE.reduce((sum, row) => sum + row.withGraph, 0);
    expect(withGraph).toBe(128);
    expect(137 - withGraph).toBe(9);
  });

  it('records grade 7 mathematics as fully covered and NOT orderable', () => {
    const row = MEASURED_COVERAGE.find((r) => r.grade === '7' && r.subject === 'mathematics');
    expect(row?.withGraph).toBe(row?.chapters);
    expect(row?.orderable).toBe(false);
  });

  it('records grade 8 mathematics as fully covered, internally fine, and 0 plannable', () => {
    /**
     * THE ROW THE OLD REPORT COULD NOT SEE. 14 of 14 covered, acyclic in
     * isolation, and not one chapter produces a learning path. The old
     * `orderable` read `true` here and the report was the best-looking in the
     * corpus.
     */
    const row = MEASURED_COVERAGE.find((r) => r.grade === '8' && r.subject === 'mathematics');
    expect(row?.withGraph).toBe(row?.chapters);
    expect(row?.withinScope).toBe(true);
    expect(row?.orderable).toBe(false);
    expect(row?.plannable).toBe(0);
  });

  it('records that only 101 of the 128 covered chapters are actually plannable', () => {
    // The gap the report used to hide: 27 chapters carry a graph row and cannot
    // be given a path, all of them in grades 7 and 8 mathematics.
    const withGraph = MEASURED_COVERAGE.reduce((sum, row) => sum + row.withGraph, 0);
    const plannable = MEASURED_COVERAGE.reduce((sum, row) => sum + row.plannable, 0);
    expect(withGraph).toBe(128);
    expect(plannable).toBe(101);
    expect(withGraph - plannable).toBe(27);
  });

  it('records that every row where the two readings disagree is a cross-grade one', () => {
    const disagreeing = MEASURED_COVERAGE.filter((row) => row.withinScope !== row.orderable);
    expect(disagreeing.map((row) => `${row.grade}/${row.subject}`)).toEqual(['8/mathematics']);
  });
});
