import { DependencyError, ValidationError } from '../errors/index';
import type { HttpClient } from '../http/index';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from './embed.port';

/**
 * The REAL embedding adapter — Voyage AI, model `voyage-3`, 1024 dimensions.
 *
 * ===========================================================================
 * THE DIMENSION AND THE MODEL ARE NOT PREFERENCES.
 *
 * All 4,666 embedded chunks in `rag_chunks` were produced by `voyage-3` at
 * 1024 dimensions. A query embedded by any other model lands in a different
 * vector space, where cosine distance is arithmetic that still succeeds and no
 * longer means anything: every query returns fifty confident, wrong rows. So
 * the width is CHECKED on every response rather than trusted, and a mismatch is
 * a `DependencyError` — the one failure mode this file exists to make loud.
 *
 * Changing the model means re-embedding the whole corpus. That is a user
 * decision, not a config tweak.
 *
 * ===========================================================================
 * NOT CALLED BY ANY TEST, AND THAT IS THE POINT.
 *
 * There is no API key. Every test here drives a FAKE `HttpClient`, so the
 * adapter is fully exercised — success, non-2xx, malformed body, wrong width,
 * empty data, transport failure — without a single byte leaving the machine.
 * The composition root is the only place that constructs it.
 *
 * ===========================================================================
 * RESILIENCE IS NOT IMPLEMENTED HERE, DELIBERATELY.
 *
 * Timeouts, jittered retry and the circuit breaker all live in the injected
 * `HttpClient` and in `createGuardedEmbed` (04-RESILIENCE-PLAN.md §3.3, §4,
 * §5). An adapter that grew its own retry loop would stack two backoff curves
 * and quadruple the load on a dependency that is already struggling — and only
 * one of the two would be visible in the metrics.
 *
 * ONE EXPLICIT OVERRIDE: `idempotent: true` on a POST. `platform/http` derives
 * idempotency from the METHOD and refuses to retry a POST, which is right for
 * a payment and wrong for this: embedding a string has no side effect, so
 * repeating it is safe, and without the flag the retry budget silently
 * collapses to zero and a single blip becomes a failed answer.
 */

/** The model the corpus was embedded with. Not a default — a match requirement. */
export const VOYAGE_MODEL = 'voyage-3';

/** Voyage's REST base. Overridable so a test never needs a URL matcher. */
export const VOYAGE_BASE_URL = 'https://api.voyageai.com/v1';

export interface VoyageEmbedOptions {
  /** Carries the timeout, the jittered retry and the breaker. */
  readonly http: HttpClient;
  /** `VOYAGE_API_KEY`. Never logged — see the header of `platform/pii`. */
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly dimensions?: number;
}

/**
 * Voyage's response shape, narrowed rather than cast.
 *
 * `as VoyageResponse` would compile and then hand a 1024-length array of
 * `undefined` to pgvector, which serialises as `[null,null,...]` and fails at
 * the driver — several layers from the malformed response that caused it.
 */
interface VoyageEmbedding {
  readonly embedding: readonly number[];
}

function narrowEmbedding(body: string, expectedDimensions: number): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new DependencyError('embed', {
      message: 'Voyage returned a body that is not JSON',
      cause,
    });
  }

  if (typeof parsed !== 'object' || parsed === null || !('data' in parsed)) {
    throw new DependencyError('embed', {
      message: 'Voyage response has no `data` field',
    });
  }

  const { data } = parsed;
  if (!Array.isArray(data) || data.length === 0) {
    throw new DependencyError('embed', {
      message: 'Voyage response `data` is empty — no embedding was returned',
    });
  }

  const first = data[0] as Partial<VoyageEmbedding> | null;
  const embedding = first?.embedding;
  if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === 'number')) {
    throw new DependencyError('embed', {
      message: 'Voyage response `data[0].embedding` is not an array of numbers',
    });
  }

  // THE CHECK THAT MATTERS. See the header: a width mismatch is a different
  // vector space, and a different vector space is silently wrong retrieval.
  if (embedding.length !== expectedDimensions) {
    throw new DependencyError('embed', {
      message:
        `Voyage returned a ${String(embedding.length)}-dimension vector; the corpus is ` +
        `${String(expectedDimensions)}. A query in a different vector space returns ` +
        'confident nonsense, so this is refused rather than used.',
      details: { got: embedding.length, expected: expectedDimensions },
    });
  }

  // Non-finite components would make every cosine distance NULL in Postgres,
  // which reads as "no results" rather than as a bad vector.
  if (!embedding.every((value) => Number.isFinite(value))) {
    throw new DependencyError('embed', {
      message: 'Voyage returned a vector containing a non-finite component',
    });
  }

  return [...embedding];
}

export function createVoyageEmbed(options: VoyageEmbedOptions): EmbeddingProvider {
  const model = options.model ?? VOYAGE_MODEL;
  const baseUrl = (options.baseUrl ?? VOYAGE_BASE_URL).replace(/\/+$/, '');
  const dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;

  if (options.apiKey.trim().length === 0) {
    // At CONSTRUCTION, not at first call. A missing key discovered on the first
    // student question is an outage; discovered at boot it is a deployment that
    // refuses to start, which is the whole point of `platform/config`.
    throw new ValidationError('VOYAGE_API_KEY is required to construct the Voyage embedder.', {
      message: 'createVoyageEmbed: apiKey is empty',
    });
  }

  return {
    model,
    dimensions,

    async embedQuery(text: string): Promise<number[]> {
      if (text.trim().length === 0) {
        throw new ValidationError('A query cannot be empty.', {
          message: 'createVoyageEmbed: refused to embed empty text',
        });
      }

      const response = await options.http.request({
        method: 'POST',
        url: `${baseUrl}/embeddings`,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
        },
        body: {
          input: [text],
          model,
          // `query` rather than `document`. voyage-3 embeds the two
          // asymmetrically, and using the document form for a question costs
          // measurable recall against a corpus embedded as documents.
          input_type: 'query',
        },
        // See the header — a POST that is safe to repeat, stated explicitly.
        idempotent: true,
      });

      if (response.status < 200 || response.status >= 300) {
        throw new DependencyError('embed', {
          message: `Voyage responded ${String(response.status)}`,
          // The STATUS, never the body: an auth failure echoes the key back in
          // some providers' error text.
          details: { status: response.status },
        });
      }

      return narrowEmbedding(response.body, dimensions);
    },
  };
}
