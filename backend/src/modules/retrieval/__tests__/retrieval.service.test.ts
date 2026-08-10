import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@/platform/clock/index';
import { createDeterministicEmbed, type EmbeddingProvider } from '@/platform/embed/index';
import { DependencyError, ValidationError } from '@/platform/errors/index';
import { FakeLogger } from '@/platform/logger/index';
import type { AbstainThreshold } from '../domain/abstain-threshold';
import { RRF_K, maxFusedScore } from '../domain/reciprocal-rank-fusion';
import type { CandidateRow, RetrievalRepository, SearchFilter } from '../retrieval.repository';
import { createRetrievalService, type RetrievalService } from '../retrieval.service';
import type { ChunkReader, RetrievedChunkRecord } from '../retrieval.types';

/**
 * THE PIPELINE'S ORCHESTRATION, with the two halves faked.
 *
 * The SQL those halves emit is not testable here and is not tested here — it is
 * pinned against a real Postgres in `tests/integration/retrieval-search.test.ts`
 * (the hard filter, `ef_search`, the NULL-embedding rows, the real corpus).
 * What THIS file owns is everything between the two queries and the answer:
 * fusion order, deduplication, truncation, the abstention branch, the
 * `DependencyError` contract, and the D-060 re-rank after hydration.
 */

const GRADE_7 = { grade: '7', subject: 'science' } as const;

function chunkRecord(id: string, chunkText: string): RetrievedChunkRecord {
  return {
    id,
    chapterId: `chapter-${id}`,
    chunkText,
    chunkIndex: 0,
    grade: '7',
    subject: 'science',
    chapterNumber: 1,
    chapterTitle: 'Heat',
    topic: 'Temperature',
    concept: 'Thermometers',
    language: 'en',
    qualityScore: 0.9,
  };
}

interface FakeRepository extends RetrievalRepository {
  readonly denseCalls: SearchFilter[];
  readonly sparseCalls: SearchFilter[];
}

function fakeRepository(dense: CandidateRow[], sparse: CandidateRow[]): FakeRepository {
  const denseCalls: SearchFilter[] = [];
  const sparseCalls: SearchFilter[] = [];
  return {
    denseCalls,
    sparseCalls,
    searchDense(_vector, filter): Promise<CandidateRow[]> {
      denseCalls.push(filter);
      return Promise.resolve(dense);
    },
    searchSparse(_text, _language, filter): Promise<CandidateRow[]> {
      sparseCalls.push(filter);
      return Promise.resolve(sparse);
    },
  };
}

function row(id: string, chunkText: string, score = 0.1): CandidateRow {
  return { id, chunkText, score };
}

/** Hydration in a DELIBERATELY WRONG order — see the D-060 block below. */
function reversingReader(records: readonly RetrievedChunkRecord[]): ChunkReader {
  return (ids) =>
    Promise.resolve(
      records.filter((record) => ids.includes(record.id)).reverse(),
    );
}

let logger: FakeLogger;
let clock: FixedClock;

beforeEach(() => {
  logger = new FakeLogger();
  clock = new FixedClock();
});

function build(options: {
  readonly dense: CandidateRow[];
  readonly sparse: CandidateRow[];
  readonly records?: RetrievedChunkRecord[];
  readonly readChunks?: ChunkReader;
  readonly embed?: EmbeddingProvider;
  readonly threshold?: AbstainThreshold;
}): { service: RetrievalService; repository: FakeRepository } {
  const repository = fakeRepository(options.dense, options.sparse);
  const records =
    options.records ??
    [...options.dense, ...options.sparse].map((candidate) =>
      chunkRecord(candidate.id, candidate.chunkText),
    );

  return {
    repository,
    service: createRetrievalService({
      repository,
      embed: options.embed ?? createDeterministicEmbed(),
      readChunks: options.readChunks ?? reversingReader(records),
      clock,
      logger,
      ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
    }),
  };
}

describe('the filter is passed to BOTH halves, unchanged', () => {
  it('sends grade and subject to the dense and the sparse query alike', async () => {
    // §8.4 steps 3 and 4: "hard filtered by grade and subject" / "same filter".
    // A filter applied to one half only is worse than none on either: the
    // fused list then mixes grades, and the wrong-grade rows arrive with a
    // score that looks like agreement.
    const { service, repository } = build({ dense: [row('a', 'A')], sparse: [row('a', 'A')] });

    await service.search('what is heat', GRADE_7);

    expect(repository.denseCalls[0]).toEqual({ grade: '7', subject: 'science', limit: 50 });
    expect(repository.sparseCalls[0]).toEqual(repository.denseCalls[0]);
  });

  it('asks each half for 50 candidates', async () => {
    const { service, repository } = build({ dense: [], sparse: [] });

    await service.search('anything', GRADE_7);

    expect(repository.denseCalls[0]?.limit).toBe(50);
  });
});

describe('fusion decides the order', () => {
  it('ranks a chunk found by BOTH halves above one found by only either', async () => {
    const { service } = build({
      dense: [row('denseOnly', 'D'), row('both', 'B')],
      sparse: [row('sparseOnly', 'S'), row('both', 'B')],
    });

    const result = await service.search('what is heat', GRADE_7);

    expect(result.chunks[0]?.id).toBe('both');
    expect(result.scores[0]).toBeCloseTo(2 / (RRF_K + 2), 12);
  });

  it('aligns `scores` with `chunks` by index', async () => {
    const { service } = build({
      dense: [row('a', 'A'), row('b', 'B')],
      sparse: [row('b', 'B')],
    });

    const result = await service.search('what is heat', GRADE_7);

    expect(result.scores).toHaveLength(result.chunks.length);
    expect(result.scores[0]).toBeGreaterThan(result.scores[1] ?? 0);
  });
});

describe('N is 3 at launch, not 8', () => {
  it('returns three chunks from a longer fused list', async () => {
    const dense = Array.from({ length: 10 }, (_unused, index) =>
      row(`d${String(index)}`, `passage ${String(index)}`),
    );
    const { service } = build({ dense, sparse: [] });

    const result = await service.search('what is heat', GRADE_7);

    expect(result.chunks).toHaveLength(3);
  });

  it('honours an explicit topN, which is a PARAMETER and not a second path', async () => {
    const dense = Array.from({ length: 10 }, (_unused, index) =>
      row(`d${String(index)}`, `passage ${String(index)}`),
    );
    const { service } = build({ dense, sparse: [] });

    expect((await service.search('q', { ...GRADE_7, topN: 5 })).chunks).toHaveLength(5);
  });

  it('rejects a nonsense topN rather than silently clamping it', async () => {
    const { service } = build({ dense: [row('a', 'A')], sparse: [] });

    await expect(service.search('q', { ...GRADE_7, topN: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('deduplication — after fusion, before truncation', () => {
  const SAME = 'The least distance of distinct vision is 25 cm.';

  it('collapses duplicates and RECORDS THE COUNT in the trace', async () => {
    const { service } = build({
      dense: [row('copy1', SAME), row('copy2', SAME), row('distinct', 'Something else.')],
      sparse: [],
    });

    const result = await service.search('least distance of distinct vision', GRADE_7);

    expect(result.trace.duplicatesCollapsed).toBe(1);
    expect(result.trace.duplicateGroups[0]).toEqual({
      keptId: 'copy1',
      collapsedIds: ['copy2'],
    });
  });

  it('FILLS the freed slot rather than shrinking the answer', async () => {
    /**
     * The reason the order of steps is a decision. Truncate first and this
     * query returns two chunks — one of which is a duplicate of the other —
     * and retrieval reads as a thin corpus. Deduplicate first and all three
     * slots carry a distinct passage.
     */
    const { service } = build({
      dense: [
        row('copy1', SAME),
        row('copy2', SAME),
        row('copy3', SAME),
        row('b', 'Second distinct passage.'),
        row('c', 'Third distinct passage.'),
      ],
      sparse: [],
    });

    const result = await service.search('least distance', GRADE_7);

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['copy1', 'b', 'c']);
    expect(result.trace.duplicatesCollapsed).toBe(2);
  });

  it('keeps the higher-scoring copy when the duplicate wins in the other half', async () => {
    const { service } = build({
      dense: [row('weak', SAME)],
      sparse: [row('strong', SAME), row('weak', SAME)],
    });

    const result = await service.search('least distance', GRADE_7);

    // `weak` appears in both lists at ranks 1 and 2 (2/61 + 1/62); `strong` is
    // rank 1 of one list only (1/61). Fusion says `weak` is stronger, and
    // deduplication has to agree with fusion rather than with the name.
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['weak']);
  });
});

describe('abstention', () => {
  it('abstains on an EMPTY result rather than throwing', async () => {
    const { service } = build({ dense: [], sparse: [] });

    const result = await service.search('a question about nothing', GRADE_7);

    expect(result.shouldAbstain).toBe(true);
    expect(result.chunks).toEqual([]);
    expect(result.scores).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(result.trace.abstainReason).toBe('no-candidates');
  });

  it('abstains on an EMPTY QUERY without embedding or querying anything', async () => {
    const embed: EmbeddingProvider = {
      model: 'never-called',
      dimensions: 1024,
      embedQuery: () => Promise.reject(new Error('the empty query must not reach the provider')),
    };
    const { service, repository } = build({ dense: [], sparse: [], embed });

    const result = await service.search('   \n  ', GRADE_7);

    expect(result.shouldAbstain).toBe(true);
    expect(repository.denseCalls).toEqual([]);
    expect(repository.sparseCalls).toEqual([]);
  });

  it('abstains BELOW the threshold, and says which kind of abstention it was', async () => {
    const strict: AbstainThreshold = {
      value: maxFusedScore(RRF_K),
      provenance: { state: 'UNCALIBRATED', reason: 'test fixture — abstains on all but a perfect hit' },
    };
    const { service } = build({ dense: [row('a', 'A')], sparse: [], threshold: strict });

    const result = await service.search('what is heat', GRADE_7);

    expect(result.shouldAbstain).toBe(true);
    expect(result.trace.abstainReason).toBe('below-threshold');
    expect(result.chunks).toEqual([]);
  });

  it('does NOT abstain at exactly the threshold', async () => {
    const atRankOneOfOneList: AbstainThreshold = {
      value: 1 / (RRF_K + 1),
      provenance: { state: 'UNCALIBRATED', reason: 'test fixture — boundary' },
    };
    const { service } = build({
      dense: [row('a', 'A')],
      sparse: [],
      threshold: atRankOneOfOneList,
    });

    expect((await service.search('what is heat', GRADE_7)).shouldAbstain).toBe(false);
  });

  it('does not hydrate on the abstain path', async () => {
    // An abstaining turn returns no chunks, so fetching their bodies is a query
    // whose result is discarded — and `foxy` must not be able to quote from a
    // turn that abstained.
    let hydrations = 0;
    const strict: AbstainThreshold = {
      value: maxFusedScore(RRF_K),
      provenance: { state: 'UNCALIBRATED', reason: 'test fixture' },
    };
    const { service } = build({
      dense: [row('a', 'A')],
      sparse: [],
      threshold: strict,
      readChunks: (ids) => {
        hydrations += ids.length;
        return Promise.resolve([]);
      },
    });

    await service.search('what is heat', GRADE_7);

    expect(hydrations).toBe(0);
  });
});

describe('an embedding failure raises DependencyError, never silent garbage', () => {
  it('when the provider throws something unrecognised', async () => {
    const embed: EmbeddingProvider = {
      model: 'broken',
      dimensions: 1024,
      embedQuery: () => Promise.reject(new TypeError('fetch failed')),
    };
    const { service } = build({ dense: [], sparse: [], embed });

    await expect(service.search('what is heat', GRADE_7)).rejects.toBeInstanceOf(DependencyError);
  });

  it('and it names `embed`, so the failure is attributed to the right dependency', async () => {
    const embed: EmbeddingProvider = {
      model: 'broken',
      dimensions: 1024,
      embedQuery: () => Promise.reject(new TypeError('fetch failed')),
    };
    const { service } = build({ dense: [], sparse: [], embed });

    await expect(service.search('what is heat', GRADE_7)).rejects.toSatisfy(
      (error: unknown) => error instanceof DependencyError && error.dependency === 'embed',
    );
  });

  it('passes an existing DependencyError through unwrapped', async () => {
    const original = new DependencyError('embed', { message: 'circuit open' });
    const embed: EmbeddingProvider = {
      model: 'broken',
      dimensions: 1024,
      embedQuery: () => Promise.reject(original),
    };
    const { service } = build({ dense: [], sparse: [], embed });

    await expect(service.search('what is heat', GRADE_7)).rejects.toBe(original);
  });

  it('REFUSES A WRONG-WIDTH VECTOR rather than querying with it', async () => {
    /**
     * The silent-garbage case. A 512-wide vector is a perfectly good vector in
     * a DIFFERENT SPACE: cosine distance still computes, fifty rows still come
     * back, and every one of them is arbitrary.
     */
    const embed: EmbeddingProvider = {
      model: 'mismatched',
      dimensions: 1024,
      embedQuery: () => Promise.resolve(new Array<number>(512).fill(0.1)),
    };
    const { service, repository } = build({ dense: [], sparse: [], embed });

    await expect(service.search('what is heat', GRADE_7)).rejects.toBeInstanceOf(DependencyError);
    expect(repository.denseCalls).toEqual([]);
  });

  it('does not swallow the failure into an abstention', async () => {
    // Abstaining on an embedding outage would tell a student "I do not know"
    // about content the corpus definitely has, and would leave nothing in the
    // metrics saying the provider was down.
    const embed: EmbeddingProvider = {
      model: 'broken',
      dimensions: 1024,
      embedQuery: () => Promise.reject(new Error('down')),
    };
    const { service } = build({ dense: [], sparse: [], embed });

    await expect(service.search('what is heat', GRADE_7)).rejects.toThrow();
  });
});

describe('results are RE-RANKED after hydration — D-060', () => {
  it('returns fused order even when getChunksByIds returns the reverse', async () => {
    /**
     * `getChunksByIds` uses `IN (...)`, so its row order is whatever the plan
     * produced. The fake here reverses deliberately.
     *
     * This is the worst kind of failure to leave untested: nothing errors, the
     * chunks are all real and all relevant, and the best passage is simply no
     * longer first. The answer stays plausible while being quietly worse,
     * forever.
     */
    const { service } = build({
      dense: [row('first', 'A'), row('second', 'B'), row('third', 'C')],
      sparse: [row('first', 'A')],
    });

    const result = await service.search('what is heat', GRADE_7);

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['first', 'second', 'third']);
  });

  it('numbers `rank` from 1 in the FINAL order', async () => {
    const { service } = build({
      dense: [row('first', 'A'), row('second', 'B')],
      sparse: [row('first', 'A')],
    });

    const result = await service.search('what is heat', GRADE_7);

    expect(result.chunks.map((chunk) => chunk.rank)).toEqual([1, 2]);
  });

  it('drops — never fakes — an id that hydrates to nothing', async () => {
    // A chunk deactivated between the search and the read. The trace still
    // lists it as a final id, so "3 ranked, 2 returned" is visible rather than
    // being a mystery about the corpus.
    const { service } = build({
      dense: [row('present', 'A'), row('vanished', 'B')],
      sparse: [],
      readChunks: (ids) =>
        Promise.resolve(ids.includes('present') ? [chunkRecord('present', 'A')] : []),
    });

    const result = await service.search('what is heat', GRADE_7);

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['present']);
    expect(result.trace.finalChunkIds).toEqual(['present', 'vanished']);
  });
});

describe('the trace — the only way a bad answer will ever be debugged', () => {
  it('records both halves, the fusion, the final ids and the decision', async () => {
    const { service } = build({
      dense: [row('a', 'A'), row('b', 'B')],
      sparse: [row('b', 'B')],
    });

    const result = await service.search('  what is   HEAT  ', GRADE_7);
    const { trace } = result;

    expect(trace.query).toBe('  what is   HEAT  ');
    expect(trace.normalisedQuery).toBe('what is HEAT');
    expect(trace.language).toBe('en');
    expect(trace.filters).toEqual({ grade: '7', subject: 'science', topN: 3 });
    expect(trace.denseCandidates).toEqual([
      { id: 'a', score: 0.1, rank: 1 },
      { id: 'b', score: 0.1, rank: 2 },
    ]);
    expect(trace.sparseCandidates).toEqual([{ id: 'b', score: 0.1, rank: 1 }]);
    expect(trace.fusedScores.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(trace.finalChunkIds).toEqual(['b', 'a']);
    expect(trace.abstained).toBe(false);
    expect(trace.abstainReason).toBeNull();
  });

  it('records the ORIGINAL query beside the normalised one', async () => {
    // The two differ, and that difference is the first place a bad answer can
    // come from. A trace with only one of them cannot tell "the student asked
    // a bad question" from "we mangled it before embedding it".
    const { service } = build({ dense: [row('a', 'A')], sparse: [] });

    const { trace } = await service.search('  spaced   out  ', GRADE_7);

    expect(trace.query).not.toBe(trace.normalisedQuery);
    expect(trace.normalisedQuery).toBe('spaced out');
  });

  it('records that the threshold is UNCALIBRATED, on every single turn', async () => {
    // So an abstention in a log is never mistaken for a measured judgement.
    const { service } = build({ dense: [row('a', 'A')], sparse: [] });

    expect((await service.search('q', GRADE_7)).trace.thresholdState).toBe('UNCALIBRATED');
  });

  it('records the embedding model, because a different model is a different space', async () => {
    const { service } = build({ dense: [row('a', 'A')], sparse: [] });

    expect((await service.search('q', GRADE_7)).trace.embeddingModel).toBe('deterministic-fake');
  });

  it('measures latency on the INJECTED clock, never on Date.now', async () => {
    const embed: EmbeddingProvider = {
      model: 'slow',
      dimensions: 1024,
      embedQuery: (text) => {
        clock.advanceMs(250);
        return createDeterministicEmbed().embedQuery(text);
      },
    };
    const { service } = build({ dense: [row('a', 'A')], sparse: [], embed });

    expect((await service.search('q', GRADE_7)).trace.latencyMs).toBe(250);
  });

  it('is written for an ABSTAINING turn too, which is when it is most wanted', async () => {
    const { service } = build({ dense: [], sparse: [] });

    const { trace } = await service.search('something off-syllabus', GRADE_7);

    expect(trace.abstained).toBe(true);
    expect(trace.filters.grade).toBe('7');
    expect(trace.denseCandidates).toEqual([]);
    expect(trace.thresholdValue).toBeGreaterThan(0);
  });

  it('carries NO student identifier', async () => {
    /**
     * The trace records the QUESTION, which is enough to reproduce the
     * retrieval, and nothing that says who asked it. A trace kept for
     * debugging that also identifies the student is a debugging aid that has
     * become a second copy of their activity log.
     */
    const { service } = build({ dense: [row('a', 'A')], sparse: [] });

    const { trace } = await service.search('q', GRADE_7);

    expect(Object.keys(trace)).not.toContain('studentId');
    expect(Object.keys(trace)).not.toContain('userId');
    expect(JSON.stringify(trace)).not.toMatch(/student|user|email/i);
  });
});
