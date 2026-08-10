import { describe, expect, it } from 'vitest';
import {
  calibrate,
  describeDistribution,
  percentile,
  suggestThreshold,
  toMeasuredThreshold,
  type ScoreSample,
} from '../domain/calibration';

function samples(scores: readonly (number | null)[]): ScoreSample[] {
  return scores.map((topFusedScore, index) => ({
    query: `q${String(index)}`,
    topFusedScore,
  }));
}

describe('percentile', () => {
  it('uses NEAREST RANK, so it returns a value some question actually scored', () => {
    // Not the interpolating definition. At n = 20 interpolation invents values
    // nothing produced, and the whole exercise is placing a line relative to
    // observations.
    const sorted = [1, 2, 3, 4, 5];

    expect(percentile(sorted, 0.5)).toBe(3);
    expect(sorted).toContain(percentile(sorted, 0.05));
  });

  it('returns the first element at the very bottom', () => {
    expect(percentile([1, 2, 3], 0)).toBe(1);
  });

  it('returns the last element at the very top', () => {
    expect(percentile([1, 2, 3], 1)).toBe(3);
  });

  it('returns 0 for an empty sample rather than NaN', () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('describeDistribution', () => {
  it('summarises a sample end to end', () => {
    const distribution = describeDistribution(samples([0.01, 0.02, 0.03, 0.04]));

    expect(distribution.count).toBe(4);
    expect(distribution.min).toBeCloseTo(0.01, 12);
    expect(distribution.max).toBeCloseTo(0.04, 12);
    expect(distribution.mean).toBeCloseTo(0.025, 12);
  });

  it('scores a NULL — no candidates at all — as ZERO, never dropping it', () => {
    /**
     * Dropping it would remove the clearest evidence in the sample. An
     * off-syllabus question that returns nothing is the strongest possible
     * signal that abstention is right; an in-corpus one that returns nothing is
     * a CONTENT gap the reader needs to see. A distribution over "only the
     * questions that returned something" describes a corpus nobody is querying.
     */
    const distribution = describeDistribution(samples([null, 0.02]));

    expect(distribution.count).toBe(2);
    expect(distribution.min).toBe(0);
  });

  it('returns a zeroed summary for an empty sample rather than NaN', () => {
    expect(describeDistribution([])).toEqual({
      count: 0,
      min: 0,
      p5: 0,
      median: 0,
      p95: 0,
      max: 0,
      mean: 0,
    });
  });
});

describe('placing the threshold', () => {
  it('puts it in the GAP when the two distributions are cleanly separated', () => {
    const report = calibrate({
      inCorpus: samples([0.020, 0.021, 0.022, 0.023, 0.024]),
      offSyllabus: samples([0.010, 0.011, 0.012]),
    });

    expect(report.separated).toBe(true);
    expect(report.suggestedThreshold).toBeGreaterThan(report.offSyllabus.p95);
    expect(report.suggestedThreshold).toBeLessThan(report.inCorpus.p5);
  });

  it('SAYS SO when they overlap, instead of quietly producing a number', () => {
    // The likely real case for a hybrid retriever over a corpus containing
    // something vaguely related to almost any question. A midpoint is still
    // produced — but `separated: false` plus both error rates is what stops
    // anyone adopting it without seeing what it costs.
    const report = calibrate({
      inCorpus: samples([0.010, 0.015, 0.020]),
      offSyllabus: samples([0.012, 0.018, 0.022]),
    });

    expect(report.separated).toBe(false);
    expect(report.inCorpusFalseAbstainRate).toBeGreaterThan(0);
  });

  it('reports both error rates, and they are the two things that matter', () => {
    const report = calibrate({
      inCorpus: samples([0.030, 0.030, 0.030, 0.030]),
      offSyllabus: samples([0.001, 0.001, 0.001, 0.001]),
    });

    // Every off-syllabus question is correctly refused...
    expect(report.offSyllabusAbstainRate).toBe(1);
    // ...and no in-corpus question is wrongly refused. That is the ideal, and
    // the asymmetry is deliberate: a false abstention tells a student "I do not
    // know" about something the corpus covers, which is the worse mistake.
    expect(report.inCorpusFalseAbstainRate).toBe(0);
  });

  it('never suggests a negative threshold', () => {
    expect(suggestThreshold({ inCorpus: samples([null]), offSyllabus: samples([null]) })).toBe(0);
  });

  it('counts a NULL in-corpus score as an abstention, because it is one', () => {
    const report = calibrate({
      inCorpus: samples([null, 0.03]),
      offSyllabus: samples([0.001]),
    });

    expect(report.inCorpusFalseAbstainRate).toBeGreaterThan(0);
  });

  it('reports zero rates for empty samples rather than dividing by zero', () => {
    const report = calibrate({ inCorpus: [], offSyllabus: [] });

    expect(report.inCorpusFalseAbstainRate).toBe(0);
    expect(report.offSyllabusAbstainRate).toBe(0);
  });
});

describe('turning a report into a MEASURED threshold', () => {
  const report = calibrate({
    inCorpus: samples([0.020, 0.021, 0.022]),
    offSyllabus: samples([0.010, 0.011]),
  });

  it('carries every piece of evidence the union demands', () => {
    const threshold = toMeasuredThreshold(report, {
      measuredAt: '2026-09-01',
      corpusChunkCount: 4686,
      embeddingModel: 'voyage-3',
    });

    expect(threshold.provenance).toEqual({
      state: 'MEASURED',
      measuredAt: '2026-09-01',
      inCorpusSampleSize: 3,
      offSyllabusSampleSize: 2,
      inCorpusP5: report.inCorpus.p5,
      offSyllabusP95: report.offSyllabus.p95,
      offSyllabusAbstainRate: report.offSyllabusAbstainRate,
      inCorpusFalseAbstainRate: report.inCorpusFalseAbstainRate,
      corpusChunkCount: 4686,
      embeddingModel: 'voyage-3',
    });
  });

  it('REFUSES a value that is not on the fused scale', () => {
    // A report computed against similarity scores rather than fused ones
    // cannot become a shipped constant. This is the same guard the constant
    // itself carries, applied at the only sanctioned way of producing one.
    const wrongScale = calibrate({
      inCorpus: samples([0.9, 0.92]),
      offSyllabus: samples([0.7, 0.72]),
    });

    expect(() =>
      toMeasuredThreshold(wrongScale, {
        measuredAt: '2026-09-01',
        corpusChunkCount: 4686,
        embeddingModel: 'voyage-3',
      }),
    ).toThrow(RangeError);
  });
});
