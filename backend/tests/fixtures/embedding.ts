import { EMBEDDING_DIMENSIONS } from '../../src/shared/constants/curriculum';

/**
 * A DETERMINISTIC synthetic embedding, derived from a seed string.
 *
 * The real corpus is not available yet (PROGRESS.md §2 — it is blocked on
 * credentials), and nine of eleven modules sit behind it. Retrieval, ranking
 * and fusion all need vectors to run against, so the choice is either to stop
 * or to generate them. This generates them.
 *
 * DETERMINISTIC IS THE WHOLE POINT. `Math.random()` here would produce a
 * vector-similarity test that passes most of the time — a flaky test, which
 * plan §9.5 calls a broken test. The same seed always yields exactly the same
 * 1024 numbers, on every machine and every run, so "chunk A ranks above chunk
 * B for query Q" is a fact that can be asserted rather than a coin toss.
 *
 * The generator is a 32-bit FNV-1a hash of the seed feeding a mulberry32 PRNG,
 * pushed through a Box-Muller transform to give roughly normal components, and
 * then L2-NORMALISED. Each of those has a reason:
 *
 *  - Normal rather than uniform components, because uniform values in [0,1)
 *    are all positive, and every such vector points into the same orthant.
 *    Cosine similarity between any two of them is then around 0.75 no matter
 *    what the seeds are, which would make a similarity test unable to fail.
 *    Normal components spread over the sphere, so unrelated seeds sit near
 *    orthogonal, as real embeddings of unrelated text do.
 *  - L2-normalised, because voyage-3 returns unit vectors. Matching that keeps
 *    cosine distance and inner product interchangeable, exactly as they will
 *    be against the real corpus.
 *
 * NOT A SEMANTIC MODEL. Two seeds that mean the same thing to a human are
 * unrelated here. These vectors exercise the PLUMBING — the pgvector column,
 * the HNSW index, the distance operator, the fusion arithmetic. They cannot
 * validate retrieval QUALITY, and the threshold calibration in §8.4 must be
 * measured against the real corpus, never against these.
 */

/** FNV-1a, 32-bit. Small, fast, and well-spread for short strings. */
function fnv1a(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — a compact PRNG with good distribution for a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `dimensions` deliberately defaults to the corpus width and is a parameter
 * only so a test can prove the column REJECTS a wrong-width vector. Production
 * code has no reason to pass it.
 */
export function makeEmbedding(seed: string, dimensions: number = EMBEDDING_DIMENSIONS): number[] {
  const random = mulberry32(fnv1a(seed));
  const values: number[] = new Array<number>(dimensions);

  for (let index = 0; index < dimensions; index += 1) {
    // Box-Muller. `1 - random()` keeps the argument of `log` strictly positive;
    // `random()` can return exactly 0, and `log(0)` is -Infinity, which would
    // poison the entire vector roughly once every four billion draws — the kind
    // of odds that only ever fail in CI, months later, once.
    const u1 = 1 - random();
    const u2 = random();
    values[index] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  let sumOfSquares = 0;
  for (const value of values) sumOfSquares += value * value;
  const magnitude = Math.sqrt(sumOfSquares);

  // A zero-magnitude vector is unreachable for any real seed (1024 independent
  // normals summing to exactly zero), but dividing by it would yield NaNs that
  // Postgres accepts and every distance query then returns NULL for. Guarded
  // rather than assumed.
  if (magnitude === 0) {
    throw new Error(`makeEmbedding produced a zero vector for seed "${seed}"`);
  }

  return values.map((value) => value / magnitude);
}

/** The pgvector literal form: `[0.1,-0.2,...]`. What the driver wants. */
export function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}

/** Cosine similarity, for asserting what a similarity query should return. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch, ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    magnitudeA += left * left;
    magnitudeB += right * right;
  }
  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}
