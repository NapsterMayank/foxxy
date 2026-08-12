import type { PortGuard } from '../resilience/index';
import type { EmbeddingProvider } from './embed.port';

/**
 * The embedding port behind its bulkhead, breaker and 5s timeout (§3.3, §4, §5).
 *
 * Built against the interface before the adapter exists, for the same reason
 * as `createGuardedLlm`: the resilience belongs to the port, not to whichever
 * vendor happens to be behind it this quarter.
 *
 * The degradation this protects (§6): when embeddings are down, retrieval
 * falls back to keyword-only and Foxy still answers. That fallback only ever
 * runs if the embedding call FAILS FAST — with a 10-connection queue and no
 * breaker it instead stalls, and "still answers" becomes "spins forever".
 */
export function createGuardedEmbed(
  inner: EmbeddingProvider,
  guard: PortGuard,
): EmbeddingProvider {
  return {
    model: inner.model,
    dimensions: inner.dimensions,
    embedQuery(text: string): Promise<number[]> {
      /**
       * IDEMPOTENT — D-237, and this is the clearest case in the codebase.
       *
       * Embedding is a pure function of the text: the same input returns the
       * same vector, it writes nothing, and a repeated call is invisible to
       * everything except the vendor's bill. `embed`'s rule carries
       * `retries: 2`, which had been parsed and read by nothing; declaring the
       * permission here is what spends it.
       *
       * It also protects the §6 degradation rather than undermining it: the
       * fallback to keyword-only retrieval runs when the call FAILS, and two
       * jittered retries inside a 5s-per-attempt budget still fail fast
       * compared with the alternative of losing semantic search on a blip.
       */
      return guard.run(() => inner.embedQuery(text), { idempotent: true });
    },
  };
}
