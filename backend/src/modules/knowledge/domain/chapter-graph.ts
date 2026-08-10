/**
 * CHAPTER GRAPH — the pure half of `knowledge`.
 *
 * ===========================================================================
 * THE GRANULARITY CONSTRAINT, STATED IN THE TYPES RATHER THAN IN A COMMENT.
 *
 * `concept_graph.concept_code` DOES NOT JOIN to `chapter_concepts`. They are two
 * independently-generated vocabularies and there is no shared key — the schema
 * header of `platform/db/schema/pedagogy.ts` says so, and the measurement agrees.
 * NONE IS INVENTED HERE: no string-munging, no fuzzy title match, no lookup table.
 *
 * What that leaves is a graph that is internally consistent — every one of the
 * 176 prerequisite references resolves to a real `concept_code`, measured, zero
 * dangling — but whose only link OUT to the rest of the corpus (`chapter_concepts`,
 * `questions`, `rag_chunks`) is `chapter_id`. So:
 *
 *   - traversal happens over CONCEPT CODES, which is where the authored edges are;
 *   - anything a student is shown is a CHAPTER, because that is the only key that
 *     reaches content.
 *
 * Both facts are in the type names. `ConceptCode` is a traversal handle and
 * nothing else; `ChapterNodeId` is what a learning path is made of. A function
 * returning `ChapterNodeId[]` is telling you it cannot be more precise than a
 * chapter, and that is not a limitation to be fixed later by widening the type.
 *
 * ===========================================================================
 * PROJECTING TO CHAPTERS CREATES CYCLES THAT THE CONCEPT GRAPH DOES NOT HAVE.
 *
 * This is the single most surprising property of the imported data and the reason
 * `topologicalOrder` is cycle-safe rather than merely careful.
 *
 * Measured on the real corpus: the concept-level graph is ACYCLIC — 0 cycles over
 * 176 edges. Its chapter projection has THREE, all in grade 7 mathematics.
 *
 * The cause is two authoring schemes layered on the same chapters. Grade 7 and 8
 * mathematics carry both a COARSE scheme (`math_7_ch5`, one code per chapter) and
 * a FINE scheme (`m7.geometry.triangles`, several codes per chapter); no other
 * grade or subject has the fine one. Each scheme is individually consistent. The
 * fine scheme orders concepts in a way that disagrees with the coarse scheme's
 * chapter order, and collapsing both onto `chapter_id` merges two independent
 * authorings into one graph that contradicts itself:
 *
 *   7/math/ch8 -> ch7 -> ch5 -> ch4 -> ch3 -> ch8
 *     via `math_7_ch8 needs math_7_ch7`      (coarse)
 *     via `m7.geometry.triangles needs m7.geometry.angles`  (fine)
 *     via `m7.decimals.concept needs m7.fractions.concept`  (fine)
 *
 * A cycle here is therefore NOT corrupt data and must not be repaired by dropping
 * an edge — both edges are true statements about concepts. It is a real limit of
 * chapter granularity, and the honest response is to REPORT it with the path that
 * demonstrates it, so a human can decide which scheme wins. That is why the
 * failure carries the cycle rather than a boolean.
 *
 * ===========================================================================
 * SELF-LOOPS ARE DROPPED, AND COUNTED.
 *
 * 22 of the 176 edges are between two concepts in the SAME chapter. Under
 * projection those become chapter self-edges, and a self-edge makes every
 * topological sort report a cycle — a false one, since "chapter 4 requires
 * chapter 4" is not a claim about ordering at all. They are dropped, and the
 * count is returned, because a projection that silently discarded an eighth of
 * its input would be reporting coverage it does not have.
 *
 * Pure: no I/O, no clock, no randomness. Every traversal sorts its frontier, so
 * the output is a function of the input and nothing else.
 */

/** A traversal handle into `concept_graph`. NOT a key into `chapter_concepts`. */
export type ConceptCode = string;

/** A chapter's uuid. The only identifier in this file that reaches content. */
export type ChapterNodeId = string;

/**
 * One `concept_graph` row, reduced to the four fields traversal reads.
 *
 * `prerequisiteCodes` may name a code that does not exist — the column has no
 * foreign key by design. It happens to be empty of dangling references today
 * (measured: 176 of 176 resolve) and the code does not assume that will hold.
 */
export interface ConceptGraphNode {
  readonly conceptCode: ConceptCode;
  readonly conceptName: string | null;
  readonly chapterId: ChapterNodeId;
  readonly prerequisiteCodes: readonly ConceptCode[];
}

/** A concept-level neighbour, carrying the chapter that makes it reachable. */
export interface ResolvedNeighbour {
  readonly conceptCode: ConceptCode;
  readonly conceptName: string | null;
  readonly chapterId: ChapterNodeId;
}

/**
 * The answer to "what does this concept need", including what it needs that we
 * do not have.
 *
 * `found: false` rather than a throw. An unknown code is an ordinary outcome —
 * a caller may hold a code from a wider import — and the caller that wants to
 * treat it as fatal can, while the caller rendering a screen should not have to
 * wrap a lookup in a try block.
 */
export type NeighbourLookup =
  | {
      readonly found: false;
      readonly conceptCode: ConceptCode;
    }
  | {
      readonly found: true;
      readonly conceptCode: ConceptCode;
      readonly neighbours: readonly ResolvedNeighbour[];
      /**
       * Prerequisite codes naming a row that does not exist. Reported, never
       * silently skipped: a path built over a graph with holes is shorter than
       * the truth, and nothing about the shorter path looks wrong.
       */
      readonly danglingCodes: readonly ConceptCode[];
    };

/** The chapter-granularity graph. Built once, traversed many times. */
export interface ChapterProjection {
  /** chapter -> the chapters it requires. Sorted, so traversal is deterministic. */
  readonly prerequisitesOf: ReadonlyMap<ChapterNodeId, readonly ChapterNodeId[]>;
  /** The reverse index, for `getDependents`. */
  readonly dependentsOf: ReadonlyMap<ChapterNodeId, readonly ChapterNodeId[]>;
  /** Every chapter named by any surviving edge. */
  readonly chapters: readonly ChapterNodeId[];
  /** Same-chapter edges removed by the projection. See the header. */
  readonly selfLoopsDropped: number;
  /** Prerequisite references that named no row. */
  readonly danglingReferences: readonly ConceptCode[];
}

/**
 * A learning path, or the reason there cannot be one.
 *
 * The failure names the cycle as an ordered, closed chapter list
 * (`a -> b -> c -> a`), because "there is a cycle" is not diagnosable and this is.
 */
export type LearningPathResult =
  | { readonly ok: true; readonly path: readonly ChapterNodeId[] }
  | {
      readonly ok: false;
      readonly reason: 'cycle';
      /** Closed: the first element is repeated as the last. */
      readonly cycle: readonly ChapterNodeId[];
    }
  | { readonly ok: false; readonly reason: 'unknown_chapter'; readonly chapterId: ChapterNodeId };

/** Indexes nodes by code. Later duplicates lose — the column is unique in the database. */
export function indexByConceptCode(
  nodes: readonly ConceptGraphNode[],
): ReadonlyMap<ConceptCode, ConceptGraphNode> {
  const index = new Map<ConceptCode, ConceptGraphNode>();
  for (const node of nodes) {
    if (!index.has(node.conceptCode)) {
      index.set(node.conceptCode, node);
    }
  }
  return index;
}

function toNeighbour(node: ConceptGraphNode): ResolvedNeighbour {
  return {
    conceptCode: node.conceptCode,
    conceptName: node.conceptName,
    chapterId: node.chapterId,
  };
}

function byConceptCode(left: ResolvedNeighbour, right: ResolvedNeighbour): number {
  return left.conceptCode < right.conceptCode ? -1 : left.conceptCode > right.conceptCode ? 1 : 0;
}

/**
 * The concepts `conceptCode` declares it requires.
 *
 * DIRECT only. Transitive closure is `findLearningPath`'s job, and conflating
 * the two is how a "prerequisites" list quietly becomes a syllabus.
 */
export function resolvePrerequisites(
  nodes: readonly ConceptGraphNode[],
  conceptCode: ConceptCode,
): NeighbourLookup {
  const index = indexByConceptCode(nodes);
  const node = index.get(conceptCode);
  if (node === undefined) {
    return { found: false, conceptCode };
  }

  const neighbours: ResolvedNeighbour[] = [];
  const danglingCodes: ConceptCode[] = [];
  for (const code of node.prerequisiteCodes) {
    const target = index.get(code);
    if (target === undefined) {
      danglingCodes.push(code);
    } else {
      neighbours.push(toNeighbour(target));
    }
  }

  return {
    found: true,
    conceptCode,
    neighbours: neighbours.sort(byConceptCode),
    danglingCodes: [...danglingCodes].sort(),
  };
}

/**
 * The concepts that declare they require `conceptCode` — the reverse edge.
 *
 * `danglingCodes` is always empty here and the field is kept anyway: a dependent
 * is found by scanning rows that exist, so the question cannot arise. Dropping
 * the field would make the two lookups different shapes for no gain to a caller
 * that handles both.
 */
export function resolveDependents(
  nodes: readonly ConceptGraphNode[],
  conceptCode: ConceptCode,
): NeighbourLookup {
  const index = indexByConceptCode(nodes);
  if (!index.has(conceptCode)) {
    return { found: false, conceptCode };
  }

  const neighbours = nodes
    .filter((node) => node.prerequisiteCodes.includes(conceptCode))
    .map(toNeighbour)
    .sort(byConceptCode);

  return { found: true, conceptCode, neighbours, danglingCodes: [] };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Collapses the concept graph onto chapters.
 *
 * Self-edges are dropped and counted; dangling references are collected. Both
 * adjacency maps are sorted so that every traversal built on them is
 * deterministic without having to sort again.
 */
export function projectToChapterGraph(nodes: readonly ConceptGraphNode[]): ChapterProjection {
  const index = indexByConceptCode(nodes);
  const forward = new Map<ChapterNodeId, Set<ChapterNodeId>>();
  const reverse = new Map<ChapterNodeId, Set<ChapterNodeId>>();
  const chapters = new Set<ChapterNodeId>();
  const dangling: ConceptCode[] = [];
  let selfLoopsDropped = 0;

  for (const node of nodes) {
    chapters.add(node.chapterId);
    for (const code of node.prerequisiteCodes) {
      const target = index.get(code);
      if (target === undefined) {
        dangling.push(code);
        continue;
      }
      if (target.chapterId === node.chapterId) {
        selfLoopsDropped += 1;
        continue;
      }
      chapters.add(target.chapterId);
      const forwardSet = forward.get(node.chapterId) ?? new Set<ChapterNodeId>();
      forwardSet.add(target.chapterId);
      forward.set(node.chapterId, forwardSet);
      const reverseSet = reverse.get(target.chapterId) ?? new Set<ChapterNodeId>();
      reverseSet.add(node.chapterId);
      reverse.set(target.chapterId, reverseSet);
    }
  }

  const freeze = (
    source: ReadonlyMap<ChapterNodeId, Set<ChapterNodeId>>,
  ): ReadonlyMap<ChapterNodeId, readonly ChapterNodeId[]> => {
    const out = new Map<ChapterNodeId, readonly ChapterNodeId[]>();
    for (const [key, value] of source) {
      out.set(key, sortedUnique(value));
    }
    return out;
  };

  return {
    prerequisitesOf: freeze(forward),
    dependentsOf: freeze(reverse),
    chapters: sortedUnique(chapters),
    selfLoopsDropped,
    danglingReferences: sortedUnique(dangling),
  };
}

/**
 * An ordering result for a walk whose starting chapter is already known to
 * exist — so `unknown_chapter` is not one of its cases.
 *
 * A SEPARATE, NARROWER TYPE than `LearningPathResult`, because a union carrying
 * a case that cannot occur forces every caller to write a branch that can never
 * run, and a branch that can never run is untestable by definition. Narrowing
 * here is what lets both public functions be fully exercised.
 */
export type WalkResult =
  | { readonly ok: true; readonly path: readonly ChapterNodeId[] }
  | { readonly ok: false; readonly cycle: readonly ChapterNodeId[] };

/** The same, for a whole-graph ordering, which likewise cannot fail on a missing chapter. */
export type TopologicalResult =
  | { readonly ok: true; readonly path: readonly ChapterNodeId[] }
  | { readonly ok: false; readonly reason: 'cycle'; readonly cycle: readonly ChapterNodeId[] };

const WHITE = 0;
const GREY = 1;
const BLACK = 2;

/**
 * Depth-first post-order walk from a chapter that is known to be in the graph.
 *
 * ITERATIVE, NOT RECURSIVE: the graph is authored data, and a deep or
 * adversarial chain must not be able to overflow the stack of a request handler.
 *
 * EACH FRAME HOLDS AN ITERATOR RATHER THAN AN INDEX. Indexing an array under
 * `noUncheckedIndexedAccess` yields `T | undefined`, which forces a guard the
 * length check has already made impossible — an unreachable branch that no test
 * can cover and that quietly lowers the floor for every real branch beside it.
 * An `IteratorResult` is a discriminated union, so `done: false` narrows `value`
 * to `ChapterNodeId` and the guard is not needed at all.
 *
 * `colour` is the standard three-state marking: WHITE unvisited, GREY on the
 * current chain, BLACK finished. A GREY neighbour is a back edge, which is a
 * cycle, and the current chain names it.
 */
function walkFrom(
  projection: ChapterProjection,
  target: ChapterNodeId,
  colour: Map<ChapterNodeId, number>,
): WalkResult {
  interface Frame {
    readonly node: ChapterNodeId;
    readonly remaining: Iterator<ChapterNodeId>;
  }

  const frameFor = (node: ChapterNodeId): Frame => ({
    node,
    remaining: (projection.prerequisitesOf.get(node) ?? [])[Symbol.iterator](),
  });

  const path: ChapterNodeId[] = [];
  /** The current DFS chain, used only to name a cycle when one is found. */
  const chain: ChapterNodeId[] = [target];
  const parents: Frame[] = [];
  let current = frameFor(target);
  colour.set(target, GREY);

  for (;;) {
    const step = current.remaining.next();

    if (step.done === true) {
      colour.set(current.node, BLACK);
      path.push(current.node);
      chain.pop();
      const parent = parents.pop();
      // The only way out of the loop: the starting frame has no parent.
      if (parent === undefined) {
        return { ok: true, path };
      }
      current = parent;
      continue;
    }

    const next = step.value;
    const state = colour.get(next) ?? WHITE;
    if (state === GREY) {
      const start = chain.indexOf(next);
      return { ok: false, cycle: [...chain.slice(start), next] };
    }
    if (state === WHITE) {
      colour.set(next, GREY);
      chain.push(next);
      parents.push(current);
      current = frameFor(next);
    }
  }
}

/**
 * Every chapter `target` transitively requires, in an order that puts each
 * prerequisite before the chapter needing it, ending with `target` itself.
 *
 * On a cycle it stops and returns the closed path. It does not "break the cycle
 * and carry on" — see the header: both edges in a projected cycle are true, so
 * choosing one is an editorial decision this function has no standing to make.
 */
export function findLearningPath(
  projection: ChapterProjection,
  target: ChapterNodeId,
): LearningPathResult {
  if (!projection.chapters.includes(target)) {
    return { ok: false, reason: 'unknown_chapter', chapterId: target };
  }

  const result = walkFrom(projection, target, new Map<ChapterNodeId, number>());
  return result.ok
    ? { ok: true, path: result.path }
    : { ok: false, reason: 'cycle', cycle: result.cycle };
}

/**
 * Whether the whole projection can be ordered — the same walk from every root.
 *
 * Separate from `findLearningPath` because "can this chapter be reached" and "is
 * this graph orderable at all" are different questions, and a coverage report
 * wants the second one without naming a target.
 *
 * ONE `colour` MAP ACROSS EVERY WALK. A chapter already finished (BLACK) is not
 * re-walked, so the whole ordering is linear in the size of the graph rather
 * than quadratic in the number of roots.
 */
export function topologicalOrder(projection: ChapterProjection): TopologicalResult {
  const ordered: ChapterNodeId[] = [];
  const seen = new Set<ChapterNodeId>();
  const colour = new Map<ChapterNodeId, number>();

  for (const chapter of projection.chapters) {
    if (seen.has(chapter)) {
      continue;
    }
    const result = walkFrom(projection, chapter, colour);
    if (!result.ok) {
      return { ok: false, reason: 'cycle', cycle: result.cycle };
    }
    for (const node of result.path) {
      if (!seen.has(node)) {
        seen.add(node);
        ordered.push(node);
      }
    }
  }

  return { ok: true, path: ordered };
}
