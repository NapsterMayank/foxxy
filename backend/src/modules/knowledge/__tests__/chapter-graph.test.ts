import { describe, expect, it } from 'vitest';
import {
  type ConceptGraphNode,
  findLearningPath,
  indexByConceptCode,
  projectToChapterGraph,
  resolveDependents,
  resolvePrerequisites,
  topologicalOrder,
} from '../domain/chapter-graph';

/**
 * THE FIXTURES ARE REDUCTIONS OF THE REAL IMPORTED GRAPH, not invented shapes.
 *
 * Every concept code below appears verbatim in `concept_graph`, and the two
 * naming schemes are the two that genuinely coexist in grade 7 mathematics:
 * `math_7_chN` (one code per chapter) and `m7.topic.detail` (several per
 * chapter). The cycle in `SEVEN_MATHS` is not a hypothetical — it is the
 * measured one, reduced to its shortest closed form.
 */

const CH3 = '00000000-0000-0000-0000-0000000000c3';
const CH4 = '00000000-0000-0000-0000-0000000000c4';
const CH5 = '00000000-0000-0000-0000-0000000000c5';

function node(
  conceptCode: string,
  chapterId: string,
  prerequisiteCodes: readonly string[] = [],
): ConceptGraphNode {
  return { conceptCode, conceptName: conceptCode, chapterId, prerequisiteCodes };
}

/** Acyclic at concept level AND at chapter level. The ordinary case. */
const LINEAR: readonly ConceptGraphNode[] = [
  node('m7.fractions.concept', CH3),
  node('m7.fractions.ops', CH3, ['m7.fractions.concept']),
  node('m7.decimals.concept', CH4, ['m7.fractions.concept']),
  node('m7.decimals.ops', CH5, ['m7.decimals.concept', 'm7.fractions.ops']),
];

/**
 * ACYCLIC AT CONCEPT LEVEL, CYCLIC ONCE PROJECTED ONTO CHAPTERS.
 *
 * This is the defect the module exists to survive. `m7.decimals.concept` needs
 * `m7.fractions.concept`, which puts chapter 4 after chapter 3; the coarse
 * `math_7_ch3` needs `math_7_ch4`, which puts chapter 3 after chapter 4. Both
 * statements are true about concepts. Neither is a cycle. Together, at chapter
 * granularity, they are.
 */
const SEVEN_MATHS: readonly ConceptGraphNode[] = [
  node('m7.fractions.concept', CH3),
  node('m7.decimals.concept', CH4, ['m7.fractions.concept']),
  node('math_7_ch4', CH4),
  node('math_7_ch3', CH3, ['math_7_ch4']),
];

describe('indexByConceptCode', () => {
  it('indexes every node by its code', () => {
    const index = indexByConceptCode(LINEAR);
    expect(index.size).toBe(4);
    expect(index.get('m7.decimals.ops')?.chapterId).toBe(CH5);
  });

  it('keeps the first row when a code repeats, rather than throwing', () => {
    const index = indexByConceptCode([node('dup', CH3), node('dup', CH4)]);
    expect(index.size).toBe(1);
    expect(index.get('dup')?.chapterId).toBe(CH3);
  });
});

describe('resolvePrerequisites', () => {
  it('resolves direct prerequisites and carries the chapter that reaches them', () => {
    const result = resolvePrerequisites(LINEAR, 'm7.decimals.ops');
    expect(result.found).toBe(true);
    if (!result.found) {
      return;
    }
    expect(result.neighbours.map((n) => n.conceptCode)).toEqual([
      'm7.decimals.concept',
      'm7.fractions.ops',
    ]);
    expect(result.neighbours[0]?.chapterId).toBe(CH4);
    expect(result.danglingCodes).toEqual([]);
  });

  it('returns DIRECT prerequisites only — it is not a transitive closure', () => {
    const result = resolvePrerequisites(LINEAR, 'm7.decimals.concept');
    expect(result.found && result.neighbours.map((n) => n.conceptCode)).toEqual([
      'm7.fractions.concept',
    ]);
  });

  it('degrades gracefully on an unknown code — a result, never a throw', () => {
    const result = resolvePrerequisites(LINEAR, 'm7.nothing.here');
    expect(result.found).toBe(false);
    expect(result.conceptCode).toBe('m7.nothing.here');
  });

  it('reports a prerequisite naming a row that does not exist, rather than dropping it', () => {
    const withHole = [node('m7.a', CH3, ['m7.missing', 'm7.b']), node('m7.b', CH4)];
    const result = resolvePrerequisites(withHole, 'm7.a');
    expect(result.found && result.danglingCodes).toEqual(['m7.missing']);
    expect(result.found && result.neighbours.map((n) => n.conceptCode)).toEqual(['m7.b']);
  });

  it('returns an empty neighbour list for a root concept', () => {
    const result = resolvePrerequisites(LINEAR, 'm7.fractions.concept');
    expect(result.found && result.neighbours).toEqual([]);
  });

  it('is deterministic — repeated evaluation returns an identical ordering', () => {
    const first = resolvePrerequisites(LINEAR, 'm7.decimals.ops');
    const second = resolvePrerequisites(LINEAR, 'm7.decimals.ops');
    expect(first).toEqual(second);
  });
});

describe('resolveDependents', () => {
  it('finds the concepts that declare they need this one', () => {
    const result = resolveDependents(LINEAR, 'm7.fractions.concept');
    expect(result.found && result.neighbours.map((n) => n.conceptCode)).toEqual([
      'm7.decimals.concept',
      'm7.fractions.ops',
    ]);
  });

  it('degrades gracefully on an unknown code', () => {
    expect(resolveDependents(LINEAR, 'nope').found).toBe(false);
  });

  it('returns an empty list for a leaf, and never dangling codes', () => {
    const result = resolveDependents(LINEAR, 'm7.decimals.ops');
    expect(result.found && result.neighbours).toEqual([]);
    expect(result.found && result.danglingCodes).toEqual([]);
  });
});

describe('projectToChapterGraph', () => {
  it('collapses concept edges onto chapters', () => {
    const projection = projectToChapterGraph(LINEAR);
    expect(projection.prerequisitesOf.get(CH4)).toEqual([CH3]);
    expect(projection.prerequisitesOf.get(CH5)).toEqual([CH3, CH4]);
    expect(projection.dependentsOf.get(CH3)).toEqual([CH4, CH5]);
  });

  it('DROPS same-chapter edges and counts them — a self-loop is not an ordering', () => {
    const projection = projectToChapterGraph(LINEAR);
    // `m7.fractions.ops needs m7.fractions.concept`, both in chapter 3.
    expect(projection.selfLoopsDropped).toBe(1);
    expect(projection.prerequisitesOf.get(CH3)).toBeUndefined();
  });

  it('collects dangling references instead of silently shortening the graph', () => {
    const projection = projectToChapterGraph([node('m7.a', CH3, ['ghost'])]);
    expect(projection.danglingReferences).toEqual(['ghost']);
    expect(projection.prerequisitesOf.size).toBe(0);
  });

  it('lists every chapter named by any node, sorted', () => {
    const projection = projectToChapterGraph(LINEAR);
    expect(projection.chapters).toEqual([CH3, CH4, CH5]);
  });

  it('deduplicates parallel chapter edges produced by different concepts', () => {
    const parallel = [
      node('a1', CH4, ['b1']),
      node('a2', CH4, ['b2']),
      node('b1', CH3),
      node('b2', CH3),
    ];
    expect(projectToChapterGraph(parallel).prerequisitesOf.get(CH4)).toEqual([CH3]);
  });
});

describe('findLearningPath', () => {
  it('orders every prerequisite before the chapter that needs it, ending at the target', () => {
    const result = findLearningPath(projectToChapterGraph(LINEAR), CH5);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.path).toEqual([CH3, CH4, CH5]);
    expect(result.path[result.path.length - 1]).toBe(CH5);
  });

  it('returns just the target when it has no prerequisites', () => {
    const result = findLearningPath(projectToChapterGraph(LINEAR), CH3);
    expect(result.ok && result.path).toEqual([CH3]);
  });

  it('reports an unknown chapter as a diagnosable result, not a throw', () => {
    const result = findLearningPath(projectToChapterGraph(LINEAR), 'not-a-chapter');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('unknown_chapter');
  });

  it('DETECTS a cycle created by chapter projection and names the closed path', () => {
    const result = findLearningPath(projectToChapterGraph(SEVEN_MATHS), CH3);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'cycle') {
      throw new Error('expected a cycle');
    }
    // Closed: first element repeated as the last, so the path demonstrates itself.
    expect(result.cycle[0]).toBe(result.cycle[result.cycle.length - 1]);
    expect(new Set(result.cycle)).toEqual(new Set([CH3, CH4]));
  });

  it('the same data is ACYCLIC at concept level — the cycle is the projection', () => {
    // Every concept edge in SEVEN_MATHS points at a concept with no prerequisites,
    // so no concept-level walk can revisit anything.
    for (const n of SEVEN_MATHS) {
      for (const code of n.prerequisiteCodes) {
        const target = indexByConceptCode(SEVEN_MATHS).get(code);
        expect(target?.prerequisiteCodes).toEqual([]);
      }
    }
  });

  it('terminates on a self-referential concept rather than looping forever', () => {
    // The self-edge is dropped by projection, so this must simply succeed.
    const result = findLearningPath(projectToChapterGraph([node('a', CH3, ['a'])]), CH3);
    expect(result.ok && result.path).toEqual([CH3]);
  });

  it('handles a deep chain without recursing — 5,000 chapters deep', () => {
    const deep: ConceptGraphNode[] = [];
    for (let i = 0; i < 5_000; i += 1) {
      deep.push(node(`c${String(i)}`, `ch${String(i)}`, i === 0 ? [] : [`c${String(i - 1)}`]));
    }
    const result = findLearningPath(projectToChapterGraph(deep), 'ch4999');
    expect(result.ok && result.path.length).toBe(5_000);
  });

  it('is deterministic across repeated evaluation', () => {
    const projection = projectToChapterGraph(LINEAR);
    expect(findLearningPath(projection, CH5)).toEqual(findLearningPath(projection, CH5));
  });
});

describe('topologicalOrder', () => {
  it('orders the whole projection', () => {
    const result = topologicalOrder(projectToChapterGraph(LINEAR));
    expect(result.ok && result.path).toEqual([CH3, CH4, CH5]);
  });

  it('fails with the cycle when the projection contradicts itself', () => {
    const result = topologicalOrder(projectToChapterGraph(SEVEN_MATHS));
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected a cycle');
    }
    // `TopologicalResult` has exactly two cases — it cannot fail on a missing
    // chapter, because it only ever walks chapters it found itself.
    expect(result.reason).toBe('cycle');
    expect(result.cycle.length).toBeGreaterThan(1);
  });

  it('returns an empty order for an empty graph rather than failing', () => {
    expect(topologicalOrder(projectToChapterGraph([]))).toEqual({ ok: true, path: [] });
  });
});
