/**
 * platform/embed — the embedding port. INTERFACE ONLY at this build step;
 * the Voyage adapter lands with build step 7.
 *
 * Dimensionality is fixed at 1024 to match the existing 16,000-chunk corpus,
 * which was embedded with `voyage-3`. Changing the model means re-embedding
 * the whole corpus, so the dimension is stated as a constant, not a guess.
 */
export const EMBEDDING_DIMENSIONS = 1024;

export interface EmbeddingProvider {
  /** Embeds a single query. Throws DependencyError on failure — never
   *  returns a zero vector, which would silently corrupt retrieval. */
  embedQuery(text: string): Promise<number[]>;
  readonly model: string;
  readonly dimensions: number;
}
