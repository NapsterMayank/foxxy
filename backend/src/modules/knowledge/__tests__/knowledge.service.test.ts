import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/platform/logger/index';
import type { ConceptGraphNode } from '../domain/chapter-graph';
import type { KnowledgeRepository } from '../knowledge.repository';
import { createKnowledgeService } from '../knowledge.service';
import type { ChapterConcept, ChapterDescriptor } from '../knowledge.types';

/**
 * Direct construction, no container. The repository is a fake because every
 * decision this service makes is about ORDER and HYDRATION, and both are visible
 * without a database.
 */

const CH1 = 'ch-1';
const CH2 = 'ch-2';
const CH3 = 'ch-3';

function descriptor(chapterId: string, chapterNumber: number): ChapterDescriptor {
  return {
    chapterId,
    grade: '7',
    subjectCode: 'mathematics',
    chapterNumber,
    titleEn: `Chapter ${String(chapterNumber)}`,
    titleHi: null,
  };
}

function node(
  conceptCode: string,
  chapterId: string,
  prerequisiteCodes: readonly string[] = [],
): ConceptGraphNode {
  return { conceptCode, conceptName: conceptCode, chapterId, prerequisiteCodes };
}

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

interface FakeOptions {
  readonly nodes?: readonly ConceptGraphNode[];
  readonly chapters?: readonly ChapterDescriptor[];
  readonly inScope?: readonly ChapterDescriptor[];
  readonly concepts?: readonly ChapterConcept[];
  /** Returns rows in REVERSE, the way an `IN (...)` read is entitled to. */
  readonly scrambleHydration?: boolean;
}

function createFakeRepository(options: FakeOptions = {}): KnowledgeRepository {
  const chapters = options.chapters ?? [descriptor(CH1, 1), descriptor(CH2, 2), descriptor(CH3, 3)];
  return {
    listAllConceptGraphNodes: (): Promise<ConceptGraphNode[]> =>
      Promise.resolve([...(options.nodes ?? [])]),
    listChaptersInScope: (): Promise<ChapterDescriptor[]> =>
      Promise.resolve([...(options.inScope ?? chapters)]),
    getChaptersByIds: (ids): Promise<ChapterDescriptor[]> => {
      const found = chapters.filter((c) => ids.includes(c.chapterId));
      return Promise.resolve(options.scrambleHydration === true ? found.reverse() : found);
    },
    listConceptsForChapter: (): Promise<ChapterConcept[]> =>
      Promise.resolve([...(options.concepts ?? [])]),
  };
}

const LINEAR: readonly ConceptGraphNode[] = [
  node('a', CH1),
  node('b', CH2, ['a']),
  node('c', CH3, ['b']),
];

/** Acyclic at concept level, cyclic once projected. The measured grade 7 defect. */
const PROJECTED_CYCLE: readonly ConceptGraphNode[] = [
  node('fine.b', CH2, ['fine.a']),
  node('fine.a', CH1),
  node('coarse.a', CH1, ['coarse.b']),
  node('coarse.b', CH2),
];

describe('knowledge.service — getConceptsForChapter', () => {
  it('returns the authored concepts of a chapter', async () => {
    const concept: ChapterConcept = {
      id: 'concept-1',
      chapterId: CH1,
      conceptNumber: 1,
      titleEn: 'Understanding Fractions',
      titleHi: null,
      learningObjective: null,
    };
    const service = createKnowledgeService({
      repository: createFakeRepository({ concepts: [concept] }),
      logger: createLogger(),
    });
    await expect(service.getConceptsForChapter(CH1)).resolves.toEqual([concept]);
  });
});

describe('knowledge.service — getPrerequisites / getDependents', () => {
  it('resolves direct prerequisites', async () => {
    const service = createKnowledgeService({
      repository: createFakeRepository({ nodes: LINEAR }),
      logger: createLogger(),
    });
    const result = await service.getPrerequisites('c');
    expect(result.found && result.neighbours.map((n) => n.conceptCode)).toEqual(['b']);
  });

  it('resolves dependents', async () => {
    const service = createKnowledgeService({
      repository: createFakeRepository({ nodes: LINEAR }),
      logger: createLogger(),
    });
    const result = await service.getDependents('a');
    expect(result.found && result.neighbours.map((n) => n.conceptCode)).toEqual(['b']);
  });

  it('degrades gracefully on an unknown code, on both lookups', async () => {
    const service = createKnowledgeService({
      repository: createFakeRepository({ nodes: LINEAR }),
      logger: createLogger(),
    });
    await expect(service.getPrerequisites('ghost')).resolves.toEqual({
      found: false,
      conceptCode: 'ghost',
    });
    await expect(service.getDependents('ghost')).resolves.toEqual({
      found: false,
      conceptCode: 'ghost',
    });
  });
});

describe('knowledge.service — findLearningPath', () => {
  it('returns prerequisites before the target, hydrated', async () => {
    const service = createKnowledgeService({
      repository: createFakeRepository({ nodes: LINEAR }),
      logger: createLogger(),
    });
    const result = await service.findLearningPath(CH3);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.path.map((c) => c.chapterId)).toEqual([CH1, CH2, CH3]);
    expect(result.path[0]?.titleEn).toBe('Chapter 1');
  });

  it('RE-ORDERS after hydration — an IN(...) read may return any order (D-060)', async () => {
    const service = createKnowledgeService({
      repository: createFakeRepository({ nodes: LINEAR, scrambleHydration: true }),
      logger: createLogger(),
    });
    const result = await service.findLearningPath(CH3);
    // The fake returns rows reversed. The path must still be prerequisite-first.
    expect(result.ok && result.path.map((c) => c.chapterId)).toEqual([CH1, CH2, CH3]);
  });

  it('reports a projected cycle with the closed path hydrated, and warns', async () => {
    const logger = createLogger();
    const warn = vi.spyOn(logger, 'warn');
    const service = createKnowledgeService({
      repository: createFakeRepository({ nodes: PROJECTED_CYCLE }),
      logger,
    });
    const result = await service.findLearningPath(CH1);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'cycle') {
      throw new Error('expected a cycle');
    }
    expect(result.cycle.length).toBeGreaterThan(1);
    expect(warn).toHaveBeenCalled();
  });

  it('reports an unknown chapter without querying for chapters', async () => {
    const service = createKnowledgeService({
      repository: createFakeRepository({ nodes: LINEAR }),
      logger: createLogger(),
    });
    await expect(service.findLearningPath('nope')).resolves.toEqual({
      ok: false,
      reason: 'unknown_chapter',
      chapterId: 'nope',
    });
  });

  it('drops a graph chapter with no chapters row, and says so, rather than a hole', async () => {
    const logger = createLogger();
    const warn = vi.spyOn(logger, 'warn');
    const service = createKnowledgeService({
      // CH1 is in the graph but absent from `chapters`.
      repository: createFakeRepository({
        nodes: LINEAR,
        chapters: [descriptor(CH2, 2), descriptor(CH3, 3)],
      }),
      logger,
    });
    const result = await service.findLearningPath(CH3);
    expect(result.ok && result.path.map((c) => c.chapterId)).toEqual([CH2, CH3]);
    expect(warn).toHaveBeenCalled();
  });

  it('returns the target alone when it has no prerequisites', async () => {
    const service = createKnowledgeService({
      repository: createFakeRepository({ nodes: LINEAR }),
      logger: createLogger(),
    });
    const result = await service.findLearningPath(CH1);
    expect(result.ok && result.path.map((c) => c.chapterId)).toEqual([CH1]);
  });
});

describe('knowledge.service — getGraphCoverage', () => {
  it('measures against every chapter in scope and names the uncovered ones', async () => {
    const service = createKnowledgeService({
      repository: createFakeRepository({ nodes: [node('a', CH1)] }),
      logger: createLogger(),
    });
    const coverage = await service.getGraphCoverage('7', 'mathematics');
    expect(coverage.chaptersTotal).toBe(3);
    expect(coverage.chaptersWithGraph).toBe(1);
    expect(coverage.chaptersWithoutGraph).toEqual([CH2, CH3]);
    expect(coverage.orderable).toBe(true);
  });

  it('reports full coverage that is NOT orderable', async () => {
    const service = createKnowledgeService({
      repository: createFakeRepository({
        nodes: PROJECTED_CYCLE,
        inScope: [descriptor(CH1, 1), descriptor(CH2, 2)],
      }),
      logger: createLogger(),
    });
    const coverage = await service.getGraphCoverage('7', 'mathematics');
    expect(coverage.chaptersWithGraph).toBe(2);
    expect(coverage.chaptersTotal).toBe(2);
    expect(coverage.orderable).toBe(false);
  });

  it('does not call a grade orderable when every one of its chapters fails findLearningPath', async () => {
    /**
     * THE TWO CALLS, SIDE BY SIDE, ON ONE SERVICE — which is the only place the
     * defect was visible. `getGraphCoverage` used to project the IN-SCOPE nodes
     * and `findLearningPath` projects ALL of them, so grade 8 mathematics
     * reported 14/14, ratio 1.0, orderable true, cycle [] while all 14 of its
     * chapters returned `{ ok: false, reason: 'cycle' }`.
     *
     * CH1 stands for a grade 8 chapter; the grade 7 pair it depends on
     * contradicts itself, which is out of scope and therefore invisible to the
     * scoped projection.
     */
    const G7_A = 'g7-a';
    const G7_B = 'g7-b';
    const crossGrade: readonly ConceptGraphNode[] = [
      node('g8.concept', CH1, ['g7.fine.b']),
      node('g7.fine.b', G7_A, ['g7.fine.a']),
      node('g7.fine.a', G7_B),
      node('g7.coarse.a', G7_B, ['g7.coarse.b']),
      node('g7.coarse.b', G7_A),
    ];

    const service = createKnowledgeService({
      repository: createFakeRepository({
        nodes: crossGrade,
        inScope: [descriptor(CH1, 1)],
      }),
      logger: createLogger(),
    });

    const path = await service.findLearningPath(CH1);
    expect(path.ok).toBe(false);
    expect(!path.ok && path.reason).toBe('cycle');

    const coverage = await service.getGraphCoverage('8', 'mathematics');
    expect(coverage.chaptersWithGraph).toBe(1);
    expect(coverage.chaptersTotal).toBe(1);
    // The report and the feature now agree. Before: orderable true, no
    // plannable count at all.
    expect(coverage.plannableChapters).toBe(0);
    expect(coverage.orderable).toBe(false);
    // And the scoped diagnostic still says the grade is internally fine, which
    // is what points at the real cause.
    expect(coverage.orderableWithinScope).toBe(true);
  });

  it('reports an empty graph honestly rather than erroring', async () => {
    const service = createKnowledgeService({
      repository: createFakeRepository({ nodes: [] }),
      logger: createLogger(),
    });
    const coverage = await service.getGraphCoverage('11', 'mathematics');
    expect(coverage.chaptersWithGraph).toBe(0);
    expect(coverage.conceptNodes).toBe(0);
  });
});
