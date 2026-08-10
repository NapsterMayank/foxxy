import { assertThresholdOnFusedScale, type AbstainThreshold } from './abstain-threshold';

/**
 * THE CALIBRATION ARITHMETIC — pure, so it can be tested today against numbers
 * a machine with no API key can produce.
 *
 * =============================================================================
 * THE SPLIT, AND WHY IT IS HERE RATHER THAN IN `eval/`.
 *
 * Calibration has two halves. One half needs the world: 70 real questions, real
 * query embeddings, the real corpus. That half is `eval/retrieval/calibrate.ts`
 * and it cannot run without `VOYAGE_API_KEY`.
 *
 * The other half is arithmetic on two lists of numbers — percentiles, overlap,
 * where to put the line, and how many mistakes that line makes in each
 * direction. That half needs nothing, so it lives in `domain/`, is unit tested,
 * and is under the 95% coverage floor. The consequence that matters: on the day
 * the key arrives, the only untested code between the questions and the
 * threshold is the part that makes HTTP calls.
 *
 * =============================================================================
 * WHERE THE LINE GOES, AND WHY IT IS NOT THE MIDPOINT.
 *
 * §8.4 says "place the threshold between them". Between WHERE, exactly, is the
 * decision, and the two distributions overlap in practice.
 *
 * The midpoint of the two MEANS is the obvious choice and it is wrong: a mean
 * is dragged by the tail, and the tail is where the interesting questions are.
 *
 * The rule here is the midpoint of the in-corpus 5th PERCENTILE and the
 * off-syllabus 95th percentile — the two edges that actually face each other.
 * When they are cleanly separated (p5 > p95) the line sits in the gap. When
 * they overlap (p5 <= p95, which is the likely case for a hybrid retriever over
 * a corpus that contains something vaguely related to almost any question), the
 * midpoint still lands where the two are equally wrong, and the returned
 * report SAYS THEY OVERLAP with both error rates attached, so nobody can adopt
 * the number without seeing what it costs.
 *
 * ASYMMETRY IS DELIBERATE AND STATED. A false abstention is a student told
 * "I do not know" about something the corpus covers. A false acceptance is a
 * weak passage that Foxy's own grounding and citation verification still has to
 * survive. The first is worse, so the report is built to make a high
 * `inCorpusFalseAbstainRate` impossible to miss.
 */

export interface ScoreSample {
  /** The question, verbatim, so a bad sample can be found and fixed. */
  readonly query: string;
  /** The FUSED top score. The only scale a threshold may live on. */
  readonly topFusedScore: number | null;
}

export interface CalibrationInput {
  /** §8.4: 50 questions the corpus is known to answer. */
  readonly inCorpus: readonly ScoreSample[];
  /** §8.4: 20 questions it deliberately cannot. */
  readonly offSyllabus: readonly ScoreSample[];
}

export interface Distribution {
  readonly count: number;
  readonly min: number;
  readonly p5: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

export interface CalibrationReport {
  readonly inCorpus: Distribution;
  readonly offSyllabus: Distribution;
  /** The suggested value. Still has to be adopted by hand — see the header. */
  readonly suggestedThreshold: number;
  /** True when the two distributions do not overlap at the 5/95 edges. */
  readonly separated: boolean;
  /** Off-syllabus questions the suggested value correctly abstains on. */
  readonly offSyllabusAbstainRate: number;
  /** In-corpus questions it WRONGLY abstains on. The expensive mistake. */
  readonly inCorpusFalseAbstainRate: number;
}

/**
 * A score of `null` — no candidates at all — is scored as ZERO rather than
 * dropped.
 *
 * Dropping it would quietly remove the clearest evidence in the sample: an
 * off-syllabus question that returns nothing is the strongest possible signal
 * that abstention is right, and an in-corpus question that returns nothing is a
 * CONTENT gap that the person reading this report needs to see. A distribution
 * computed over "only the questions that returned something" describes a
 * corpus nobody is querying.
 */
function toScores(samples: readonly ScoreSample[]): number[] {
  return samples.map((sample) => sample.topFusedScore ?? 0).sort((a, b) => a - b);
}

/**
 * The NEAREST-RANK percentile, not an interpolating one.
 *
 * At n = 20 the interpolating definition invents values that no question
 * produced, and the whole point of this exercise is to place a line relative to
 * observations. Nearest-rank returns a number some question actually scored.
 */
export function percentile(sortedAscending: readonly number[], fraction: number): number {
  if (sortedAscending.length === 0) return 0;
  const index = Math.min(
    sortedAscending.length - 1,
    Math.max(0, Math.ceil(fraction * sortedAscending.length) - 1),
  );
  return sortedAscending[index] ?? 0;
}

export function describeDistribution(samples: readonly ScoreSample[]): Distribution {
  const scores = toScores(samples);
  if (scores.length === 0) {
    return { count: 0, min: 0, p5: 0, median: 0, p95: 0, max: 0, mean: 0 };
  }
  const sum = scores.reduce((total, value) => total + value, 0);
  return {
    count: scores.length,
    min: scores[0] ?? 0,
    p5: percentile(scores, 0.05),
    median: percentile(scores, 0.5),
    p95: percentile(scores, 0.95),
    max: scores[scores.length - 1] ?? 0,
    mean: sum / scores.length,
  };
}

/** The rate at which a threshold abstains over a sample. */
function abstainRate(samples: readonly ScoreSample[], threshold: number): number {
  if (samples.length === 0) return 0;
  const abstained = samples.filter(
    (sample) => sample.topFusedScore === null || sample.topFusedScore < threshold,
  ).length;
  return abstained / samples.length;
}

/**
 * Where §8.4's line goes. See the header for why it is the 5/95 midpoint.
 *
 * Clamped to zero at the bottom: a negative threshold is not a stricter policy,
 * it is a nonsensical one, and it would slip past `assertThresholdOnFusedScale`
 * only by being caught there instead — which is a worse place to notice it.
 */
export function suggestThreshold(input: CalibrationInput): number {
  const inCorpus = describeDistribution(input.inCorpus);
  const offSyllabus = describeDistribution(input.offSyllabus);
  return Math.max(0, (inCorpus.p5 + offSyllabus.p95) / 2);
}

export function calibrate(input: CalibrationInput): CalibrationReport {
  const inCorpus = describeDistribution(input.inCorpus);
  const offSyllabus = describeDistribution(input.offSyllabus);
  const suggestedThreshold = suggestThreshold(input);

  return {
    inCorpus,
    offSyllabus,
    suggestedThreshold,
    separated: inCorpus.p5 > offSyllabus.p95,
    offSyllabusAbstainRate: abstainRate(input.offSyllabus, suggestedThreshold),
    inCorpusFalseAbstainRate: abstainRate(input.inCorpus, suggestedThreshold),
  };
}

/**
 * Turns a report into the `MEASURED` provenance the shipped constant needs.
 *
 * THIS IS THE ONLY SANCTIONED WAY TO PRODUCE A MEASURED THRESHOLD, and it is
 * why the union in `abstain-threshold.ts` has required fields: a hand-written
 * `MEASURED` block is a claim, while one built here is a transcription of a run
 * that happened. The value is validated against the fused scale on the way out,
 * so a report computed on the wrong scale cannot become a shipped constant.
 */
export function toMeasuredThreshold(
  report: CalibrationReport,
  context: {
    readonly measuredAt: string;
    readonly corpusChunkCount: number;
    readonly embeddingModel: string;
  },
): AbstainThreshold {
  assertThresholdOnFusedScale(report.suggestedThreshold);

  return {
    value: report.suggestedThreshold,
    provenance: {
      state: 'MEASURED',
      measuredAt: context.measuredAt,
      inCorpusSampleSize: report.inCorpus.count,
      offSyllabusSampleSize: report.offSyllabus.count,
      inCorpusP5: report.inCorpus.p5,
      offSyllabusP95: report.offSyllabus.p95,
      offSyllabusAbstainRate: report.offSyllabusAbstainRate,
      inCorpusFalseAbstainRate: report.inCorpusFalseAbstainRate,
      corpusChunkCount: context.corpusChunkCount,
      embeddingModel: context.embeddingModel,
    },
  };
}
