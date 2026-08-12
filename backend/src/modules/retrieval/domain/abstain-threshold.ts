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
 * HALF THREE, WHICH THE ORIGINAL TWO DID NOT COVER — A FLOOR THAT CANNOT FIRE.
 * The value shipped until 10 August 2026 was `minFusedScore(CANDIDATE_LIMIT)`,
 * the LOWEST score a document can earn, compared with a strict `<`. The worst
 * achievable fused score is exactly that value, so `below-threshold` was
 * unreachable — not "inert pending measurement", UNREACHABLE — and the only
 * abstention the pipeline could ever produce was `no-candidates`. The test that
 * claimed to pin this compared the constant against the expression that defined
 * it, so it would have held for any value at all. Both are fixed below: the
 * threshold is MEASURED, and the tests assert against literals and against
 * observed distributions rather than against the definition.
 *
 * =============================================================================
 * THE MEASUREMENT — 10 August 2026. `npm run eval:retrieval:calibrate`.
 *
 * Corpus: 4,403 active chunks (4,686 imported, 283 inactive), 20 of the active
 * ones with a NULL embedding. Embeddings: voyage-3, 1024 dimensions — the same
 * model and width the corpus was built with. Candidate depth: 50 per half.
 * Fusion: RRF, k = 60. 54 in-corpus questions (`golden/in-corpus.ts`), 20
 * deliberately off-syllabus (`golden/off-syllabus.ts`), every one scored end to
 * end through the shipped service.
 *
 *   FUSED TOP SCORE          n     min       p5        median    p95       max
 *   in-corpus               54   0.028850  0.029877  0.032018  0.032787  0.032787
 *   off-syllabus            20   0.024448  0.024448  0.030622  0.032522  0.032522
 *
 *   in-corpus questions returning NO candidates:  0 of 54  (0.0%)
 *
 * THE TWO DISTRIBUTIONS OVERLAP, and that is the honest headline. `separated`
 * is false: in-corpus p5 (0.029877) sits BELOW off-syllabus p95 (0.032522).
 *
 * WHERE THE LINE WENT, AND WHY NOT WHERE `suggestThreshold` PUT IT.
 * `domain/calibration.ts`'s original rule is the 5/95 midpoint, which weights
 * the two errors equally. On this data it lands at 0.031200 and costs:
 *
 *     off-syllabus correctly refused      55.0%
 *     IN-CORPUS WRONGLY REFUSED           24.1%   <-- one student in four
 *
 * The file's own header states the asymmetry — a false abstention is a student
 * told "I do not know" about material the corpus covers; a false acceptance is
 * a weak passage Foxy's grounding and citation verification already has to
 * survive. 24.1% is not a price that argument permits. So the adopted value
 * comes from `suggestThresholdWithinFalseAbstainBudget` at a stated 5% budget:
 *
 *     value                               0.029877369007803793
 *     off-syllabus correctly refused      35.0%   (7 of 20)
 *     IN-CORPUS WRONGLY REFUSED            3.7%   (2 of 54)
 *
 * WHAT THIS THRESHOLD IS AND IS NOT. It is a real floor — 7 of the 20
 * off-syllabus questions now abstain where, before 10 August 2026, ZERO could.
 * It is NOT a relevance detector, and the overlap above is why. The fused top
 * score is dominated by whether ANY document is ranked highly by both halves,
 * and both halves return 50 rows for any input a student can type, so a
 * question about the Krebs cycle asked of grade 10 science still produces
 * agreement between two retrievers about which of the wrong chunks is least
 * wrong. Off-syllabus rejection is therefore a SHARED responsibility: this
 * threshold catches a third of it, and `foxy`'s grounding and citation
 * verification owns the rest. Anyone tempted to raise this number to improve
 * that third should read the 24.1% above first.
 *
 * FOR CONTEXT — WHAT THE SAME MEASUREMENT WOULD HAVE PRODUCED THE DAY BEFORE.
 * The sparse half ANDed every query term (see `retrieval.repository.ts`), so it
 * returned zero rows for 20 of 20 off-syllabus questions and 24 of 54 in-corpus
 * ones. A dense-only turn scores exactly 1/(60+1) = 0.016393, so both
 * distributions would have been pinned to that value at their fifth and
 * ninety-fifth percentiles alike: any rule places the line AT 0.016393, and a
 * threshold equal to the only score present abstains on nothing. The floor
 * would have measured as fully inert while looking calibrated. Fixing the
 * retriever is what made a threshold measurable at all.
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
/**
 * HOW THE LINE WAS PLACED between the two measured distributions.
 *
 * Recorded because the distributions overlap, and when they overlap the
 * placement rule IS the policy — the same pair of distributions yields 0.0312
 * under one rule and 0.0299 under the other, with in-corpus false-abstention of
 * 24.1% and 3.7% respectively. A threshold that records its percentiles but not
 * its placement rule looks fully evidenced and is missing the only part that
 * was a decision.
 */
export type ThresholdPolicy = 'five-ninetyfive-midpoint' | 'in-corpus-false-abstain-budget';

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
      /**
       * Zero-candidate rate on the in-corpus set at measurement time.
       *
       * Recorded because it is the number that moves when the RETRIEVER
       * changes rather than when the threshold does, and the two are otherwise
       * indistinguishable in hindsight: a run where 44% of in-corpus questions
       * returned nothing produces a very different in-corpus distribution from
       * one where 0% did, and without this field a later reader cannot tell
       * which corpus-facing reality the percentiles below describe.
       */
      readonly inCorpusNoCandidateRate: number;
      /** Which placement rule produced `value`. See `ThresholdPolicy`. */
      readonly policy: ThresholdPolicy;
      /**
       * The in-corpus false-abstention budget, when the policy is the budgeted
       * one. `null` for the midpoint rule, which spends no stated budget.
       */
      readonly falseAbstainBudget: number | null;
      /** Which corpus the measurement was taken against — the numbers move with it. */
      readonly corpusChunkCount: number;
      /** The embedding model. A different model is a different distribution. */
      readonly embeddingModel: string;
    };

export interface AbstainThreshold {
  /** Compared against the FUSED top score. Nothing else is on this scale. */
  readonly value: number;
  /**
   * ==========================================================================
   * THE CANDIDATE DEPTH THIS VALUE IS VALID AT, AND WHY IT IS PART OF THE
   * VALUE RATHER THAN A CONSTANT SOMEBODY LOOKS UP.
   *
   * A fused score is `1/(k + rank)` summed over the lists a document appears
   * in, so THE BOTTOM OF THE SCALE MOVES WITH THE CANDIDATE LIMIT: at 50 the
   * least a document can score is 1/110, at 100 it is 1/160. The shipped
   * threshold used to be baked from `CANDIDATE_LIMIT = 50` while
   * `retrieval.service.ts` read `deps.candidateLimit ?? CANDIDATE_LIMIT` — so
   * anyone raising the limit to 100 through the SUPPORTED override moved fifty
   * new candidates below a floor that was described, in this file, as
   * incapable of filtering anything. Silently. Which is the exact failure §8.4
   * records, reintroduced through the knob provided to avoid a second code
   * path.
   *
   * Carrying the depth ON the threshold makes the mismatch a startup error
   * (`assertThresholdMatchesCandidateDepth`, called by the service) instead of
   * a quiet change in what students are told. It also makes the measured
   * percentiles honest: they were observed at ONE depth and describe no other.
   * ==========================================================================
   */
  readonly candidateLimit: number;
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
export function assertThresholdOnFusedScale(
  value: number,
  candidateLimit: number = CANDIDATE_LIMIT,
): void {
  const ceiling = maxFusedScore(RRF_K);
  if (!Number.isFinite(value) || value < 0 || value > ceiling) {
    throw new RangeError(
      `Abstention threshold ${String(value)} is not on the fused RRF scale. ` +
        `A fused score lies in [${String(minFusedScore(candidateLimit, RRF_K))}, ` +
        `${String(ceiling)}]; a value above the ceiling abstains on every query, ` +
        'which is indistinguishable from an empty corpus. This is the exact ' +
        'defect §8.4 records: a floor written on the wrong scale.',
    );
  }
}

/**
 * =============================================================================
 * THE SECOND GUARD, AND THE REASON THE FIRST ONE WAS NOT ENOUGH.
 *
 * `assertThresholdOnFusedScale` existed to make the year-long silent filter
 * impossible, and it did — for the shipped constant, which is the one value
 * that was never in danger. It was NEVER CALLED on `deps.threshold`.
 * `retrieval.service.ts` read `deps.threshold ?? ABSTAIN_THRESHOLD` and used
 * whatever it got, so the supported override path reproduced the exact
 * historical defect straight past the guard built to prevent it: an eval sweep
 * or a caller passing `{ value: 0.7 }` got a floor nothing can clear and a
 * pipeline that abstains on everything, with no error and a trace that reports
 * the threshold as if it were fine.
 *
 * Both guards now run in the service's constructor, on the threshold the
 * service will actually use, before a single query can be issued. A bad value
 * is a boot failure rather than a silent behaviour change.
 * =============================================================================
 *
 * The depth check is not a tidiness rule either. The threshold's percentiles
 * were measured against fused scores produced at ONE candidate depth. Run the
 * same threshold at a deeper one and the new ranks 51..100 arrive with scores
 * below anything in the measured distribution — they are dropped, the measured
 * `inCorpusFalseAbstainRate` stops describing the running system, and nothing
 * says so.
 */
export function assertThresholdMatchesCandidateDepth(
  threshold: AbstainThreshold,
  candidateLimit: number,
): void {
  if (threshold.candidateLimit === candidateLimit) return;
  throw new RangeError(
    `Abstention threshold ${String(threshold.value)} is valid at a candidate depth ` +
      `of ${String(threshold.candidateLimit)}, but retrieval is configured for ` +
      `${String(candidateLimit)}. The bottom of the fused scale moves with the depth ` +
      `(1/(${String(RRF_K)}+depth)), so reusing the value silently changes which ` +
      'candidates are filtered and invalidates the measured error rates. Re-run ' +
      '`npm run eval:retrieval:calibrate` at the new depth, or pass a threshold ' +
      'measured for it.',
  );
}

/**
 * THE SHIPPED THRESHOLD. **MEASURED, 10 August 2026.**
 *
 * ---------------------------------------------------------------------------
 * Every number below is transcribed from one run of
 * `npm run eval:retrieval:calibrate` against the development corpus. The two
 * distributions, the overlap, the placement rule and what it costs are written
 * out in full in this file's header — read that before changing this value.
 *
 * The literal is spelled out rather than recomputed from
 * `minFusedScore(...)` ON PURPOSE. It is an OBSERVATION, and an observation
 * that is secretly an expression changes when the expression's inputs change,
 * silently, which is how the previous value came to be simultaneously "the
 * shipped threshold" and "whatever `CANDIDATE_LIMIT` happens to be today".
 *
 * TO RE-CALIBRATE — the procedure, not a description of one:
 *   1. `npm run eval:retrieval:calibrate` (54 in-corpus questions from
 *      `eval/retrieval/golden/in-corpus.ts`, 20 from `off-syllabus.ts`).
 *   2. The harness prints BOTH placement rules with both error rates each, and
 *      the `MEASURED` block for the one it adopts.
 *   3. Paste the block here and rewrite the measurement in the header. The
 *      compiler will not let you fill the provenance in halfway; nothing but
 *      discipline makes you update the prose, which is why the prose is the
 *      part reviewers should check.
 *   4. Anything that changes the RETRIEVER — the sparse query, the ranking
 *      function, `RRF_K`, `CANDIDATE_LIMIT`, the embedding model — invalidates
 *      this measurement completely. It is not an adjustment; it is a re-run.
 * ---------------------------------------------------------------------------
 */
export const ABSTAIN_THRESHOLD: AbstainThreshold = Object.freeze({
  value: 0.029877369007803793,
  candidateLimit: CANDIDATE_LIMIT,
  provenance: Object.freeze({
    state: 'MEASURED',
    measuredAt: '2026-08-10',
    inCorpusSampleSize: 54,
    offSyllabusSampleSize: 20,
    inCorpusP5: 0.029877369007803793,
    offSyllabusP95: 0.03252247488101534,
    offSyllabusAbstainRate: 0.35,
    inCorpusFalseAbstainRate: 0.037037037037037035,
    inCorpusNoCandidateRate: 0,
    policy: 'in-corpus-false-abstain-budget',
    falseAbstainBudget: 0.05,
    corpusChunkCount: 4403,
    embeddingModel: 'voyage-3',
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
