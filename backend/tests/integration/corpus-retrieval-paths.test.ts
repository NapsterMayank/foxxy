import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../helpers/postgres';
import {
  insertChapter,
  insertRagChunk,
  makeChapter,
  makeEmbedding,
  makeRagChunk,
  toVectorLiteral,
} from '../fixtures';

/**
 * THE TWO RETRIEVAL PATHS, RUN RATHER THAN ASSUMED.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS SEPARATELY FROM `hnsw-ef-search.test.ts`.
 *
 * That file measures ONE property of the vector path — that `ef_search` is high
 * enough for the top-50 the retrieval module asks for (D-049). It says nothing
 * about whether a query written the way retrieval will write it returns
 * sensible rows, and nothing at all about full-text.
 *
 * The corpus import's stated verification includes running one vector query and
 * one full-text query BY HAND and looking at what comes back. This is that,
 * automated so it keeps happening: a real question, both paths, and an
 * assertion that the right chunk wins rather than merely that some rows came
 * back.
 *
 * ===========================================================================
 * WHAT A PASSING RUN HERE DOES AND DOES NOT MEAN.
 *
 * It means the plumbing is correct: the pgvector column, the cosine operator,
 * the generated `search_vector`, the GIN index, the language CASE, the
 * (grade, subject) hard filter, and the three indexes the import needs.
 *
 * It does NOT mean retrieval is any good. These embeddings are deterministic
 * synthetic vectors (D-047) and carry no meaning; the §8.4 abstention threshold
 * must be measured against the real corpus, and a threshold calibrated against
 * these would be a number with the shape of a measurement and none of the
 * content.
 */

let postgres: TestPostgres;
let scienceChapterId: string;

/** The vector a "how do plants make food?" query would embed to, near enough. */
const QUERY_SEED = 'photosynthesis-query';

beforeAll(async () => {
  postgres = await startTestPostgres();
  await applyAllMigrations(postgres.client);

  scienceChapterId = await insertChapter(
    postgres.client,
    makeChapter('sci-8-1', { grade: '8', subjectCode: 'science', chapterNumber: 1 }),
  );

  const mathsChapterId = await insertChapter(
    postgres.client,
    makeChapter('math-8-1', { grade: '8', subjectCode: 'mathematics', chapterNumber: 1 }),
  );

  // The chunk that should win both queries: its vector IS the query vector, and
  // its text carries the words a student would type.
  await insertRagChunk(
    postgres.client,
    makeRagChunk('target', {
      chunkText:
        'Photosynthesis is the process by which green plants use sunlight to make food from carbon dioxide and water.',
      chapterTitle: 'Crop Production and Management',
      topic: 'Photosynthesis',
      concept: 'Food production in plants',
      embedding: makeEmbedding(QUERY_SEED),
      grade: '8',
      subject: 'science',
    }),
    scienceChapterId,
  );

  // Same subject, unrelated content — the row that must NOT win.
  await insertRagChunk(
    postgres.client,
    makeRagChunk('distractor', {
      chunkText: 'Friction is the force that opposes motion between two surfaces in contact.',
      chapterTitle: 'Friction',
      topic: 'Force',
      concept: 'Contact forces',
      grade: '8',
      subject: 'science',
    }),
    scienceChapterId,
  );

  // Right words, WRONG SUBJECT. This is what the hard filter is for.
  await insertRagChunk(
    postgres.client,
    makeRagChunk('wrong-subject', {
      chunkText: 'Photosynthesis rates can be plotted on a graph to show sunlight against food made.',
      topic: 'Photosynthesis',
      grade: '8',
      subject: 'mathematics',
      chapterTitle: 'Data Handling',
    }),
    mathsChapterId,
  );

  // A Hindi chunk, so the generated column's language CASE is exercised rather
  // than merely present. Postgres has no Hindi stemmer, hence 'simple' (D-040).
  await insertRagChunk(
    postgres.client,
    makeRagChunk('hindi', {
      chunkText: 'प्रकाश संश्लेषण वह प्रक्रिया है जिससे हरे पौधे भोजन बनाते हैं।',
      chapterTitle: 'फसल उत्पादन',
      topic: 'प्रकाश संश्लेषण',
      language: 'hi',
      grade: '8',
      subject: 'science',
    }),
    scienceChapterId,
  );

  // A chunk with NO EMBEDDING — the D-078 case. It must be invisible to vector
  // search and findable by full-text search.
  await postgres.client.query(
    `insert into rag_chunks (
       chapter_id, chunk_text, grade, subject, chapter_number, chapter_title,
       topic, language, embedding, embedding_model
     ) values ($1, $2, '8', 'science', 1, 'Crop Production and Management',
       'Photosynthesis', 'en', null, 'voyage-3')`,
    [
      scienceChapterId,
      'Chlorophyll absorbs sunlight during photosynthesis and gives leaves their colour.',
    ],
  );
}, 180_000);

afterAll(async () => {
  await postgres.stop();
});

describe('the VECTOR path', () => {
  it('returns the semantically nearest chunk first for a real question', async () => {
    const result = await postgres.client.query<{ topic: string; distance: string }>(
      `select topic, (embedding <=> $1::vector)::text as distance
         from rag_chunks
        where is_active and grade = '8' and subject = 'science' and embedding is not null
        order by embedding <=> $1::vector
        limit 3`,
      [toVectorLiteral(makeEmbedding(QUERY_SEED))],
    );

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0]?.topic).toBe('Photosynthesis');
    // The winner is the exact vector, so cosine distance is zero — which also
    // confirms the operator is cosine and not L2, since the two disagree on
    // everything except an exact match.
    expect(Number(result.rows[0]?.distance)).toBeCloseTo(0, 6);
  });

  it('hard-filters by grade and subject, so the right words in the wrong subject lose', async () => {
    // §8.4 step 3. Without the filter the maths chunk about plotting
    // photosynthesis rates is a perfectly good lexical match and a plausible
    // vector one, and a Grade 8 science student is shown a data-handling
    // exercise.
    const result = await postgres.client.query<{ subject: string }>(
      `select subject from rag_chunks
        where is_active and grade = '8' and subject = 'science' and embedding is not null
        order by embedding <=> $1::vector
        limit 10`,
      [toVectorLiteral(makeEmbedding(QUERY_SEED))],
    );

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.subject === 'science')).toBe(true);
  });

  it('cannot see a chunk with no embedding, which is why the ids are reported', async () => {
    /**
     * D-078 made concrete. The chunks that arrived without a vector are not
     * broken and not dropped — they are simply INVISIBLE to this path, silently,
     * and would read as a thin corpus rather than as a missing input. That is
     * exactly why the import lists their ids instead of logging a count.
     */
    const vector = await postgres.client.query(
      `select id from rag_chunks
        where grade = '8' and subject = 'science' and embedding is not null`,
    );
    const all = await postgres.client.query(
      `select id from rag_chunks where grade = '8' and subject = 'science'`,
    );

    expect(all.rows.length).toBe(vector.rows.length + 1);
  });
});

describe('the FULL-TEXT path', () => {
  it('finds the chunk a student would be asking about, ranked', async () => {
    const result = await postgres.client.query<{ topic: string; rank: string }>(
      `select topic, ts_rank(search_vector, websearch_to_tsquery('english', $1))::text as rank
         from rag_chunks
        where is_active and grade = '8' and subject = 'science'
          and search_vector @@ websearch_to_tsquery('english', $1)
        order by ts_rank(search_vector, websearch_to_tsquery('english', $1)) desc
        limit 5`,
      ['photosynthesis food plants'],
    );

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0]?.topic).toBe('Photosynthesis');
    expect(Number(result.rows[0]?.rank)).toBeGreaterThan(0);
    // The friction chunk shares none of those words and must not appear.
    expect(result.rows.map((row) => row.topic)).not.toContain('Force');
  });

  it('DOES find the chunk that has no embedding', async () => {
    // The other half of the D-078 story, and the reason those chunks are
    // imported rather than skipped: they are unreachable by one path and
    // perfectly reachable by the other.
    const result = await postgres.client.query<{ chunk_text: string }>(
      `select chunk_text from rag_chunks
        where embedding is null and search_vector @@ websearch_to_tsquery('english', $1)`,
      ['chlorophyll sunlight'],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.chunk_text).toContain('Chlorophyll');
  });

  it('weights the heading fields above the body', async () => {
    // D-040: chapter_title/topic/concept are setweight 'A', the body 'B'. A
    // query matching a heading should outrank one matching only prose, which is
    // what makes a topic search behave like a topic search.
    const result = await postgres.client.query<{ weighted: boolean }>(
      `select search_vector @@ to_tsquery('english', 'photosynthesis:A') as weighted
         from rag_chunks
        where topic = 'Photosynthesis' and language = 'en' and embedding is not null`,
    );

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.weighted)).toBe(true);
  });

  it('indexes Hindi with the simple configuration, since Postgres has no Hindi stemmer', async () => {
    const result = await postgres.client.query<{ chunk_text: string }>(
      `select chunk_text from rag_chunks
        where language = 'hi' and search_vector @@ to_tsquery('simple', $1)`,
      ['भोजन'],
    );

    expect(result.rows).toHaveLength(1);
  });

  it('never lets search_vector be written directly', async () => {
    // GENERATED ALWAYS, so the corpus import must not map the source column of
    // the same name (D-040). A hand-maintained tsvector goes stale the first
    // time somebody edits chunk_text, and a stale tsvector does not fail — the
    // chunk simply stops appearing in keyword search, forever, silently.
    await expect(
      postgres.client.query(
        `insert into rag_chunks (chunk_text, grade, subject, search_vector)
           values ('x', '8', 'science', to_tsvector('english', 'x'))`,
      ),
    ).rejects.toThrow(/cannot insert a non-DEFAULT value into column "search_vector"/i);
  });

  it('regenerates search_vector when chunk_text changes', async () => {
    const inserted = await postgres.client.query<{ id: string }>(
      `insert into rag_chunks (chunk_text, grade, subject, language)
         values ('Initial text about magnets.', '8', 'science', 'en') returning id`,
    );
    const id = inserted.rows[0]?.id ?? '';

    await postgres.client.query(`update rag_chunks set chunk_text = $2 where id = $1`, [
      id,
      'Revised text about electricity.',
    ]);

    const after = await postgres.client.query<{ matches_new: boolean; matches_old: boolean }>(
      `select search_vector @@ to_tsquery('english', 'electricity') as matches_new,
              search_vector @@ to_tsquery('english', 'magnets') as matches_old
         from rag_chunks where id = $1`,
      [id],
    );

    expect(after.rows[0]?.matches_new).toBe(true);
    expect(after.rows[0]?.matches_old).toBe(false);
  });
});

describe('the three indexes the corpus import depends on', () => {
  it('has HNSW on the embedding, cosine, m=16 ef_construction=128', async () => {
    /**
     * D-040/D-041. The parameters are asserted, not just the index's existence:
     * `vector_l2_ops` instead of `vector_cosine_ops` would still be an index and
     * would still be used, and would rank by a different metric than the one the
     * query orders by — so the plan looks healthy and the results are wrong.
     */
    const result = await postgres.client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and indexname = 'rag_chunks_embedding_hnsw'`,
    );

    const definition = result.rows[0]?.indexdef ?? '';
    expect(definition).toContain('USING hnsw');
    expect(definition).toContain('vector_cosine_ops');
    expect(definition).toContain("m='16'");
    expect(definition).toContain("ef_construction='128'");
  });

  it('has a GIN index on the generated search_vector', async () => {
    const result = await postgres.client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and indexname = 'rag_chunks_search_vector_gin'`,
    );

    expect(result.rows[0]?.indexdef).toContain('USING gin');
  });

  it('has the (grade, subject) filter index, partial on is_active', async () => {
    // Partial on purpose, and asymmetric with the HNSW index on purpose: the
    // filter index can afford to fall back to a scan and the vector index cannot
    // (D-041).
    const result = await postgres.client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and indexname = 'rag_chunks_grade_subject_idx'`,
    );

    const definition = result.rows[0]?.indexdef ?? '';
    expect(definition).toContain('grade');
    expect(definition).toContain('subject');
    expect(definition).toContain('WHERE is_active');
  });

  it('has an index on chapter_id, so deleting a chapter does not scan the corpus', async () => {
    // D-042: an unindexed foreign key makes every `delete from chapters`
    // sequentially scan rag_chunks to apply the cascade.
    const result = await postgres.client.query(
      `select 1 from pg_indexes
        where schemaname = 'public' and indexname = 'rag_chunks_chapter_idx'`,
    );

    expect(result.rows).toHaveLength(1);
  });
});

describe('the chapter link the import backfills', () => {
  it('joins a chunk to its chapter by the normalised (grade, subject, number) triple', async () => {
    /**
     * The join the import performs, run here so the SQL that will do it is
     * exercised against real constraints. It is also the assertion behind
     * "every imported chunk has a chapter_id": the triple is the only link the
     * five source tables share (D-077 follow-up), so if this join does not work
     * the import has no linkage at all.
     */
    const result = await postgres.client.query<{ linked: string }>(
      `select count(*)::text as linked
         from rag_chunks c
         join chapters ch
           on ch.grade = c.grade
          and ch.subject_code = c.subject
          and ch.chapter_number = c.chapter_number
        where c.chapter_id = ch.id and c.subject = 'science'`,
    );

    expect(Number(result.rows[0]?.linked)).toBeGreaterThan(0);
  });

  it('keeps chapter_id nullable, so an off-syllabus chunk is not lost', async () => {
    // 0002's header: a chunk whose chapter is not in the syllabus table is still
    // retrievable content and must not be lost to a NOT NULL.
    await expect(
      postgres.client.query(
        `insert into rag_chunks (chunk_text, grade, subject, chapter_number)
           values ('Orphan content.', '8', 'science', 99)`,
      ),
    ).resolves.toBeDefined();
  });
});
