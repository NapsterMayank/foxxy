export { EMBEDDING_DIMENSIONS } from './embed.port';
export type { EmbeddingProvider } from './embed.port';
export { createGuardedEmbed } from './guarded-embed';
export {
  DETERMINISTIC_EMBED_MODEL,
  createDeterministicEmbed,
  deterministicEmbedding,
} from './fake-embed';
export type { DeterministicEmbedOptions } from './fake-embed';
export { VOYAGE_BASE_URL, VOYAGE_MODEL, createVoyageEmbed } from './voyage-embed';
export type { VoyageEmbedOptions } from './voyage-embed';
