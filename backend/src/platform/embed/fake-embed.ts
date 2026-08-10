import { ValidationError } from '../errors/index';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from './embed.port';

/**
 * A DETERMINISTIC embedding provider — the fake every test uses.
 *
 * ===========================================================================
 * WHY A FAKE EXISTS AT ALL, AND WHY IT IS DETERMINISTIC.
 *
 * `retrieval` cannot be built without vectors to rank, and the real provider
 * costs money, needs a key nobody has yet, and is non-deterministic in latency.
 * Plan §9.1 is explicit: fake the embedding service.
 *
 * `Math.random()` here would make "chunk A outranks chunk B for query Q" a coin
 * toss, which §9.5 calls a broken test. The same seed always yields exactly the
 * same 1024 numbers, on every machine and every run.
 *
 * ===========================================================================
 * WHAT IT IS NOT.
 *
 * NOT A SEMANTIC MODEL. Two strings that mean the same thing to a human embed
 * to unrelated vectors here. These exercise the PLUMBING — the pgvector column,
 * the HNSW index, the distance operator, the fusion arithmetic. They cannot
 * validate retrieval QUALITY, and the §8.4 abstention threshold must never be
 * calibrated against them: a number measured here would have the shape of a
 * measurement and none of the content. See `domain/abstain-threshold.ts`.
 *
 * ===========================================================================
 * THE GENERATOR, and why each step is there.
 *
 * FNV-1a(seed) -> mulberry32 PRNG -> Box-Muller -> L2 normalise.
 *
 *  - NORMAL rather than uniform components, because uniform values in [0,1) are
 *    all positive and every such vector points into the same orthant. Cosine
 *    similarity between any two of them then sits around 0.75 whatever the
 *    seeds are, which would make a similarity test unable to fail. Normal
 *    components spread over the sphere, so unrelated seeds sit near orthogonal
 *    exactly as real embeddings of unrelated text do.
 *  - L2-NORMALISED, because voyage-3 returns unit vectors. Matching that keeps
 *    cosine distance and inner product interchangeable, as they will be against
 *    the real corpus.
 *
 * This duplicates `tests/fixtures/embedding.ts` on purpose rather than by
 * accident: that file seeds CHUNK vectors from a database fixture and lives in
 * the test tree; this one is a `platform` PORT IMPLEMENTATION that production
 * code can be wired to in a dev environment with no API key. A test that seeds
 * a chunk with `makeEmbedding('x')` and then queries with
 * `createDeterministicEmbed().embedQuery('x')` gets the SAME vector and a
 * cosine distance of exactly zero — which is what makes "the nearest chunk
 * wins" assertable. That agreement is pinned by a test.
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
 * The vector a given seed string maps to. Exported so a test can assert the
 * expected neighbour rather than merely that rows came back.
 */
export function deterministicEmbedding(
  seed: string,
  dimensions: number = EMBEDDING_DIMENSIONS,
): number[] {
  const random = mulberry32(fnv1a(seed));
  const values: number[] = new Array<number>(dimensions);

  for (let index = 0; index < dimensions; index += 1) {
    // Box-Muller. `1 - random()` keeps the argument of `log` strictly positive;
    // `random()` can return exactly 0, and `log(0)` is -Infinity, which would
    // poison the whole vector roughly once every four billion draws — the kind
    // of odds that only ever fail in CI, months later, once.
    const u1 = 1 - random();
    const u2 = random();
    values[index] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  let sumOfSquares = 0;
  for (const value of values) sumOfSquares += value * value;
  const magnitude = Math.sqrt(sumOfSquares);

  if (magnitude === 0) {
    throw new Error(`deterministicEmbedding produced a zero vector for seed "${seed}"`);
  }

  return values.map((value) => value / magnitude);
}

/** The model name the fake reports. Deliberately not `voyage-3`. */
export const DETERMINISTIC_EMBED_MODEL = 'deterministic-fake';

export interface DeterministicEmbedOptions {
  /** Only ever passed by a test proving the width is checked. */
  readonly dimensions?: number;
  readonly model?: string;
}

/**
 * The fake, as an `EmbeddingProvider`.
 *
 * IT REFUSES EMPTY INPUT rather than returning a vector for it. An empty query
 * has no nearest neighbour, only an arbitrary one, and a provider that answers
 * anyway hands retrieval fifty confident-looking rows for a question nobody
 * asked. `retrieval` abstains before it ever gets here; this is the second
 * lock on the same door.
 */
export function createDeterministicEmbed(
  options: DeterministicEmbedOptions = {},
): EmbeddingProvider {
  const dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
  const model = options.model ?? DETERMINISTIC_EMBED_MODEL;

  return {
    model,
    dimensions,
    embedQuery(text: string): Promise<number[]> {
      if (text.trim().length === 0) {
        return Promise.reject(
          new ValidationError('A query cannot be empty.', {
            message: 'createDeterministicEmbed: refused to embed empty text',
          }),
        );
      }
      return Promise.resolve(deterministicEmbedding(text, dimensions));
    },
  };
}
