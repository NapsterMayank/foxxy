import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '../../src/platform/clock/index';
import { createDeterministicEmbed } from '../../src/platform/embed/index';
import { createDbPools, type DbPools } from '../../src/platform/db/index';
import { FakeLogger } from '../../src/platform/logger/index';
import { parseConfig } from '../../src/platform/config/load-config';
import { createRetrievalModule, type RetrievalService } from '../../src/modules/retrieval/index';
import type { RetrievedChunkRecord } from '../../src/modules/retrieval/index';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../helpers/postgres';
import {
  insertChapter,
  insertRagChunk,
  makeChapter,
  makeEmbedding,
  makeRagChunk,
  toVectorLiteral,
} from '../fixtures/index';

/**
 * =============================================================================
 * THE RETRIEVAL PIPELINE AGAINST A REAL POSTGRES.
 *
 * The service unit tests fake both halves and own the orchestration. This file
 * owns everything only a real database can say:
 *
 *   · the hard grade/subject filter is in the QUERY, so a grade 7 question can
 *     never surface grade 9 content;
 *   · `hnsw.ef_search` is high enough that a top-50 ask returns 50 (D-041/D-049)
 *     — proved through THIS module's own dense query, not a hand-written one;
 *   · the 20 NULL-embedding chunks (D-078) are reachable by full text and never
 *     crash vector search;
 *   · the generated `search_vector`, the language CASE and `websearch_to_tsquery`
 *     agree with each other.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY: anything about retrieval QUALITY. The
 * embeddings here are deterministic synthetic vectors with no semantics
 * (D-047), so "the right chunk won" is a statement about the plumbing. The
 * §8.4 threshold must be calibrated against the real corpus with real query
 * embeddings — see `eval/retrieval/` and `domain/abstain-threshold.ts`.
 * =============================================================================
 */

const TOP_N_CANDIDATES = 50;
const PGVECTOR_DEFAULT_EF_SEARCH = 40;
/** Comfortably more than the top-50 ask, so a short result can only be the index. */
const GRADE_9_CHUNK_COUNT = 120;

let postgres: TestPostgres;
let pools: DbPools;
let service: RetrievalService;
let grade7ChapterId: string;

/** `content.getChunksByIds`, as the composition root will bind it — via SQL. */
async function readChunks(ids: readonly string[]): Promise<RetrievedChunkRecord[]> {
  if (ids.length === 0) return [];
  const result = await postgres.client.query<{
    id: string;
    chapter_id: string | null;
    chunk_text: string;
    chunk_index: number;
    grade: string;
    subject: string;
    chapter_number: number | null;
    chapter_title: string | null;
    topic: string | null;
    concept: string | null;
    language: string | null;
    quality_score: number | null;
  }>(
    `select id, chapter_id, chunk_text, chunk_index, grade, subject, chapter_number,
            chapter_title, topic, concept, language, quality_score
       from rag_chunks
      where id = any($1::uuid[]) and is_active
      -- DELIBERATELY REVERSED relative to the ranking, to stand in for the
      -- arbitrary order a real IN-list query produces (D-060). If retrieval
      -- ever starts trusting this order, the re-rank assertions below fail.
      order by id desc`,
    [[...ids]],
  );
  return result.rows.map((row) => ({
    id: row.id,
    chapterId: row.chapter_id,
    chunkText: row.chunk_text,
    chunkIndex: row.chunk_index,
    grade: row.grade as RetrievedChunkRecord['grade'],
    subject: row.subject,
    chapterNumber: row.chapter_number,
    chapterTitle: row.chapter_title,
    topic: row.topic,
    concept: row.concept,
    language: row.language ?? 'en',
    qualityScore: row.quality_score,
  }));
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await applyAllMigrations(postgres.client);

  grade7ChapterId = await insertChapter(
    postgres.client,
    makeChapter('sci-7-1', { grade: '7', subjectCode: 'science', chapterNumber: 1 }),
  );
  const grade9ChapterId = await insertChapter(
    postgres.client,
    makeChapter('sci-9-1', { grade: '9', subjectCode: 'science', chapterNumber: 1 }),
  );
  const mathsChapterId = await insertChapter(
    postgres.client,
    makeChapter('math-7-1', { grade: '7', subjectCode: 'mathematics', chapterNumber: 1 }),
  );

  // --- Grade 7 science: the content a grade 7 question may see ------------
  //
  // `makeEmbedding(<query text>)` is the SAME generator the deterministic
  // embed port uses, so this chunk's vector IS the query vector and its cosine
  // distance is exactly zero. That is what makes "the nearest chunk wins"
  // assertable rather than approximate.
  await insertRagChunk(
    postgres.client,
    makeRagChunk('g7-target', {
      chunkText:
        'Heat flows from a hotter body to a colder body. A clinical thermometer measures body temperature.',
      chapterTitle: 'Heat',
      topic: 'Temperature',
      concept: 'Thermometers',
      embedding: makeEmbedding('how does a thermometer measure temperature'),
      grade: '7',
      subject: 'science',
    }),
    grade7ChapterId,
  );

  await insertRagChunk(
    postgres.client,
    makeRagChunk('g7-second', {
      chunkText:
        'Conduction, convection and radiation are the three modes by which heat is transferred.',
      chapterTitle: 'Heat',
      topic: 'Heat transfer',
      grade: '7',
      subject: 'science',
    }),
    grade7ChapterId,
  );

  // THE D-078 CASE: a chunk with NO embedding. Invisible to the dense half,
  // perfectly reachable by the sparse one. Its ids are reported by the import
  // precisely because this asymmetry is silent.
  await postgres.client.query(
    `insert into rag_chunks (chapter_id, chunk_text, grade, subject, chapter_number,
                             chapter_title, topic, language, embedding, embedding_model)
     values ($1, $2, '7', 'science', 1, 'Heat', 'Temperature', 'en', null, 'voyage-3')`,
    [
      grade7ChapterId,
      'A laboratory thermometer has a longer range than a clinical thermometer and measures temperature in degrees Celsius.',
    ],
  );

  // TWO EXACT DUPLICATES of one passage — D-108 at test scale.
  for (const seed of ['g7-dup-a', 'g7-dup-b']) {
    await insertRagChunk(
      postgres.client,
      makeRagChunk(seed, {
        chunkText: 'The normal temperature of the human body is 37 degrees Celsius.',
        chapterTitle: 'Heat',
        topic: 'Body temperature',
        grade: '7',
        subject: 'science',
      }),
      grade7ChapterId,
    );
  }

  // --- Grade 9 science: the SAME WORDS, the wrong grade -------------------
  //
  // Lexically a perfect match and, at seed scale, a plausible vector one. This
  // is the row the hard filter exists for.
  await insertRagChunk(
    postgres.client,
    makeRagChunk('g9-trap', {
      chunkText:
        'A thermometer measures temperature; the kinetic theory explains heat as molecular motion.',
      chapterTitle: 'Matter in Our Surroundings',
      topic: 'Temperature',
      embedding: makeEmbedding('how does a thermometer measure temperature'),
      grade: '9',
      subject: 'science',
    }),
    grade9ChapterId,
  );

  // Bulk grade 9 rows, so a top-50 ask has more than 50 to choose from.
  for (let index = 0; index < GRADE_9_CHUNK_COUNT; index += 1) {
    await insertRagChunk(
      postgres.client,
      makeRagChunk(`g9-${String(index)}`, {
        chunkIndex: index,
        chunkText: `Grade nine science passage number ${String(index)} about matter and motion.`,
        grade: '9',
        subject: 'science',
      }),
      grade9ChapterId,
    );
  }

  // --- Grade 7 MATHS: right grade, wrong subject --------------------------
  await insertRagChunk(
    postgres.client,
    makeRagChunk('math-trap', {
      chunkText: 'Plot temperature against time on a graph and read the thermometer values.',
      chapterTitle: 'Data Handling',
      topic: 'Temperature',
      embedding: makeEmbedding('how does a thermometer measure temperature'),
      grade: '7',
      subject: 'mathematics',
    }),
    mathsChapterId,
  );

  const config = parseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: postgres.url,
    REDIS_URL: 'redis://localhost:6379',
    CORS_READ_ORIGINS: 'http://localhost:3000',
    CORS_WRITE_ORIGINS: 'http://localhost:3000',
    SESSION_COOKIE_NAME: 'foxxy_session',
    APP_URL: 'http://app.test',
    API_URL: 'http://api.test',
  });

  pools = createDbPools({
    url: config.db.url,
    ssl: false,
    sizes: { auth: 2, core: 2, ai: 4, worker: 2 },
    statementTimeoutMs: 15_000,
    vectorStatementTimeoutMs: 15_000,
    connectTimeoutMs: 2_000,
    // FROM CONFIG, not a literal. The value under test is the one a deployment
    // would get; hardcoding 100 would test the number rather than the wiring.
    hnswEfSearch: config.db.hnswEfSearch,
  });

  service = createRetrievalModule({
    // §3.1 — the `ai` pool. `worker` carries `hnsw.ef_search` too, since
    // `buildModules` gives retrieval that pool in the background process; this
    // suite exercises the API-process wiring.
    db: pools.ai,
    embed: createDeterministicEmbed(),
    readChunks,
    clock: new FixedClock(),
    logger: new FakeLogger(),
    /**
     * "NEVER ABSTAIN ON SCORE", EXPLICITLY, AND IT IS NOT A WEAKENING.
     *
     * What this file tests is the SQL: the hard grade/subject filter, the
     * language configuration, `ef_search`, the NULL-embedding rows, hydration.
     * None of that is about the abstention floor.
     *
     * The shipped threshold is MEASURED (0.029877) against the real 4,403-chunk
     * corpus with REAL voyage-3 query embeddings. This suite runs a seeded
     * fixture with `createDeterministicEmbed`, whose vectors carry no semantics
     * at all — so its fused scores are drawn from a completely different
     * distribution and comparing them to that floor would make these assertions
     * pass or fail on the arrangement of a fake. The abstention path has its own
     * coverage: the unit suite for the decision, the golden-set harness for the
     * distributions, and the `no-candidates` case below, which a zero threshold
     * still exercises because it is not a score comparison.
     */
    threshold: {
      value: 0,
      candidateLimit: 50,
      provenance: {
        state: 'UNCALIBRATED',
        reason:
          'integration fixture — deterministic embeddings produce fused scores on a ' +
          'different distribution from the measured one, so the SQL is what is under test',
      },
    },
  }).service;
}, 180_000);

afterAll(async () => {
  await pools.close();
  await postgres.stop();
}, 60_000);

describe('the hard filter — a grade 7 query never returns grade 9 content', () => {
  it('returns only grade 7 science, with the trap rows present and losing', async () => {
    const result = await service.search('how does a thermometer measure temperature', {
      grade: '7',
      subject: 'science',
      topN: 10,
    });

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks.every((chunk) => chunk.grade === '7')).toBe(true);
    expect(result.chunks.every((chunk) => chunk.subject === 'science')).toBe(true);
    // Both traps exist and are excellent matches. Neither is reachable.
    expect(result.trace.finalChunkIds.length).toBeGreaterThan(0);
  });

  it('excludes the wrong grade from the CANDIDATES, not just from the answer', async () => {
    /**
     * The distinction the test exists to make. Post-filtering a top-50 would
     * be intermittently wrong: the 50 nearest chunks corpus-wide are mostly
     * grade 9 here, so a filter applied afterwards returns two or three rows
     * and reads as thin content rather than as a bug.
     */
    const result = await service.search('how does a thermometer measure temperature', {
      grade: '7',
      subject: 'science',
      topN: 10,
    });

    const grade7Ids = await postgres.client.query<{ id: string }>(
      `select id from rag_chunks where grade = '7' and subject = 'science'`,
    );
    const allowed = new Set(grade7Ids.rows.map((row) => row.id));

    for (const candidate of [...result.trace.denseCandidates, ...result.trace.sparseCandidates]) {
      expect(allowed.has(candidate.id)).toBe(true);
    }
  });

  it('returns nothing at all for a grade with no content, and abstains', async () => {
    const result = await service.search('how does a thermometer measure temperature', {
      grade: '12',
      subject: 'science',
    });

    expect(result.shouldAbstain).toBe(true);
    expect(result.chunks).toEqual([]);
    expect(result.trace.abstainReason).toBe('no-candidates');
  });
});

describe('ef_search is 100 — proved by a top-50 request returning 50', () => {
  it('the ai pool carries the setting as a startup parameter', async () => {
    const result = await pools.ai.pool.query<{ ef: string }>(
      `select current_setting('hnsw.ef_search') as ef`,
    );

    expect(result.rows[0]?.ef).toBe('100');
    expect(Number(result.rows[0]?.ef)).toBeGreaterThanOrEqual(TOP_N_CANDIDATES);
  });

  it("THIS MODULE'S dense query returns 50 candidates when 50 exist", async () => {
    // Through the module, not through a hand-written query: what matters is
    // that the query retrieval ACTUALLY ISSUES comes back with 50 rows, not
    // that some query can.
    const result = await service.search('grade nine science passage about matter', {
      grade: '9',
      subject: 'science',
      topN: 3,
    });

    expect(result.trace.denseCandidates).toHaveLength(TOP_N_CANDIDATES);
  });

  it('is still a real cap — 40 at pgvector’s default, on the UNFILTERED shape', async () => {
    /**
     * THE CONTROL, and it deliberately does NOT use retrieval's own filtered
     * query. That is a finding, not a shortcut.
     *
     * MEASURED against the real corpus — 4,686 rows imported, 4,403 active —
     * on 10 August 2026, the
     * FILTERED top-50 vector query — the one this module issues — does not use
     * the HNSW index at all. `EXPLAIN (ANALYZE)` shows a bitmap index scan on
     * `rag_chunks_grade_subject_idx` (553 rows for grade 9 science) feeding an
     * exact top-N heapsort, at 2.4 ms. It returns 50 rows at `ef_search = 40`
     * and 50 at `ef_search = 100`, because after a hard grade+subject filter
     * each partition holds only ~350-720 rows and exact search is simply
     * cheaper than a graph traversal. `enable_seqscan = off` does not change
     * this, and neither does `enable_bitmapscan = off` — both were tried.
     *
     * SO: for retrieval as it stands, D-041's cap does not bite, and a control
     * written against the filtered shape would assert 40, get 50, and be
     * "fixed" by deleting it — taking the real measurement with it.
     *
     * `hnsw.ef_search = 100` stays, as insurance rather than as a fix: it is
     * what keeps the top-50 honest if the filter is ever relaxed, if the corpus
     * grows past the point where exact search wins, or if a future query orders
     * by distance without the partition predicate. This control proves the cap
     * is REAL on the shape that does use the index, so the setting is still
     * measuring something.
     *
     * `set local` inside an EXPLICIT transaction: outside one it is a no-op
     * that only warns, and `enable_seqscan = off` is what forces the index at
     * seed scale (D-049).
     */
    const client = await pools.ai.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local enable_seqscan = off');
      await client.query(`set local hnsw.ef_search = ${String(PGVECTOR_DEFAULT_EF_SEARCH)}`);
      const capped = await client.query<{ id: string }>(
        // The probe vector is a BOUND PARAMETER, not a sub-select. A sub-select
        // in the ORDER BY is not a constant to the planner, which changes the
        // plan and quietly stops the cap being what is measured.
        `select id from rag_chunks
          where embedding is not null
          order by embedding <=> $1::vector
          limit ${String(TOP_N_CANDIDATES)}`,
        [toVectorLiteral(makeEmbedding('ef-probe'))],
      );
      await client.query('commit');

      expect(capped.rows).toHaveLength(PGVECTOR_DEFAULT_EF_SEARCH);
    } finally {
      client.release();
    }
  });
});

describe('the 20 NULL-embedding chunks — D-078', () => {
  it('are reachable by full text', async () => {
    const result = await service.search('laboratory thermometer degrees celsius range', {
      grade: '7',
      subject: 'science',
      topN: 10,
    });

    const texts = result.chunks.map((chunk) => chunk.chunkText);
    expect(texts.some((text) => text.includes('laboratory thermometer'))).toBe(true);
  });

  it('never appear in the dense half, and never crash it', async () => {
    // Without `embedding is not null` in the dense query, pgvector compares
    // against NULL: the distance is NULL and the rows sort to one end,
    // present and unscored, occupying slots.
    const unembedded = await postgres.client.query<{ id: string }>(
      `select id from rag_chunks where embedding is null`,
    );
    const nullIds = new Set(unembedded.rows.map((row) => row.id));
    expect(nullIds.size).toBeGreaterThan(0);

    const result = await service.search('laboratory thermometer degrees celsius', {
      grade: '7',
      subject: 'science',
      topN: 10,
    });

    for (const candidate of result.trace.denseCandidates) {
      expect(nullIds.has(candidate.id)).toBe(false);
    }
    expect(result.trace.sparseCandidates.length).toBeGreaterThan(0);
  });
});

describe('duplicates are collapsed against a real corpus', () => {
  it('returns one copy of a passage present twice, and records the collapse', async () => {
    const result = await service.search('normal temperature of the human body 37 degrees', {
      grade: '7',
      subject: 'science',
      topN: 10,
    });

    const bodyTemperature = result.chunks.filter((chunk) =>
      chunk.chunkText.includes('37 degrees Celsius'),
    );

    expect(bodyTemperature).toHaveLength(1);
    expect(result.trace.duplicatesCollapsed).toBeGreaterThanOrEqual(1);
  });
});

describe('hydration order is never trusted — D-060', () => {
  it('returns fused order even though getChunksByIds sorts by id descending', async () => {
    const result = await service.search('heat transfer conduction convection thermometer', {
      grade: '7',
      subject: 'science',
      topN: 5,
    });

    // The chunks come back in the order retrieval ranked them, which is the
    // order of `finalChunkIds` — not the `order by id desc` the reader used.
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(
      result.trace.finalChunkIds.filter((id) => result.chunks.some((chunk) => chunk.id === id)),
    );
    expect(result.scores).toEqual([...result.scores].sort((left, right) => right - left));
  });
});

describe('the Hindi path', () => {
  it('uses the simple configuration, since Postgres has no Hindi stemmer', async () => {
    const hindiChapter = await insertChapter(
      postgres.client,
      makeChapter('sci-8-hi', { grade: '8', subjectCode: 'science', chapterNumber: 1 }),
    );
    await insertRagChunk(
      postgres.client,
      makeRagChunk('hi-chunk', {
        chunkText: 'प्रकाश संश्लेषण वह प्रक्रिया है जिससे हरे पौधे भोजन बनाते हैं।',
        chapterTitle: 'फसल उत्पादन',
        topic: 'प्रकाश संश्लेषण',
        language: 'hi',
        grade: '8',
        subject: 'science',
      }),
      hindiChapter,
    );

    const result = await service.search('प्रकाश संश्लेषण भोजन', {
      grade: '8',
      subject: 'science',
      topN: 3,
    });

    expect(result.trace.language).toBe('hi');
    expect(result.trace.sparseCandidates.length).toBeGreaterThan(0);
  });
});
