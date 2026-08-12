import type { Grade, LanguageCode } from '@/shared/constants/curriculum';
import type { AbstainReason } from './domain/abstain-threshold';

/**
 * Internal types for `retrieval`, plus the SHAPE OF ITS ONE INJECTED
 * DEPENDENCY.
 *
 * ===========================================================================
 * ONE EDGE, AND IT IS INJECTED.
 *
 * `retrieval` needs to hydrate the chunks it has ranked, which is
 * `content.getChunksByIds`. It does not import `content`: the function type is
 * declared here and supplied in `app/routes.ts`, so that file stays the
 * complete cross-module dependency graph (D-051).
 *
 * The dependency is NOT the whole `content` service, deliberately. A module
 * handed a service acquires every method on it, including
 * `getHeldOutQuestionsForChapter` — and the held-out reserve is a one-way door
 * that nothing outside the mastery check may reach. One function is one edge.
 */

export interface RetrievalFilters {
  /** A STRING, "6".."12". Never a number. */
  readonly grade: Grade;
  /** Canonical, from `shared/constants/curriculum` — `mathematics` or `science`. */
  readonly subject: string;
  /**
   * How many chunks the caller wants. Defaults to 3 (§8.4 step 7).
   *
   * A PARAMETER, not a knob a route exposes: `foxy` passes the constant. It
   * exists so the eval harness can ask for more without a second code path —
   * which is the §8.4 rule stated as a mechanism ("configuration changes
   * parameters, never which code runs").
   */
  readonly topN?: number;
}

/** A chunk as `content` hands it back. Text and citation fields; no vectors. */
export interface RetrievedChunkRecord {
  readonly id: string;
  readonly chapterId: string | null;
  readonly chunkText: string;
  readonly chunkIndex: number;
  readonly grade: Grade;
  readonly subject: string;
  readonly chapterNumber: number | null;
  readonly chapterTitle: string | null;
  readonly topic: string | null;
  readonly concept: string | null;
  readonly language: string;
  readonly qualityScore: number | null;
}

/** A hydrated chunk with the ranking that put it there. */
export interface RetrievedChunk extends RetrievedChunkRecord {
  /** Its fused RRF score. See `domain/reciprocal-rank-fusion.ts` for the scale. */
  readonly score: number;
  /** 1-based, in the FINAL order. Not the order `getChunksByIds` returned. */
  readonly rank: number;
}

/**
 * THE INJECTED EDGE. Bound to `content.getChunksByIds` in `app/routes.ts`.
 *
 * D-060: THE RETURNED ORDER IS ARBITRARY. The query is an `IN (...)`, so rows
 * come back in whatever order the plan produced. Retrieval re-applies its own
 * ranking after hydration; relying on this order would scramble the ranking
 * while still returning plausible-looking chunks, which is the worst kind of
 * failure — nothing errors and the answer is subtly worse forever.
 */
export type ChunkReader = (ids: readonly string[]) => Promise<readonly RetrievedChunkRecord[]>;

/** One half's view of a candidate, before fusion. */
export interface CandidateScore {
  readonly id: string;
  /**
   * The raw score from that half, recorded verbatim.
   *
   * NOT normalised and NOT comparable across halves — cosine distance (lower is
   * better) against `ts_rank` (higher is better). It is in the trace precisely
   * so a human can see the two raw scales that fusion deliberately discards.
   */
  readonly score: number;
  readonly rank: number;
}

/**
 * THE TRACE — §8.4's "the only way a bad answer will ever be debugged".
 *
 * Every field here answers a question somebody will ask at 2am about a specific
 * bad answer:
 *
 *   query / normalisedQuery   did we mangle it before embedding it?
 *   filters                   was it even looking in the right grade?
 *   denseCandidates           did the vector half find anything?
 *   sparseCandidates          did the keyword half? (this half needs no
 *                             embedding, so it still works when the other is
 *                             down)
 *   fusedScores               did fusion put the right thing on top?
 *   duplicatesCollapsed       did a quarter-duplicated corpus eat the slots?
 *   finalChunkIds             what did the model actually see?
 *   abstained / reason        did we refuse, and was it "found nothing" or
 *                             "found weak things"?
 *   thresholdProvenance       was that refusal based on a MEASUREMENT or on a
 *                             value nobody has calibrated?
 *   latencyMs / embeddingModel
 *
 * NO STUDENT IDENTIFIER APPEARS HERE. The trace carries the QUESTION, which is
 * enough to reproduce the retrieval, and nothing that says who asked it. A
 * trace is written for every turn and kept for debugging; making it a second
 * copy of the student's activity log is how a debugging aid becomes a privacy
 * incident.
 */
export interface RetrievalTrace {
  readonly query: string;
  readonly normalisedQuery: string;
  readonly queryTruncated: boolean;
  readonly language: LanguageCode;
  readonly filters: {
    readonly grade: Grade;
    readonly subject: string;
    readonly topN: number;
  };
  readonly denseCandidates: readonly CandidateScore[];
  readonly sparseCandidates: readonly CandidateScore[];
  readonly fusedScores: readonly { readonly id: string; readonly score: number }[];
  readonly duplicatesCollapsed: number;
  readonly duplicateGroups: readonly {
    readonly keptId: string;
    readonly collapsedIds: readonly string[];
  }[];
  readonly finalChunkIds: readonly string[];
  readonly abstained: boolean;
  readonly abstainReason: AbstainReason;
  readonly topFusedScore: number | null;
  readonly confidence: number;
  readonly thresholdValue: number;
  readonly thresholdState: 'UNCALIBRATED' | 'MEASURED';
  readonly latencyMs: number;
  readonly embeddingModel: string;
}

export interface RetrievalResult {
  /** Top N, deduplicated, IN FUSED ORDER. Empty when abstaining. */
  readonly chunks: readonly RetrievedChunk[];
  /** Fused scores, aligned with `chunks` by index. */
  readonly scores: readonly number[];
  readonly shouldAbstain: boolean;
  /** [0, 1]. NOT a probability — see `confidenceFrom`. */
  readonly confidence: number;
  readonly trace: RetrievalTrace;
}
