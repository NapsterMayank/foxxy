import { describe, expect, it } from 'vitest';
import type { ConceptGraphNode } from '../domain/chapter-graph';
import {
  type ChapterInScope,
  canPlanFor,
  computeGraphCoverage,
  coverageRatio,
} from '../domain/graph-coverage';

/**
 * THE MEASURED SHAPE OF THE REAL IMPORTED GRAPH, 10 August 2026.
 *
 * These are not targets and not fixtures — they are what a read of the corpus
 * returned, recorded here so that a later import that changes them fails a test
 * instead of quietly changing what the product claims. The whole imported corpus
 * is grades 6-10, mathematics and science: 137 chapters, 176 edges.
 *
 * The `orderable: false` row is the finding: grade 7 mathematics has FULL chapter
 * coverage and still cannot be ordered, because two authoring schemes overlaid on
 * the same chapters contradict each other once projected (see `chapter-graph.ts`).
 * Coverage that stopped at `chaptersWithGraph` would report that grade as the
 * best-covered in the corpus.
 */
export const MEASURED_COVERAGE = [
  { grade: '6', subject: 'mathematics', chapters: 12, withGraph: 10, edges: 10, orderable: true },
  { grade: '7', subject: 'mathematics', chapters: 15, withGraph: 15, edges: 36, orderable: false },
  { grade: '8', subject: 'mathematics', chapters: 14, withGraph: 14, edges: 33, orderable: true },
  { grade: '9', subject: 'mathematics', chapters: 13, withGraph: 13, edges: 13, orderable: true },
  { grade: '10', subject: 'mathematics', chapters: 15, withGraph: 14, edges: 14, orderable: true },
  { grade: '6', subject: 'science', chapters: 12, withGraph: 12, edges: 12, orderable: true },
  { grade: '7', subject: 'science', chapters: 13, withGraph: 12, edges: 12, orderable: true },
  { grade: '8', subject: 'science', chapters: 13, withGraph: 13, edges: 21, orderable: true },
  { grade: '9', subject: 'science', chapters: 14, withGraph: 12, edges: 12, orderable: true },
  { grade: '10', subject: 'science', chapters: 16, withGraph: 13, edges: 13, orderable: true },
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
});
