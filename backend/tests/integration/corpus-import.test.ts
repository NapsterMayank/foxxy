import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../helpers/postgres';
import { writeFixtureExtract, type FixtureExtractShape } from '../fixtures/corpus-extract';
import { importCorpus } from '../../scripts/import-corpus';
import { corpusId } from '../../src/shared/corpus/deterministic-id';
import { MIN_QUESTIONS_FOR_RESERVE } from '../../src/shared/corpus/held-out-reserve';

/**
 * THE CORPUS IMPORT, END TO END, AGAINST REAL POSTGRES.
 *
 * ===========================================================================
 * WHAT THIS FILE COVERS THAT THE UNIT TESTS CANNOT.
 *
 * `src/shared/corpus/` is pure and thoroughly tested, and every DECISION the
 * import makes is tested there. None of that says anything about whether the
 * decisions reach the database intact. The gap between "the plan says this
 * question is eligible" and "this question is a row that satisfies
 * `questions_options_check`" is exactly where an import fails, and it is only
 * visible against a real server:
 *
 *  - the four-option CHECK, the `correct_index` range, the grade domain — all
 *    constraints, none of them expressible in TypeScript;
 *  - `search_vector`, which is GENERATED and must NOT be written (D-040);
 *  - `vector(1024)`, which rejects a mis-parsed embedding at insert time;
 *  - both retrieval paths, which need real indexes and a real planner.
 *
 * ===========================================================================
 * IT RUNS OVER A SYNTHETIC EXTRACT, ON PURPOSE.
 *
 * See the header of `tests/fixtures/corpus-extract.ts`. The real 77 MB extract
 * is gitignored and exists on one machine; `corpus-import-real.test.ts` covers
 * it where it is present. This file has to run everywhere, so it writes its own
 * extract with the source's RAW spellings — `'Grade 6'`/`'Mathematics'` on
 * chunks, `'6'`/`'math'` on questions, and the hybrid on `concept_graph` — and
 * asserts they converge on ONE chapter.
 */

let db: TestPostgres;
let fixture: FixtureExtractShape;

async function count(sql: string, params: readonly unknown[] = []): Promise<number> {
  const { rows } = await db.client.query<{ readonly n: string }>(sql, [...params]);
  return Number(rows[0]?.n ?? '0');
}

/**
 * A content-only digest of the whole database.
 *
 * Every column that carries meaning, ordered by id so the digest cannot depend
 * on physical row order. `updated_at` is deliberately EXCLUDED: an upsert
 * touches it by design, and including it would make the idempotency assertion
 * fail for the one reason that is not a defect.
 */
async function fingerprint(): Promise<string> {
  const { rows } = await db.client.query<{ readonly digest: string }>(`
    select md5(string_agg(part, '' order by part)) as digest from (
      select id::text || grade || subject_code || chapter_number::text || title_en as part
        from chapters
      union all
      select id::text || chapter_id::text || question_text || options::text
             || correct_index::text || explanation || difficulty || bloom_level
             || is_held_out::text || is_active::text
        from questions
      union all
      select id::text || coalesce(chapter_id::text, '-') || chunk_text || chunk_index::text
             || grade || subject || coalesce(embedding::text, 'NULL')
             || coalesce(embedding_model, '-') || search_vector::text
        from rag_chunks
      union all
      select id::text || chapter_id::text || title_en || coalesce(explanation_en, '-')
             || coalesce(title_hi, '-') || common_mistakes::text
        from chapter_concepts
      union all
      select id::text || chapter_id::text || concept_code || prerequisite_codes::text
             || coalesce(bloom_level, '-')
        from concept_graph
      union all
      select id::text || subject_code || pattern_code || coalesce(description, '-')
             || is_orphan::text || coalesce(detection_rule::text, '-')
        from misconception_patterns
    ) parts
  `);

  const digest = rows[0]?.digest;
  if (digest === undefined) {
    throw new Error('fingerprint returned nothing — the content tables are empty');
  }
  return digest;
}

beforeAll(async () => {
  db = await startTestPostgres();
  // DISCOVERED, never listed (D-046, D-075). A hardcoded list here is how a
  // whole suite once ran against a schema missing a table.
  await applyAllMigrations(db.client);
  fixture = writeFixtureExtract();
  await importCorpus(db.client, fixture.dir);
}, 180_000);

afterAll(async () => {
  await db.stop();
});

describe('normalisation — the three source spellings converge on one chapter', () => {
  it('creates exactly two chapters from five differently-spelled sources', async () => {
    // Chunks say 'Grade 6'/'Mathematics', questions say '6'/'math', the graph
    // says 'Grade 6'/'math'. Unnormalised these are three chapters, the chunks
    // link to one with no questions, and both halves look present.
    expect(await count('select count(*)::text as n from chapters')).toBe(2);
  });

  it('stores the canonical grade and subject, never the source spelling', async () => {
    const { rows } = await db.client.query<{ readonly grade: string; readonly subject: string }>(
      'select grade, subject_code as subject from chapters order by grade, subject_code',
    );
    expect(rows).toEqual([
      { grade: '6', subject: 'mathematics' },
      { grade: '7', subject: 'science' },
    ]);
  });

  it('puts the chunks and the questions under the SAME chapter row', async () => {
    const shared = await count(`
      select count(*)::text as n from chapters c
      where exists (select 1 from rag_chunks r where r.chapter_id = c.id)
        and exists (select 1 from questions q where q.chapter_id = c.id)
        and exists (select 1 from concept_graph g where g.chapter_id = c.id)
        and exists (select 1 from chapter_concepts k where k.chapter_id = c.id)
    `);
    expect(shared).toBe(2);
  });

  it('collapses both embedding-model labels onto one', async () => {
    const { rows } = await db.client.query<{ readonly embedding_model: string | null }>(
      'select distinct embedding_model from rag_chunks order by 1',
    );
    // 'voyage-3' and 'voyage/voyage-3' in, one label out. NULL is the chunk
    // that has no vector — its model is unknown, not assumed.
    expect(rows.map((row) => row.embedding_model)).toEqual(['voyage-3', null]);
  });

  it('admits no grade outside the pilot range', async () => {
    expect(
      await count("select count(*)::text as n from chapters where grade not in ('6','7','8','9','10')"),
    ).toBe(0);
    expect(
      await count("select count(*)::text as n from rag_chunks where grade not in ('6','7','8','9','10')"),
    ).toBe(0);
  });
});

describe('exclusions — the unusable questions are named, not dropped', () => {
  it('imports only the eligible questions', async () => {
    expect(await count('select count(*)::text as n from questions')).toBe(
      fixture.eligibleQuestionCount,
    );
  });

  it('leaves every excluded question out of the database, by derived id', async () => {
    // The optionless question is the 1,045-row case in the real extract. It
    // cannot be answered, cannot be scored, and violates the four-option CHECK
    // — so it must be absent, and absent by ID rather than by a text match that
    // would also pass if the row were present under a different stem.
    for (const index of [1, 2, 3, 4]) {
      const sourceId = `a3000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
      expect(
        await count('select count(*)::text as n from questions where id = $1', [
          corpusId('question', sourceId),
        ]),
      ).toBe(0);
    }
  });

  it('writes the exclusions to a file with a reason for each', () => {
    const lines = readFileSync(resolve(fixture.dir, 'reports/excluded-questions.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { readonly id: string; readonly reason: string });

    expect(lines).toHaveLength(fixture.excludedQuestionCount);
    // A number in a log line cannot be fed back into the regeneration job that
    // has to target exactly these ids; a file can.
    expect(lines.map((entry) => entry.reason).sort()).toEqual([
      'bloom-level-invalid',
      'grade-outside-pilot',
      'options-not-distinct',
      'options-wrong-count',
    ]);
    for (const entry of lines) {
      expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('stores the British Bloom spelling for questions the source spelled American', async () => {
    // 735 real questions say `analyze`. Rejecting them would have dropped a
    // quarter of the importable bank over a spelling (D-098).
    const british = await count(
      "select count(*)::text as n from questions where bloom_level = 'analyse'",
    );
    const american = await count(
      "select count(*)::text as n from questions where bloom_level = 'analyze'",
    );
    expect(british).toBeGreaterThan(0);
    expect(american).toBe(0);
  });

  it('maps the integer difficulty scale onto the three ordinal rungs', async () => {
    const { rows } = await db.client.query<{ readonly difficulty: string }>(
      'select distinct difficulty from questions order by 1',
    );
    expect(rows.map((row) => row.difficulty).sort()).toEqual(['easy', 'hard', 'medium']);
  });
});

describe('the held-out reserve is per chapter and never global', () => {
  it('reserves about 30% of the chapter that can afford it', async () => {
    const chapterId = corpusId('chapter', fixture.reserveChapterKey);
    const total = await count('select count(*)::text as n from questions where chapter_id = $1', [
      chapterId,
    ]);
    const held = await count(
      'select count(*)::text as n from questions where chapter_id = $1 and is_held_out',
      [chapterId],
    );

    expect(total).toBeGreaterThanOrEqual(MIN_QUESTIONS_FOR_RESERVE);
    expect(held).toBe(Math.ceil(total * 0.3));
  });

  it('reserves NOTHING in a chapter below the threshold', async () => {
    /**
     * Below 15 questions the answer is "none", not "fewer". Reserving one or two
     * anyway is worse in both directions at once: it takes questions from a
     * chapter that already has too few to practise, and a two-question mastery
     * check measures nothing — the cost is paid and the benefit is not received.
     */
    const chapterId = corpusId('chapter', fixture.thinChapterKey);
    const total = await count('select count(*)::text as n from questions where chapter_id = $1', [
      chapterId,
    ]);
    const held = await count(
      'select count(*)::text as n from questions where chapter_id = $1 and is_held_out',
      [chapterId],
    );

    expect(total).toBeLessThan(MIN_QUESTIONS_FOR_RESERVE);
    expect(held).toBe(0);
  });

  it('NEVER releases a question that is already held out', async () => {
    /**
     * The one decision here that cannot be undone. A question that has been
     * served in practice may have been memorised and can never measure anything
     * again — there is no cleanup and no recovery.
     *
     * So a question is held out by hand, outside any plan, and the import is
     * re-run. A last-slice reserve would recompute and release it. Both guards
     * have to hold: the plan is given the current reserve, and the SQL OR-s
     * rather than assigns.
     */
    const chapterId = corpusId('chapter', fixture.thinChapterKey);
    const { rows } = await db.client.query<{ readonly id: string }>(
      'update questions set is_held_out = true where chapter_id = $1 returning id::text as id',
      [chapterId],
    );
    expect(rows.length).toBeGreaterThan(0);

    await importCorpus(db.client, fixture.dir);

    const stillHeld = await count(
      'select count(*)::text as n from questions where chapter_id = $1 and is_held_out',
      [chapterId],
    );
    expect(stillHeld).toBe(rows.length);
  });
});

describe('both retrieval paths return rows against real indexes', () => {
  it('returns nearest neighbours through the vector path', async () => {
    /**
     * `enable_seqscan = off` because at this scale the planner correctly prefers
     * an exact sort, and a test that lets it do so says nothing whatever about
     * the HNSW index it claims to be exercising (D-041, D-049). `ef_search` is
     * set inside the transaction because `SET LOCAL` outside one is a silent
     * no-op that warns and does nothing (D-049).
     */
    await db.client.query('begin');
    try {
      await db.client.query('set local enable_seqscan = off');
      await db.client.query('set local hnsw.ef_search = 100');

      const { rows } = await db.client.query<{
        readonly id: string;
        readonly distance: string;
      }>(`
        with probe as (select embedding from rag_chunks where embedding is not null limit 1)
        select r.id::text as id, (r.embedding <=> p.embedding)::text as distance
        from rag_chunks r, probe p
        where r.embedding is not null
        order by r.embedding <=> p.embedding
        limit 5
      `);

      expect(rows.length).toBe(5);
      // The nearest neighbour of a chunk is itself, at distance 0. Anything else
      // means the vector did not survive the round trip through the text form.
      expect(Number(rows[0]?.distance)).toBeCloseTo(0, 6);
      const distances = rows.map((row) => Number(row.distance));
      expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    } finally {
      await db.client.query('commit');
    }
  });

  it('returns matches through the full-text path', async () => {
    const { rows } = await db.client.query<{ readonly rank: string; readonly text: string }>(`
      select ts_rank_cd(search_vector, q)::text as rank, chunk_text as text
      from rag_chunks, websearch_to_tsquery('english', 'place value of a digit') q
      where search_vector @@ q and grade = '6' and subject = 'mathematics' and is_active
      order by ts_rank_cd(search_vector, q) desc
      limit 5
    `);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.text).toContain('place value');
    expect(Number(rows[0]?.rank)).toBeGreaterThan(0);
  });

  it('generates search_vector for every chunk, including the one with no embedding', async () => {
    // GENERATED ALWAYS, never written by the import (D-040). The chunk with no
    // vector is invisible to the dense path and must stay reachable by the
    // sparse one, which is the entire reason it was imported rather than dropped.
    expect(await count('select count(*)::text as n from rag_chunks where search_vector is null')).toBe(0);
    expect(
      await count('select count(*)::text as n from rag_chunks where embedding is null'),
    ).toBeGreaterThan(0);
  });

  it('gives every chunk a chapter to hang off', async () => {
    expect(await count('select count(*)::text as n from rag_chunks where chapter_id is null')).toBe(0);
  });
});

describe('running the import twice produces an identical database', () => {
  it('has the same content digest before and after a re-run', async () => {
    const before = await fingerprint();
    await importCorpus(db.client, fixture.dir);
    const after = await fingerprint();

    // The property that makes this true: every id is a deterministic UUIDv5 of
    // its source id, so `ON CONFLICT (id) DO UPDATE` rewrites the row it wrote
    // last time instead of inserting a second copy beside it.
    expect(after).toBe(before);
  });

  it('does not grow any table on a re-run', async () => {
    const tables = [
      'chapters',
      'questions',
      'rag_chunks',
      'chapter_concepts',
      'concept_graph',
      'misconception_patterns',
    ] as const;

    const before: number[] = [];
    for (const table of tables) {
      before.push(await count(`select count(*)::text as n from ${table}`));
    }

    await importCorpus(db.client, fixture.dir);

    for (const [index, table] of tables.entries()) {
      expect(await count(`select count(*)::text as n from ${table}`)).toBe(before[index]);
    }
  });
});

describe('the pedagogy tables land with their carried-over columns', () => {
  it('keeps the concept prose, the Hindi title and the common-mistake list', async () => {
    const { rows } = await db.client.query<{
      readonly title_hi: string | null;
      readonly key_formula: string | null;
      readonly common_mistakes: readonly string[];
      readonly slug: string | null;
      readonly concept_number: number | null;
    }>(
      `select title_hi, key_formula, common_mistakes, slug, concept_number
         from chapter_concepts where title_en = 'Place value'`,
    );

    expect(rows[0]?.title_hi).toBe('स्थानीय मान');
    expect(rows[0]?.slug).toBe('place-value');
    expect(rows[0]?.concept_number).toBe(1);
    expect(rows[0]?.common_mistakes).toEqual([
      'Ignoring a zero placeholder',
      'Reading digits right to left',
    ]);
  });

  it('keeps prerequisite codes as codes, with no foreign key to invent', async () => {
    const { rows } = await db.client.query<{
      readonly prerequisite_codes: readonly string[];
      readonly cognitive_load: number | null;
    }>("select prerequisite_codes, cognitive_load from concept_graph where concept_code = 'math_6_ch1'");

    // `math_6_ch0` does not exist. The edge is kept anyway: a dangling
    // prerequisite is a fact about the source, and a foreign key here would
    // have silently deleted the relationship instead of recording it.
    expect(rows[0]?.prerequisite_codes).toEqual(['math_6_ch0']);
    expect(rows[0]?.cognitive_load).toBe(2);
  });

  it('imports an orphan misconception, flagged rather than dropped', async () => {
    const { rows } = await db.client.query<{
      readonly pattern_code: string;
      readonly is_orphan: boolean;
    }>('select pattern_code, is_orphan from misconception_patterns order by pattern_code');

    expect(rows).toEqual([
      { pattern_code: 'PHOTO.LIGHT.ONLY', is_orphan: true },
      { pattern_code: 'PLACE.VALUE.ZERO', is_orphan: false },
    ]);
  });

  it('skips a misconception whose subject is outside the pilot vocabulary', async () => {
    // No grade column exists on that source table, so subject is the only scope
    // there is — and an unrecognised one is a skip, never a guess.
    expect(
      await count("select count(*)::text as n from misconception_patterns where subject_code = 'history_sr'"),
    ).toBe(0);
  });
});
