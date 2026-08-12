import type { Clock } from '@/platform/clock/index';
import type { EmbeddingProvider } from '@/platform/embed/index';
import type { Logger } from '@/platform/logger/index';
import {
  createRetrievalRepository,
  type RetrievalDbHandle,
} from './retrieval.repository';
import { createRetrievalService, type RetrievalService } from './retrieval.service';
import type { AbstainThreshold } from './domain/abstain-threshold';
import type { ChunkReader } from './retrieval.types';

/**
 * ============================================================================
 * retrieval — THE PUBLIC SURFACE.
 *
 * This is the only file another module may import (00-ARCHITECTURE.md,
 * Foundation 1, enforced by ESLint `no-restricted-imports`). Everything else in
 * this directory is private.
 *
 * Owns: hybrid search, ranking and the abstention decision (plan §8.4).
 * **Not prompts** — those belong to `foxy`, which is the module that decides
 * what a student is TOLD. This one decides only what evidence exists.
 *
 * NO HTTP ENDPOINTS. `retrieval` is called by `foxy` in-process. It is not a
 * public API because a retrieval endpoint is an unauthenticated way to page
 * through the corpus, and because a caller who could choose the filters could
 * choose a grade the student is not in.
 * ============================================================================
 *
 * THE FOUR THINGS ABOUT THIS MODULE MOST LIKELY TO BE UNDONE BY ACCIDENT.
 *
 * 1. THERE IS ONE PIPELINE. Configuration changes parameters — `topN`, the
 *    threshold, the candidate depth — never which code runs. The previous
 *    system had two paths that drifted until a fix applied to one was missing
 *    from the other. An `if (mode === …)` in `retrieval.service.ts` is the
 *    regression, not a feature.
 *
 * 2. THE THRESHOLD IS MEASURED (10 August 2026) AND SAYS SO IN ITS OWN TYPE. It
 *    cannot be marked `MEASURED` without supplying the sample sizes, both
 *    percentiles, both error rates, the corpus, the model, the candidate depth
 *    and the placement rule — that is a compile error, not a review comment.
 *    Read the header of `domain/abstain-threshold.ts` before touching the
 *    number: it carries both distributions and what the value costs.
 *
 *    ANYTHING THAT CHANGES THE RETRIEVER INVALIDATES IT — the sparse query, the
 *    ranking function, `RRF_K`, `CANDIDATE_LIMIT`, the embedding model. That is
 *    a re-run of `npm run eval:retrieval:calibrate`, not an adjustment. The
 *    service now REFUSES TO START on a threshold that is off the fused scale or
 *    measured at a different candidate depth, so the mismatch is a boot failure
 *    rather than a silent change in what students are told.
 *
 * 3. DEDUPLICATION HAPPENS AFTER FUSION AND BEFORE TRUNCATION, and the order is
 *    the decision. A quarter of the corpus is exact-duplicate passages (D-108).
 *    Truncate first and "the top three are the same paragraph" becomes a
 *    one-chunk answer that reads as a thin corpus.
 *
 * 4. RESULTS ARE RE-RANKED AFTER HYDRATION (D-060). `getChunksByIds` uses
 *    `IN (...)` and returns rows in arbitrary order. Trusting that order
 *    scrambles the ranking while returning perfectly valid chunks — nothing
 *    errors, the answer stays plausible, and the best passage is quietly no
 *    longer first.
 */

export interface RetrievalModuleDeps {
  /**
   * §3.1: the `ai` pool — `container.poolFor('retrieval')`.
   *
   * NOT `core`, even though `content` owns `rag_chunks` and runs there. The
   * pool follows the CALLER's cost profile: a slow HNSW scan holding a `core`
   * connection puts every chapter listing behind vector search.
   *
   * The pool must carry `hnsw.ef_search = 100` (D-049) or the top-50 dense
   * query silently returns 40. `platform/db/pools.ts` sets it on `ai` AND on
   * `worker`, which are the two pools `buildModules` can hand this module —
   * the worker one was missing for a while and the symptom was a top-50 that
   * was quietly a top-40 in background jobs only.
   */
  readonly db: RetrievalDbHandle;
  /** Guarded by the composition root. Never a bare adapter. */
  readonly embed: EmbeddingProvider;
  /** `content.getChunksByIds`. Order is arbitrary — see note 4. */
  readonly readChunks: ChunkReader;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Defaults to the shipped UNCALIBRATED constant. See note 2. */
  readonly threshold?: AbstainThreshold;
  /** Defaults to §8.4's top 50 per half. */
  readonly candidateLimit?: number;
}

export interface RetrievalModule {
  /** The only object other modules should hold. */
  readonly service: RetrievalService;
}

export function createRetrievalModule(deps: RetrievalModuleDeps): RetrievalModule {
  return {
    service: createRetrievalService({
      repository: createRetrievalRepository(deps.db),
      embed: deps.embed,
      readChunks: deps.readChunks,
      clock: deps.clock,
      logger: deps.logger,
      ...(deps.threshold === undefined ? {} : { threshold: deps.threshold }),
      ...(deps.candidateLimit === undefined ? {} : { candidateLimit: deps.candidateLimit }),
    }),
  };
}

/**
 * ---------------------------------------------------------------------------
 * The one use-case, as named in §8.4.
 *
 *   search(query, filters)  Hybrid dense + sparse search over the NCERT corpus,
 *                           hard filtered by grade and subject, fused by RRF,
 *                           deduplicated, truncated to N (3 at launch), with an
 *                           abstention decision and a full trace.
 * ---------------------------------------------------------------------------
 */
export type { RetrievalService } from './retrieval.service';

export type {
  CandidateScore,
  ChunkReader,
  RetrievalFilters,
  RetrievalResult,
  RetrievalTrace,
  RetrievedChunk,
  RetrievedChunkRecord,
} from './retrieval.types';

/**
 * The threshold, its provenance type, and the calibration arithmetic.
 *
 * Exported because the eval harness in `eval/retrieval/` has to import them and
 * because `foxy` will want to know whether the floor that made it abstain was
 * ever measured — an abstention under an uncalibrated threshold is a different
 * fact from one under a measured threshold, and the student-facing message may
 * eventually need to differ.
 */
export {
  ABSTAIN_THRESHOLD,
  CANDIDATE_LIMIT,
  DEFAULT_TOP_N,
  assertThresholdMatchesCandidateDepth,
  assertThresholdOnFusedScale,
  confidenceFrom,
  decideAbstention,
  isUncalibrated,
} from './domain/abstain-threshold';
export type {
  AbstainReason,
  AbstainThreshold,
  ThresholdPolicy,
  ThresholdProvenance,
} from './domain/abstain-threshold';

export {
  DEFAULT_FALSE_ABSTAIN_BUDGET,
  calibrate,
  describeDistribution,
  percentile,
  suggestThreshold,
  suggestThresholdWithinFalseAbstainBudget,
  toMeasuredThreshold,
} from './domain/calibration';
export type {
  CalibrationInput,
  CalibrationReport,
  Distribution,
  ScoreSample,
} from './domain/calibration';

export { RRF_K, fuse, maxFusedScore, minFusedScore } from './domain/reciprocal-rank-fusion';
export type { FusedCandidate } from './domain/reciprocal-rank-fusion';

/**
 * Deduplication, including the collapse itself.
 *
 * `deduplicateByText` is exported for the same reason the threshold is: the
 * eval harness in `eval/retrieval/` measures how much of the corpus is
 * exact-duplicate passages (D-108 put it near a quarter), and it must measure
 * that with the SAME function the pipeline runs. A harness with its own copy of
 * the collapse would report a number about itself.
 */
export { deduplicateByText, hashChunkText, normaliseChunkText } from './domain/deduplicate';
export type {
  DeduplicableCandidate,
  DeduplicationResult,
  DuplicateGroup,
} from './domain/deduplicate';
export { MAX_QUERY_CHARS, detectLanguage, normaliseQuery } from './domain/query-normalisation';
