import { RRF_K, maxFusedScore, minFusedScore } from './reciprocal-rank-fusion';

/**
 * =============================================================================
 * THE ABSTENTION THRESHOLD — STEP 8, AND THE ONE THING §8.4 SAYS TWICE.
 * =============================================================================
 *
 * "The threshold is measured, never guessed. The previous system guessed a
 *  value and silently filtered out every result for a year without anyone
 *  noticing."
 *
 * That failure had two halves and both are guarded here.
 *
 * HALF ONE — THE WRONG SCALE. The guessed floor was a cosine-similarity number
 * (order 0.7) applied to FUSED RRF scores, which are bounded above by
 * `2 / (k + 1)` ≈ 0.0328. Nothing could ever clear it, so every query
 * abstained, and abstaining is indistinguishable from "the corpus does not
 * cover this". `assertThresholdOnFusedScale` below refuses any value outside
 * the achievable window, DERIVED from the fusion constants rather than
 * restated, so raising the candidate limit cannot leave the check policing an
 * old range.
 *
 * HALF TWO — A GUESS THAT LOOKED LIKE A MEASUREMENT. Once a bare number is in
 * the source there is nothing to tell a reader whether it came from 70 scored
 * questions or from somebody's intuition on a Friday. So the threshold is not
 * a number. It is a value carrying its PROVENANCE, and the provenance is a
 * discriminated union: flipping it to `'MEASURED'` without supplying the sample
 * sizes, the two distributions' overlap point and the run that produced them is
 * a COMPILE ERROR, not an omission somebody might notice in review.
 *
 * =============================================================================
 * WHY IT SHIPS UNCALIBRATED TODAY, AND WHAT THAT COSTS.
 *
 * Calibration needs 50 in-corpus questions and 20 deliberately off-syllabus
 * ones SCORED THROUGH THE REAL PIPELINE. Scoring them needs query embeddings.
 * Embedding needs `VOYAGE_API_KEY`, which does not exist yet.
 *
 * The honest response is not to invent a plausible number — that is precisely
 * what was done last time. It is to ship a floor that CANNOT silently filter,
 * state that it is uncalibrated in the type system, and have the harness ready
 * to run the moment a key exists (`eval/retrieval/`, and
 * `domain/calibration.ts` for the arithmetic).
 *
 * The value below is `minFusedScore(...)`: the lowest score a document can
 * possibly earn by appearing at the very bottom of exactly one list. Every real
 * candidate scores at or above it, so score-based abstention is INERT until a
 * measurement replaces it — and retrieval still abstains when there is nothing
 * to return at all, which is the branch that protects a student today.
 *
 * That is deliberately the safe direction. An uncalibrated floor that is too
 * LOW returns weak evidence, which Foxy's own grounding and citation-
 * verification then have to handle — visible, recoverable, and reported in the
 * trace. An uncalibrated floor that is too HIGH returns nothing, forever,
 * silently, and reads as missing content. Those are not symmetric mistakes.
 * =============================================================================
 */

/** The candidate depth each half retrieves. §8.4 steps 3 and 4: top 50. */
export const CANDIDATE_LIMIT = 50;

/** §8.4 step 7: "N is 3 at launch, not 8". */
export const DEFAULT_TOP_N = 3;

/**
 * How a threshold value came to exist.
 *
 * `'MEASURED'` carries the evidence AS REQUIRED FIELDS. There is no way to
 * claim a measurement without stating what was measured — see the header.
 */
export type ThresholdProvenance =
  | {
      readonly state: 'UNCALIBRATED';
      /** Why there is no measurement yet, in words, for whoever reads this next. */
      readonly reason: string;
    }
  | {
      readonly state: 'MEASURED';
      /** ISO date the harness run happened. */
      readonly measuredAt: string;
      /** §8.4: 50 known-good questions. */
      readonly inCorpusSampleSize: number;
      /** §8.4: 20 deliberately off-syllabus questions. */
      readonly offSyllabusSampleSize: number;
      /** The 5th percentile of the in-corpus distribution. */
      readonly inCorpusP5: number;
      /** The 95th percentile of the off-syllabus distribution. */
      readonly offSyllabusP95: number;
      /** Share of off-syllabus questions this value correctly abstains on. */
      readonly offSyllabusAbstainRate: number;
      /** Share of in-corpus questions this value wrongly abstains on. */
      readonly inCorpusFalseAbstainRate: number;
      /** Which corpus the measurement was taken against — the numbers move with it. */
      readonly corpusChunkCount: number;
      /** The embedding model. A different model is a different distribution. */
      readonly embeddingModel: string;
    };

export interface AbstainThreshold {
  /** Compared against the FUSED top score. Nothing else is on this scale. */
  readonly value: number;
  readonly provenance: ThresholdProvenance;
}

/**
 * Refuses a threshold that cannot be on the fused scale.
 *
 * The bounds are computed from `RRF_K` and `CANDIDATE_LIMIT`, so they move when
 * those move. A hardcoded pair of numbers here would be a second source of
 * truth about the fusion arithmetic — and second sources of truth drift, which
 * is how a floor ends up policing a range that no longer exists.
 *
 * Zero is allowed: "never abstain on score" is a legitimate, statable position.
 * Anything above the best achievable score is not, because it abstains on
 * everything, always — the exact year-long failure §8.4 describes.
 */
export function assertThresholdOnFusedScale(value: number): void {
  const ceiling = maxFusedScore(RRF_K);
  if (!Number.isFinite(value) || value < 0 || value > ceiling) {
    throw new RangeError(
      `Abstention threshold ${String(value)} is not on the fused RRF scale. ` +
        `A fused score lies in [${String(minFusedScore(CANDIDATE_LIMIT, RRF_K))}, ` +
        `${String(ceiling)}]; a value above the ceiling abstains on every query, ` +
        'which is indistinguishable from an empty corpus. This is the exact ' +
        'defect §8.4 records: a floor written on the wrong scale.',
    );
  }
}

/**
 * THE SHIPPED THRESHOLD. **UNCALIBRATED.**
 *
 * ---------------------------------------------------------------------------
 * MEASUREMENT: NONE. There is no `VOYAGE_API_KEY`, so no query can be embedded,
 * so neither distribution has been observed. This constant has NOT been
 * measured and must not be read as if it had been.
 *
 * TO CALIBRATE IT — the procedure, not a description of one:
 *   1. Set `VOYAGE_API_KEY`.
 *   2. `npm run eval:retrieval:calibrate`
 *      (50 in-corpus questions from `eval/retrieval/golden/in-corpus.json`,
 *       20 off-syllabus from `off-syllabus.json`).
 *   3. The harness prints both distributions and a suggested threshold from
 *      `suggestThreshold()` in `domain/calibration.ts`.
 *   4. Replace `provenance` below with the `MEASURED` variant, filling in
 *      every field from the run. The compiler will not let you do it halfway.
 *   5. WRITE THE MEASUREMENT INTO THIS COMMENT — the two distributions, the
 *      separation, and the date. A future reader must be able to see the
 *      evidence without re-running anything.
 * ---------------------------------------------------------------------------
 */
export const ABSTAIN_THRESHOLD: AbstainThreshold = Object.freeze({
  value: minFusedScore(CANDIDATE_LIMIT, RRF_K),
  provenance: Object.freeze({
    state: 'UNCALIBRATED',
    reason:
      'No VOYAGE_API_KEY exists, so no query can be embedded and neither the ' +
      'in-corpus nor the off-syllabus score distribution has been observed. ' +
      'The value is the LOWEST achievable fused score — the floor is therefore ' +
      'inert and cannot silently filter, which is the failure mode §8.4 records. ' +
      'Run `npm run eval:retrieval:calibrate` the moment a key exists.',
  }),
});

/** True when the shipped threshold still carries no measurement. */
export function isUncalibrated(threshold: AbstainThreshold): boolean {
  return threshold.provenance.state === 'UNCALIBRATED';
}

/**
 * The abstention decision itself.
 *
 * TWO reasons, kept distinct in the return value because they mean different
 * things to whoever reads the trace: `no-candidates` is "the filters matched
 * nothing", which is a content or a filter problem, while `below-threshold` is
 * "we found things and judged them too weak", which is a ranking problem. A
 * single boolean would merge the two, and merging them is how a missing-content
 * incident gets investigated as a threshold bug.
 */
export type AbstainReason = 'no-candidates' | 'below-threshold' | null;

export function decideAbstention(
  topFusedScore: number | null,
  threshold: AbstainThreshold,
): AbstainReason {
  if (topFusedScore === null) return 'no-candidates';
  return topFusedScore < threshold.value ? 'below-threshold' : null;
}

/**
 * Confidence in [0, 1] — the fused top score as a fraction of the best score
 * any document could have earned.
 *
 * NOT A PROBABILITY, and the name is the only place that can say so. It is a
 * monotone rescaling of the fused score onto a range a caller can reason about
 * without knowing what RRF is. 1.0 means "ranked first by BOTH halves", which
 * is the strongest agreement the pipeline can express.
 */
export function confidenceFrom(topFusedScore: number | null, k: number = RRF_K): number {
  if (topFusedScore === null) return 0;
  const ratio = topFusedScore / maxFusedScore(k);
  return Math.min(1, Math.max(0, ratio));
}
