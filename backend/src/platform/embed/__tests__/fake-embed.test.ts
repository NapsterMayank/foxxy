import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '../../../shared/constants/curriculum';
import { makeEmbedding } from '../../../../tests/fixtures/embedding';
import { ValidationError } from '../../errors/index';
import {
  DETERMINISTIC_EMBED_MODEL,
  createDeterministicEmbed,
  deterministicEmbedding,
} from '../fake-embed';

describe('the deterministic embedding provider', () => {
  it('returns a vector of exactly the corpus width', async () => {
    const embed = createDeterministicEmbed();
    const vector = await embed.embedQuery('what is photosynthesis');

    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(embed.dimensions).toBe(EMBEDDING_DIMENSIONS);
  });

  it('reports a model name that could never be mistaken for the real one', () => {
    // If this ever read 'voyage-3', a fake vector could be written into
    // `rag_chunks.embedding_model` and become indistinguishable from a real
    // one — after which nobody could tell which rows need re-embedding.
    expect(createDeterministicEmbed().model).toBe(DETERMINISTIC_EMBED_MODEL);
    expect(DETERMINISTIC_EMBED_MODEL).not.toBe('voyage-3');
  });

  it('gives the same vector for the same text, every time', async () => {
    const embed = createDeterministicEmbed();

    expect(await embed.embedQuery('force and motion')).toEqual(
      await embed.embedQuery('force and motion'),
    );
  });

  it('gives different vectors for different text', async () => {
    const embed = createDeterministicEmbed();
    const a = await embed.embedQuery('force and motion');
    const b = await embed.embedQuery('photosynthesis');

    expect(a).not.toEqual(b);
  });

  it('returns a UNIT vector, matching voyage-3', () => {
    const vector = deterministicEmbedding('unit-check');
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

    expect(magnitude).toBeCloseTo(1, 10);
  });

  it('spreads unrelated seeds near orthogonal, so a similarity test CAN fail', () => {
    // The reason for normal rather than uniform components. With uniform
    // values every vector points into the same orthant and any two are ~0.75
    // similar, which would make "the nearest chunk wins" true by construction.
    const a = deterministicEmbedding('alpha');
    const b = deterministicEmbedding('beta');
    const dot = a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

    expect(Math.abs(dot)).toBeLessThan(0.2);
  });

  it('agrees EXACTLY with the chunk fixture generator', () => {
    /**
     * The load-bearing property. A test seeds a chunk with
     * `makeEmbedding('photosynthesis')` and then queries through the port with
     * the same string; only if the two generators agree is the cosine distance
     * zero and "the nearest chunk wins" assertable rather than approximate.
     *
     * The two live in different trees on purpose (one is a database fixture,
     * one is a platform port), so nothing but this test stops them drifting.
     */
    expect(deterministicEmbedding('photosynthesis')).toEqual(makeEmbedding('photosynthesis'));
  });

  it('refuses empty text rather than returning an arbitrary vector', async () => {
    const embed = createDeterministicEmbed();

    await expect(embed.embedQuery('   ')).rejects.toBeInstanceOf(ValidationError);
  });

  it('honours a narrower width, so the column can be proved to reject one', async () => {
    const embed = createDeterministicEmbed({ dimensions: 8 });

    expect(await embed.embedQuery('narrow')).toHaveLength(8);
  });
});
