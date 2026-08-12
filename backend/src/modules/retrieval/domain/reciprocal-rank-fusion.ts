/**
 * STEP 5 OF THE PIPELINE — reciprocal rank fusion, constant 60 (§8.4).
 *
 * Pure. No I/O.
 *
 * ===========================================================================
 * WHY FUSION IS ON RANK AND NOT ON SCORE.
 *
 * The two halves produce numbers that are not comparable and never will be:
 * cosine DISTANCE from pgvector is in [0, 2] and smaller is better, while
 * `ts_rank` is an unbounded positive score where larger is better and whose
 * magnitude depends on document length. Any attempt to put them on one scale
 * needs a normalisation whose parameters have to be tuned per corpus — and a
 * mis-tuned one silently lets one half dominate, which looks exactly like the
 * other half being broken.
 *
 * RRF throws the magnitudes away and keeps only the ORDER, which is the only
 * thing the two halves genuinely agree about. `1 / (k + rank)`, summed across
 * the lists a document appears in.
 *
 * ===========================================================================
 * WHAT k = 60 DOES.
 *
 * It flattens the top of the curve. At k = 60 the difference between rank 1
 * and rank 2 is 1/61 - 1/62 ≈ 0.00026, while APPEARING IN BOTH LISTS AT ALL is
 * worth another ~1/61 ≈ 0.0164 — sixty times more. That is the property §8.4
 * asks for in words and the test asserts directly: a document found by both
 * halves outranks one found brilliantly by only one of them.
 *
 * ===========================================================================
 * THE SCALE THIS PUTS THE ABSTENTION THRESHOLD ON.
 *
 * A fused score is bounded: at most `2 / (k + 1)` ≈ 0.0328 (rank 1 in both
 * lists), at least `1 / (k + limit)` ≈ 0.0091 for a single appearance at the
 * bottom of one list. Any threshold constant MUST live inside that window. The
 * previous system's year-long silent filter was a floor written on the WRONG
 * SCALE — a cosine-similarity number applied to fused scores, so nothing ever
 * cleared it. See `abstain-threshold.ts`, which derives both bounds from the
 * constants here rather than restating them.
 */

/** §8.4: "reciprocal rank fusion, constant 60". */
export const RRF_K = 60;

export interface FusedCandidate {
  readonly id: string;
  readonly fusedScore: number;
  /** 1-based position in the dense list, or `null` if it was not in it. */
  readonly denseRank: number | null;
  /** 1-based position in the sparse list, or `null` if it was not in it. */
  readonly sparseRank: number | null;
}

/** The best possible fused score: rank 1 in BOTH lists. */
export function maxFusedScore(k: number = RRF_K): number {
  return 2 / (k + 1);
}

/** The worst non-zero fused score: last place in exactly one list. */
export function minFusedScore(listLimit: number, k: number = RRF_K): number {
  return 1 / (k + listLimit);
}

function rankMap(ids: readonly string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  ids.forEach((id, index) => {
    // FIRST occurrence wins. A list that repeats an id is a defect upstream,
    // but scoring the repeat would double-count one document into the top 3.
    if (!ranks.has(id)) ranks.set(id, index + 1);
  });
  return ranks;
}

/**
 * Fuses two ranked id lists into one, highest fused score first.
 *
 * TIES ARE BROKEN DETERMINISTICALLY — by best rank across the two lists, then
 * by id. Not tidiness: `Array.prototype.sort` is stable in modern V8 but the
 * INPUT order here is a Map iteration order that depends on which list an id
 * was seen in first, so two runs over the same data could otherwise disagree
 * about which of two equally-scored chunks reaches a top-3 cut. A retrieval
 * result that is not reproducible cannot be debugged from its own trace.
 */
export function fuse(
  denseIds: readonly string[],
  sparseIds: readonly string[],
  k: number = RRF_K,
): FusedCandidate[] {
  const dense = rankMap(denseIds);
  const sparse = rankMap(sparseIds);

  const candidates: FusedCandidate[] = [];
  for (const id of new Set([...dense.keys(), ...sparse.keys()])) {
    const denseRank = dense.get(id) ?? null;
    const sparseRank = sparse.get(id) ?? null;
    const fusedScore =
      (denseRank === null ? 0 : 1 / (k + denseRank)) +
      (sparseRank === null ? 0 : 1 / (k + sparseRank));
    candidates.push({ id, fusedScore, denseRank, sparseRank });
  }

  return candidates.sort((a, b) => {
    if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore;
    const bestA = Math.min(a.denseRank ?? Infinity, a.sparseRank ?? Infinity);
    const bestB = Math.min(b.denseRank ?? Infinity, b.sparseRank ?? Infinity);
    if (bestA !== bestB) return bestA - bestB;
    return a.id < b.id ? -1 : 1;
  });
}
