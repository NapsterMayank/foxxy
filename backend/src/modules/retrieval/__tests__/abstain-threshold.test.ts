import { describe, expect, it } from 'vitest';
import {
  ABSTAIN_THRESHOLD,
  CANDIDATE_LIMIT,
  DEFAULT_TOP_N,
  assertThresholdMatchesCandidateDepth,
  assertThresholdOnFusedScale,
  confidenceFrom,
  decideAbstention,
  isUncalibrated,
  type AbstainThreshold,
} from '../domain/abstain-threshold';
import { RRF_K, maxFusedScore } from '../domain/reciprocal-rank-fusion';

describe('the shipped threshold', () => {
  it('IS MARKED MEASURED, and carries every field the union demands', () => {
    /**
     * This assertion was `UNCALIBRATED` until 10 August 2026 and was designed
     * to fail exactly once — on the day the harness ran against a real
     * `VOYAGE_API_KEY` and a human transcribed the result. That day happened.
     *
     * What it pins now is the other direction: the constant may not quietly
     * regress to a claim with no evidence behind it.
     */
    const { provenance } = ABSTAIN_THRESHOLD;

    expect(provenance.state).toBe('MEASURED');
    expect(isUncalibrated(ABSTAIN_THRESHOLD)).toBe(false);
    if (provenance.state !== 'MEASURED') throw new Error('unreachable');

    // §8.4 asks for 50 in-corpus and 20 off-syllabus. The in-corpus set grew to
    // 54 while being anchored to real chapters; the floor is what matters.
    expect(provenance.inCorpusSampleSize).toBeGreaterThanOrEqual(50);
    expect(provenance.offSyllabusSampleSize).toBeGreaterThanOrEqual(20);
    expect(provenance.embeddingModel).toBe('voyage-3');
    expect(provenance.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it('was measured against THIS corpus, not the pre-import figures', () => {
    /**
     * 4,403 is the ACTIVE chunk count — the population retrieval can return.
     * The imported table holds 4,686 rows and D-078's headline once said 2,564
     * chunks lacked an embedding; the measured figure is 20. A threshold
     * stamped with a corpus size that no query ever saw is a provenance block
     * that documents the wrong run.
     */
    const { provenance } = ABSTAIN_THRESHOLD;
    if (provenance.state !== 'MEASURED') throw new Error('unreachable');

    expect(provenance.corpusChunkCount).toBe(4403);
  });

  it('SITS BETWEEN THE TWO OBSERVED DISTRIBUTIONS, at their measured edges', () => {
    // The distributions overlap, so "between them" cannot mean "in a gap". What
    // it does mean is checkable: the value is at or above the in-corpus 5th
    // percentile (that is where the budget put it) and at or below the
    // off-syllabus 95th (above that it would be refusing more in-corpus
    // questions than off-syllabus ones).
    const { value, provenance } = ABSTAIN_THRESHOLD;
    if (provenance.state !== 'MEASURED') throw new Error('unreachable');

    expect(value).toBeGreaterThanOrEqual(provenance.inCorpusP5);
    expect(value).toBeLessThanOrEqual(provenance.offSyllabusP95);
  });

  it('SPENDS NO MORE THAN ITS STATED FALSE-ABSTENTION BUDGET', () => {
    /**
     * THE ASYMMETRY, AS A TEST. A false abstention is a student told "I do not
     * know" about material the corpus covers. The 5/95 midpoint rule would have
     * cost 24.1% of the in-corpus set; that is the mistake this bound exists to
     * make un-shippable, and it is checked against the LITERAL 5% rather than
     * against `falseAbstainBudget` — comparing the recorded rate to the
     * recorded budget would pass for any pair of numbers that happen to agree.
     */
    const { provenance } = ABSTAIN_THRESHOLD;
    if (provenance.state !== 'MEASURED') throw new Error('unreachable');

    expect(provenance.policy).toBe('in-corpus-false-abstain-budget');
    expect(provenance.inCorpusFalseAbstainRate).toBeLessThanOrEqual(0.05);
  });

  it('CAN ACTUALLY FIRE — `below-threshold` is reachable, which it was not', () => {
    /**
     * THE DEFECT THIS REPLACES, STATED PLAINLY.
     *
     * The shipped value used to be `minFusedScore(CANDIDATE_LIMIT, RRF_K)` —
     * the lowest score any document can earn — compared with a strict `<`. The
     * worst achievable fused score is EXACTLY that number, so nothing could
     * ever be below it and `below-threshold` was unreachable. The old test
     * asserted `value === minFusedScore(CANDIDATE_LIMIT, RRF_K)`, which is the
     * expression the constant was defined by: a tautology that would have held
     * for any value whatsoever.
     *
     * So this asserts reachability from BOTH ends, against literals.
     */
    const worstAchievable = 1 / (60 + 50); // ≈ 0.00909, a rank-50 single-list hit
    const bestAchievable = 2 / (60 + 1); // ≈ 0.03279, rank 1 in both halves

    expect(decideAbstention(worstAchievable, ABSTAIN_THRESHOLD)).toBe('below-threshold');
    expect(decideAbstention(bestAchievable, ABSTAIN_THRESHOLD)).toBeNull();
    expect(ABSTAIN_THRESHOLD.value).toBeGreaterThan(worstAchievable);
    expect(ABSTAIN_THRESHOLD.value).toBeLessThan(bestAchievable);
  });

  it('is on the fused RRF scale, not on a similarity scale', () => {
    assertThresholdOnFusedScale(ABSTAIN_THRESHOLD.value);
    expect(ABSTAIN_THRESHOLD.value).toBeLessThanOrEqual(maxFusedScore(RRF_K));
  });

  it('STATES THE CANDIDATE DEPTH it was measured at', () => {
    // The bottom of the fused scale is 1/(k + depth), so the value means
    // something different at another depth. `retrieval.service.ts` refuses to
    // start when its configured depth disagrees with this one.
    expect(ABSTAIN_THRESHOLD.candidateLimit).toBe(50);
    expect(ABSTAIN_THRESHOLD.candidateLimit).toBe(CANDIDATE_LIMIT);
  });

  it('keeps the launch parameters §8.4 names', () => {
    expect(DEFAULT_TOP_N).toBe(3);
    expect(CANDIDATE_LIMIT).toBe(50);
  });
});

describe('the candidate-depth guard', () => {
  it('accepts the depth the threshold was measured at', () => {
    expect(() => {
      assertThresholdMatchesCandidateDepth(ABSTAIN_THRESHOLD, 50);
    }).not.toThrow();
  });

  it('REFUSES a deeper candidate list, which silently drops ranks 51..100', () => {
    /**
     * The coupling defect. `ABSTAIN_THRESHOLD` is baked at depth 50 while the
     * service reads `deps.candidateLimit ?? CANDIDATE_LIMIT`, so raising the
     * limit to 100 through the SUPPORTED override moved fifty new candidates
     * below a floor measured without them — no error, no log line, a different
     * answer.
     */
    expect(() => {
      assertThresholdMatchesCandidateDepth(ABSTAIN_THRESHOLD, 100);
    }).toThrow(RangeError);
  });

  it('refuses a shallower one too — the mismatch is what is wrong, not the direction', () => {
    expect(() => {
      assertThresholdMatchesCandidateDepth(ABSTAIN_THRESHOLD, 20);
    }).toThrow(RangeError);
  });

  it('names both depths, so the message is actionable without reading the source', () => {
    expect(() => {
      assertThresholdMatchesCandidateDepth(ABSTAIN_THRESHOLD, 100);
    }).toThrow(/50[\s\S]*100|100[\s\S]*50/u);
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
    candidateLimit: 50,
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
