import type { Clock } from '@/platform/clock/index';
import type { EmbeddingProvider } from '@/platform/embed/index';
import { DependencyError, isAppError, ValidationError } from '@/platform/errors/index';
import type { Logger } from '@/platform/logger/index';
import {
  ABSTAIN_THRESHOLD,
  CANDIDATE_LIMIT,
  DEFAULT_TOP_N,
  assertThresholdMatchesCandidateDepth,
  assertThresholdOnFusedScale,
  confidenceFrom,
  decideAbstention,
  type AbstainReason,
  type AbstainThreshold,
} from './domain/abstain-threshold';
import { deduplicateByText } from './domain/deduplicate';
import { normaliseQuery } from './domain/query-normalisation';
import { RRF_K, fuse, type FusedCandidate } from './domain/reciprocal-rank-fusion';
import type { CandidateRow, RetrievalRepository } from './retrieval.repository';
import type {
  CandidateScore,
  ChunkReader,
  RetrievalFilters,
  RetrievalResult,
  RetrievalTrace,
  RetrievedChunk,
} from './retrieval.types';

/**
 * =============================================================================
 * THE RETRIEVAL PIPELINE — §8.4. ONE PATH. NO ALTERNATIVES.
 * =============================================================================
 *
 *   1  normalise the query, detect the language      domain/query-normalisation
 *   2  embed                                         platform/embed
 *   3  dense  — HNSW, top 50, hard grade+subject     repository.searchDense
 *   4  sparse — full text, top 50, SAME filter       repository.searchSparse
 *   5  reciprocal rank fusion, k = 60                domain/reciprocal-rank-fusion
 *   6  deduplicate on normalised text                domain/deduplicate
 *   7  take top N — 3 at launch, not 8               here
 *   8  abstain below the threshold                   domain/abstain-threshold
 *
 * THERE IS NO SECOND PATH, and that is the load-bearing sentence in this file.
 * The previous system had two — a "fast path" and a "full path" — which drifted
 * until a fix applied to one was absent from the other, and which one ran
 * depended on a flag nobody could find. Every knob here (`topN`, the threshold,
 * the candidate limit) changes a PARAMETER. None of them changes which code
 * runs. If you are about to add `if (mode === …)` to this function, that is the
 * regression.
 *
 * -----------------------------------------------------------------------------
 * ON THE EMBEDDING FAILURE, because there is a real tension and it was decided
 * rather than overlooked.
 *
 * 04-RESILIENCE-PLAN.md §6 describes a degradation where embeddings are down
 * and retrieval falls back to keyword-only. §8.4 requires that "an embedding
 * failure raises `DependencyError` rather than returning silent garbage".
 *
 * §8.4 wins HERE, at this build step, and the reason is that the degradation is
 * not free: a keyword-only result is scored on a scale the abstention threshold
 * was never calibrated against. That argument got STRONGER on 10 August 2026,
 * not weaker, when the threshold became measured: 0.029877 was observed against
 * fused scores from BOTH halves, and a sparse-only turn cannot reach a fused
 * score above 1/(60+1) = 0.016393 no matter how good the passage is. Serving
 * half a pipeline under a floor measured for the whole one would abstain on
 * literally everything — precisely the class of failure §8.4 exists to prevent,
 * and now arithmetic rather than a worry. When
 * the degradation lands it will be an explicit, flagged, separately-calibrated
 * decision made by `foxy`, which is the layer that owns what a student is told
 * when the system is degraded. Not an `if` in here.
 * =============================================================================
 */

export interface RetrievalServiceDeps {
  readonly repository: RetrievalRepository;
  /** Already wrapped in its breaker, limiter and timeout by the composition root. */
  readonly embed: EmbeddingProvider;
  /** `content.getChunksByIds`, injected. Returns rows in ARBITRARY order (D-060). */
  readonly readChunks: ChunkReader;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Overridable so the eval harness can sweep candidate values without a second
   * code path, and so a TEST HARNESS embedding with a semantics-free fake can
   * state a floor of its own rather than silently inherit one measured against
   * real voyage-3 vectors (see `tests/helpers/app-harness.ts`).
   *
   * Defaults to the shipped constant — MEASURED since 10 August 2026. Whatever
   * lands here is what `RetrievalService.threshold` reports, so the value in
   * force is readable rather than inferred.
   */
  readonly threshold?: AbstainThreshold;
  /** Overridable for the same reason. Defaults to §8.4's 50. */
  readonly candidateLimit?: number;
}

export interface RetrievalService {
  search(query: string, filters: RetrievalFilters): Promise<RetrievalResult>;
  /**
   * THE THRESHOLD THIS SERVICE IS ACTUALLY RUNNING, after `deps.threshold ??
   * ABSTAIN_THRESHOLD` has been resolved and both guards have passed.
   *
   * Exposed for ONE reason, and it is not convenience. The floor is now
   * overridable (the eval harness sweeps it; the service-test harness replaces
   * it because deterministic embeddings are on a different distribution), and
   * an override is exactly the kind of thing that leaks from a test seam into
   * the composition root without anybody noticing — the production wiring in
   * `app/routes.ts` passes no threshold, and "passes no threshold" is invisible
   * in a diff. Reading the resolved value back makes "production still runs the
   * MEASURED floor" an assertion (`app/__tests__/wiring.test.ts`) rather than a
   * belief about a line that is not there.
   *
   * It is read-only and carries its provenance, so nothing can consume it as a
   * bare number without also being handed the evidence behind it.
   */
  readonly threshold: AbstainThreshold;
}

function toCandidateScores(rows: readonly CandidateRow[]): CandidateScore[] {
  return rows.map((row, index) => ({ id: row.id, score: row.score, rank: index + 1 }));
}

export function createRetrievalService(deps: RetrievalServiceDeps): RetrievalService {
  const threshold = deps.threshold ?? ABSTAIN_THRESHOLD;
  const candidateLimit = deps.candidateLimit ?? CANDIDATE_LIMIT;

  /**
   * ==========================================================================
   * BOTH GUARDS RUN ON THE THRESHOLD THIS SERVICE WILL ACTUALLY USE, HERE, AT
   * CONSTRUCTION — BEFORE ANY QUERY CAN BE ISSUED.
   *
   * They used to run on neither. `assertThresholdOnFusedScale` was written to
   * make §8.4's year-long silent filter impossible and was applied only to the
   * shipped constant, which is the one value nobody could get wrong. The line
   * above is `deps.threshold ?? ABSTAIN_THRESHOLD`, so the SUPPORTED override —
   * the one the eval harness and every future caller uses — walked a value of
   * any shape straight past the guard. `{ value: 0.7 }` is a perfectly sensible
   * cosine floor, an unreachable fused one, and would have abstained on every
   * single query while the trace reported the threshold without complaint.
   *
   * The depth check is the same defect in its second form: the value is only
   * meaningful at the candidate depth it was measured at, and `candidateLimit`
   * is overridable independently. See `assertThresholdMatchesCandidateDepth`.
   *
   * A throw at construction is deliberate. This is a composition-root mistake,
   * and the failure a composition-root mistake deserves is a process that does
   * not start — not a pipeline that runs and answers differently.
   * ==========================================================================
   */
  assertThresholdOnFusedScale(threshold.value, candidateLimit);
  assertThresholdMatchesCandidateDepth(threshold, candidateLimit);

  /**
   * Everything a trace needs that is not known until the end, assembled in one
   * place so no branch can return a result with a half-built trace. §8.4 calls
   * the trace "the only way a bad answer will ever be debugged", and a trace
   * that exists on the happy path only is one that is absent for every answer
   * anybody wants to debug.
   */
  function buildTrace(parts: {
    readonly query: string;
    readonly normalised: ReturnType<typeof normaliseQuery>;
    readonly filters: RetrievalFilters;
    readonly topN: number;
    readonly dense: readonly CandidateRow[];
    readonly sparse: readonly CandidateRow[];
    readonly fused: readonly FusedCandidate[];
    readonly duplicatesCollapsed: number;
    readonly duplicateGroups: readonly {
      readonly keptId: string;
      readonly collapsedIds: readonly string[];
    }[];
    readonly finalChunkIds: readonly string[];
    readonly abstainReason: AbstainReason;
    readonly topFusedScore: number | null;
    readonly startedAtMs: number;
  }): RetrievalTrace {
    return {
      query: parts.query,
      normalisedQuery: parts.normalised.text,
      queryTruncated: parts.normalised.truncated,
      language: parts.normalised.language,
      filters: {
        grade: parts.filters.grade,
        subject: parts.filters.subject,
        topN: parts.topN,
      },
      denseCandidates: toCandidateScores(parts.dense),
      sparseCandidates: toCandidateScores(parts.sparse),
      fusedScores: parts.fused.map((candidate) => ({
        id: candidate.id,
        score: candidate.fusedScore,
      })),
      duplicatesCollapsed: parts.duplicatesCollapsed,
      duplicateGroups: parts.duplicateGroups,
      finalChunkIds: parts.finalChunkIds,
      abstained: parts.abstainReason !== null,
      abstainReason: parts.abstainReason,
      topFusedScore: parts.topFusedScore,
      confidence: confidenceFrom(parts.topFusedScore, RRF_K),
      thresholdValue: threshold.value,
      thresholdState: threshold.provenance.state,
      latencyMs: deps.clock.now().getTime() - parts.startedAtMs,
      embeddingModel: deps.embed.model,
    };
  }

  return {
    threshold,
    async search(query: string, filters: RetrievalFilters): Promise<RetrievalResult> {
      const startedAtMs = deps.clock.now().getTime();
      const topN = filters.topN ?? DEFAULT_TOP_N;

      if (!Number.isInteger(topN) || topN < 1) {
        throw new ValidationError('topN must be a positive integer.', {
          message: `retrieval.search: topN=${String(topN)}`,
        });
      }

      // ---- 1. Normalise ---------------------------------------------------
      const normalised = normaliseQuery(query);

      /**
       * AN EMPTY QUERY ABSTAINS RATHER THAN THROWING (§8.4's test list).
       *
       * And it abstains BEFORE the embedding call, which is the part that
       * matters operationally: whitespace is a real thing a chat box sends, and
       * paying a network round trip and a token charge to be told that the
       * empty string has no nearest neighbour is a cost with no information in
       * it.
       */
      if (normalised.isEmpty) {
        return abstainedResult(
          buildTrace({
            query,
            normalised,
            filters,
            topN,
            dense: [],
            sparse: [],
            fused: [],
            duplicatesCollapsed: 0,
            duplicateGroups: [],
            finalChunkIds: [],
            abstainReason: 'no-candidates',
            topFusedScore: null,
            startedAtMs,
          }),
        );
      }

      // ---- 2. Embed -------------------------------------------------------
      const queryVector = await embedOrFail(normalised.text);

      // ---- 3 & 4. Both halves, CONCURRENTLY ------------------------------
      //
      // Two independent reads on the same pool. Sequentially they cost the sum
      // of two latencies on a path a student is watching; concurrently they
      // cost the slower one. The `ai` pool's concurrency cap is what stops that
      // becoming a way to exhaust connections (§3.1).
      const filter = {
        grade: filters.grade,
        subject: filters.subject,
        limit: candidateLimit,
      };
      const [dense, sparse] = await Promise.all([
        deps.repository.searchDense(queryVector, filter),
        deps.repository.searchSparse(normalised.text, normalised.language, filter),
      ]);

      // ---- 5. Fuse --------------------------------------------------------
      const fused = fuse(
        dense.map((row) => row.id),
        sparse.map((row) => row.id),
        RRF_K,
      );

      // ---- 6. Deduplicate — AFTER fusion, BEFORE truncation ---------------
      //
      // The order is the decision. See the header of `domain/deduplicate.ts`:
      // a quarter of this corpus is exact-duplicate passages (D-108), and
      // truncating first would turn "the top three are the same paragraph"
      // into a single-chunk answer.
      const textById = new Map<string, string>();
      for (const row of [...dense, ...sparse]) {
        if (!textById.has(row.id)) textById.set(row.id, row.chunkText);
      }
      const deduplicated = deduplicateByText(
        fused.map((candidate) => ({
          id: candidate.id,
          chunkText: textById.get(candidate.id) ?? '',
          fusedScore: candidate.fusedScore,
        })),
      );

      // ---- 7. Take top N --------------------------------------------------
      const selected = deduplicated.kept.slice(0, topN);
      const topFusedScore = deduplicated.kept[0]?.fusedScore ?? null;

      // ---- 8. Abstain -----------------------------------------------------
      const abstainReason = decideAbstention(topFusedScore, threshold);

      const traceOf = (finalChunkIds: readonly string[]): RetrievalTrace =>
        buildTrace({
          query,
          normalised,
          filters,
          topN,
          dense,
          sparse,
          fused,
          duplicatesCollapsed: deduplicated.duplicatesCollapsed,
          duplicateGroups: deduplicated.groups.map((group) => ({
            keptId: group.keptId,
            collapsedIds: group.collapsedIds,
          })),
          finalChunkIds,
          abstainReason,
          topFusedScore,
          startedAtMs,
        });

      if (abstainReason !== null) {
        // NO HYDRATION ON THE ABSTAIN PATH. An abstaining turn returns no
        // chunks, so fetching their bodies is a query whose result is thrown
        // away — and `foxy` must not be able to quote from a turn that abstained.
        return abstainedResult(traceOf([]));
      }

      // ---- Hydration, then RE-RANK (D-060) --------------------------------
      //
      // `getChunksByIds` uses `IN (...)`, so the rows come back in whatever
      // order the plan produced — NOT the order they were asked for. Trusting
      // that order would scramble the ranking while still returning perfectly
      // valid chunks: nothing errors, the answer looks plausible, and the best
      // passage is quietly no longer first. The ranking is re-applied from
      // `selected`, which is the only place it exists.
      const hydrated = await deps.readChunks(selected.map((candidate) => candidate.id));
      const byId = new Map(hydrated.map((chunk) => [chunk.id, chunk]));

      const chunks: RetrievedChunk[] = [];
      for (const candidate of selected) {
        const record = byId.get(candidate.id);
        // A ranked id that hydrates to nothing is a chunk deactivated between
        // the search and the read. Dropped, not faked — and the trace still
        // records it as a final id, so "3 ranked, 2 returned" is visible rather
        // than being a mystery about the corpus.
        if (record === undefined) continue;
        chunks.push({ ...record, score: candidate.fusedScore, rank: chunks.length + 1 });
      }

      return {
        chunks,
        scores: chunks.map((chunk) => chunk.score),
        shouldAbstain: false,
        confidence: confidenceFrom(topFusedScore, RRF_K),
        trace: traceOf(selected.map((candidate) => candidate.id)),
      };
    },
  };

  function abstainedResult(trace: RetrievalTrace): RetrievalResult {
    deps.logger.debug(
      {
        abstainReason: trace.abstainReason,
        topFusedScore: trace.topFusedScore,
        thresholdState: trace.thresholdState,
        grade: trace.filters.grade,
        subject: trace.filters.subject,
      },
      'retrieval abstained',
    );
    return { chunks: [], scores: [], shouldAbstain: true, confidence: trace.confidence, trace };
  }

  /**
   * §8.4: "an embedding failure raises `DependencyError` rather than returning
   * silent garbage".
   *
   * The wrapping matters. `platform/embed`'s guard already throws
   * `DependencyError` for a timeout or an open breaker, but an ADAPTER can
   * throw anything — a `TypeError` from a malformed response, a raw fetch
   * error. Letting those through would surface as a 500 from `foxy` and be
   * investigated as a bug in `foxy`. Everything that is not already an
   * `AppError` becomes a `DependencyError` naming `embed`, so the failure is
   * attributed to the dependency that actually failed.
   *
   * A ZERO-LENGTH or WRONG-WIDTH vector is also a failure here, not a value.
   * The alternative is `[0,0,…]` reaching pgvector, where every cosine distance
   * is identical and the "nearest" fifty chunks are an arbitrary fifty — the
   * exact silent garbage the rule names.
   */
  async function embedOrFail(text: string): Promise<number[]> {
    let vector: number[];
    try {
      vector = await deps.embed.embedQuery(text);
    } catch (cause) {
      if (isAppError(cause) && cause instanceof DependencyError) throw cause;
      throw new DependencyError('embed', {
        message: 'The embedding provider failed; retrieval cannot run the dense half',
        cause,
      });
    }

    if (vector.length !== deps.embed.dimensions) {
      throw new DependencyError('embed', {
        message:
          `The embedding provider returned ${String(vector.length)} dimensions, ` +
          `not ${String(deps.embed.dimensions)}. A query in a different vector space ` +
          'produces confident nonsense, so it is refused.',
        details: { got: vector.length, expected: deps.embed.dimensions },
      });
    }

    return vector;
  }
}
