import { describe, expect, it } from 'vitest';
import {
  ABSTAIN_THRESHOLD,
  CANDIDATE_LIMIT,
  DEFAULT_TOP_N,
  assertThresholdOnFusedScale,
  confidenceFrom,
  decideAbstention,
  isUncalibrated,
  type AbstainThreshold,
} from '../domain/abstain-threshold';
import { RRF_K, maxFusedScore, minFusedScore } from '../domain/reciprocal-rank-fusion';

describe('the shipped threshold', () => {
  it('IS MARKED UNCALIBRATED — the assertion §8.4 asks for by name', () => {
    /**
     * "Ship with the threshold constant clearly marked UNCALIBRATED, and a
     * test asserting it is marked so. It must be impossible to ship a guessed
     * value believing it was measured."
     *
     * THIS TEST IS EXPECTED TO FAIL, ONCE, deliberately: on the day the
     * calibration harness is run against a real `VOYAGE_API_KEY` and the
     * constant is replaced with a MEASURED one. Flipping this assertion is
     * then the last step, and it is a step somebody has to take on purpose —
     * which is the entire mechanism. Do not flip it before the numbers exist.
     */
    expect(ABSTAIN_THRESHOLD.provenance.state).toBe('UNCALIBRATED');
    expect(isUncalibrated(ABSTAIN_THRESHOLD)).toBe(true);
  });

  it('states WHY it is uncalibrated, in words a future reader can act on', () => {
    // A bare `state: 'UNCALIBRATED'` would say the value is unmeasured and
    // nothing about what measuring it would take. The reason field is what
    // stops the next person concluding that somebody simply forgot.
    const { provenance } = ABSTAIN_THRESHOLD;
    expect(provenance.state).toBe('UNCALIBRATED');
    if (provenance.state !== 'UNCALIBRATED') throw new Error('unreachable');
    expect(provenance.reason).toMatch(/VOYAGE_API_KEY/);
    expect(provenance.reason.length).toBeGreaterThan(80);
  });

  it('is on the fused RRF scale, not on a similarity scale', () => {
    assertThresholdOnFusedScale(ABSTAIN_THRESHOLD.value);
    expect(ABSTAIN_THRESHOLD.value).toBeLessThanOrEqual(maxFusedScore(RRF_K));
  });

  it('is INERT: no achievable candidate score falls below it', () => {
    /**
     * The safety property that makes shipping an unmeasured floor defensible.
     * The value is the lowest score a document can earn at all, so score-based
     * abstention cannot silently remove anything — which is exactly the
     * failure §8.4 records. Retrieval still abstains when nothing was found.
     */
    expect(ABSTAIN_THRESHOLD.value).toBe(minFusedScore(CANDIDATE_LIMIT, RRF_K));
    expect(decideAbstention(minFusedScore(CANDIDATE_LIMIT, RRF_K), ABSTAIN_THRESHOLD)).toBeNull();
  });

  it('keeps the launch parameters §8.4 names', () => {
    expect(DEFAULT_TOP_N).toBe(3);
    expect(CANDIDATE_LIMIT).toBe(50);
  });
});

describe('assertThresholdOnFusedScale', () => {
  it('accepts zero — "never abstain on score" is a statable position', () => {
    expect(() => {
      assertThresholdOnFusedScale(0);
    }).not.toThrow();
  });

  it('accepts the ceiling exactly', () => {
    expect(() => {
      assertThresholdOnFusedScale(maxFusedScore(RRF_K));
    }).not.toThrow();
  });

  it('REFUSES a cosine-similarity number — the year-long silent filter', () => {
    // 0.7 is a perfectly sensible cosine floor and a catastrophic fused one:
    // nothing can reach it, so every query abstains and the corpus looks empty.
    expect(() => {
      assertThresholdOnFusedScale(0.7);
    }).toThrow(RangeError);
  });

  it('refuses a negative value', () => {
    expect(() => {
      assertThresholdOnFusedScale(-0.001);
    }).toThrow(RangeError);
  });

  it('refuses NaN, which compares false against everything and abstains never', () => {
    expect(() => {
      assertThresholdOnFusedScale(Number.NaN);
    }).toThrow(RangeError);
  });
});

describe('the abstention decision', () => {
  const threshold: AbstainThreshold = {
    value: 0.02,
    provenance: { state: 'UNCALIBRATED', reason: 'test fixture' },
  };

  it('names "no-candidates" when nothing was found at all', () => {
    expect(decideAbstention(null, threshold)).toBe('no-candidates');
  });

  it('names "below-threshold" when things were found but judged weak', () => {
    // The two are kept apart because they have opposite fixes: one is a content
    // or filter problem, the other a ranking one. A single boolean merges them,
    // and a missing-content incident then gets investigated as a threshold bug.
    expect(decideAbstention(0.019, threshold)).toBe('below-threshold');
  });

  it('does not abstain exactly AT the threshold', () => {
    // The boundary, stated: the rule is "below", so equal passes.
    expect(decideAbstention(0.02, threshold)).toBeNull();
  });

  it('does not abstain above it', () => {
    expect(decideAbstention(0.021, threshold)).toBeNull();
  });
});

describe('confidence', () => {
  it('is 1 for a document ranked first by BOTH halves', () => {
    expect(confidenceFrom(maxFusedScore(RRF_K))).toBeCloseTo(1, 12);
  });

  it('is 0 when there is nothing', () => {
    expect(confidenceFrom(null)).toBe(0);
  });

  it('is about a half for a document ranked first by only one half', () => {
    expect(confidenceFrom(1 / (RRF_K + 1))).toBeCloseTo(0.5, 12);
  });

  it('clamps rather than exceeding 1', () => {
    expect(confidenceFrom(1)).toBe(1);
  });

  it('is monotone in the fused score', () => {
    expect(confidenceFrom(0.02)).toBeGreaterThan(confidenceFrom(0.01));
  });
});
