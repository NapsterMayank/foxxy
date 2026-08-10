import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../helpers/postgres';
import { importCorpus } from '../../scripts/import-corpus';
import {
  DEMO_MIN_CHUNKS,
  DEMO_MIN_CONCEPTS,
  DEMO_MIN_QUESTIONS,
  MIN_QUESTIONS_FOR_RESERVE,
} from '../../src/shared/corpus/held-out-reserve';

/**
 * THE REAL EXTRACT, WHERE IT EXISTS.
 *
 * ===========================================================================
 * WHY THIS TEST IS CONDITIONAL, AND WHY THAT IS NOT A COP-OUT.
 *
 * `.corpus-extract/` is 77 MB and gitignored. It exists on the machine the
 * extraction ran on and nowhere else — not on a fresh clone, not on CI. A test
 * that failed in its absence would be a test everyone deletes; a test that
 * passed vacuously in its absence would be worse.
 *
 * So it SKIPS, loudly and by name, and the always-running coverage lives in
 * `corpus-import.test.ts` against a synthetic extract. The division is not
 * arbitrary. That file tests the IMPORTER — normalisation, exclusion, the
 * reserve, both query paths — using data written from the same understanding
 * the importer holds. This file tests something that file structurally cannot:
 * that the understanding still matches THE SOURCE.
 *
 * That is not a hypothetical distinction. Four of the five source shapes were
 * wrong when they were written from reconnaissance notes rather than from the
 * files (D-098), and three failed silently — `concept_name` instead of `title`
 * skipped all 639 concepts while reporting them as rejected-for-no-name. Only a
 * test that reads the real file catches that class of defect, and every number
 * asserted below was measured in the file rather than copied from the manifest.
 */

const EXTRACT_DIR = resolve(process.cwd(), '.corpus-extract');
const HAS_EXTRACT = existsSync(resolve(EXTRACT_DIR, 'chunks.ndjson'));

/**
 * MEASURED IN THE FILES on 10 August 2026, not copied from `manifest.json`.
 *
 * The manifest is the extraction's own account of itself; comparing an import
 * to it and calling that verification checks one side of the extraction twice.
 * These are line counts and predicate counts taken from the NDJSON directly.
 */
const MEASURED = {
  chunks: 4686,
  chunksWithoutEmbedding: 20,
  sourceQuestions: 3791,
  /**
   * 2,741, NOT the 2,746 the brief expected — and the five-row gap is a finding,
   * not a rounding error. 2,746 rows carry four options and a valid index; of
   * those, 3 have four options that are not four DISTINCT options (one is
   * `["1274","1274","1274","1274"]`, which cannot be answered) and 2 are tagged
   * `infer` / `predict`, which are not Bloom levels. Both rules are deliberate
   * and both live in `question-eligibility.ts`; the 5 ids are in the exclusion
   * report like every other exclusion.
   */
  eligibleQuestions: 2741,
  concepts: 639,
  conceptEdges: 176,
  misconceptions: 57,
  orphanMisconceptions: 37,
  chapters: 137,
  reserveReadyChapters: 81,
  demoReadyChapters: 57,
} as const;

let db: TestPostgres;

async function count(sql: string): Promise<number> {
  const { rows } = await db.client.query<{ readonly n: string }>(sql);
  return Number(rows[0]?.n ?? '0');
}

describe.skipIf(!HAS_EXTRACT)('the real corpus extract imports as measured', () => {
  beforeAll(async () => {
    db = await startTestPostgres();
    await applyAllMigrations(db.client);
    await importCorpus(db.client, EXTRACT_DIR);
  }, 600_000);

  afterAll(async () => {
    await db.stop();
  });

  it('imports every chunk in the file, including the twenty with no vector', async () => {
    // D-078. They are real content, reachable by full-text search. Dropping them
    // would make the corpus quietly smaller than the source — the one outcome an
    // import must never produce silently. NO vector is ever fabricated.
    expect(await count('select count(*)::text as n from rag_chunks')).toBe(MEASURED.chunks);
    expect(await count('select count(*)::text as n from rag_chunks where embedding is null')).toBe(
      MEASURED.chunksWithoutEmbedding,
    );
  });

  it('imports the eligible questions and no others', async () => {
    expect(await count('select count(*)::text as n from questions')).toBe(
      MEASURED.eligibleQuestions,
    );
  });

  it('imports every concept, edge and misconception pattern', async () => {
    // Each of these three read ZERO under the pre-D-098 shapes, silently.
    expect(await count('select count(*)::text as n from chapter_concepts')).toBe(MEASURED.concepts);
    expect(await count('select count(*)::text as n from concept_graph')).toBe(
      MEASURED.conceptEdges,
    );
    expect(await count('select count(*)::text as n from misconception_patterns')).toBe(
      MEASURED.misconceptions,
    );
  });

  it('flags the orphaned misconceptions rather than dropping them', async () => {
    expect(await count('select count(*)::text as n from misconception_patterns where is_orphan')).toBe(
      MEASURED.orphanMisconceptions,
    );
  });

  it('derives the chapter set from all four sources', async () => {
    expect(await count('select count(*)::text as n from chapters')).toBe(MEASURED.chapters);
  });

  it('admits no grade outside the pilot range, anywhere', async () => {
    for (const table of ['chapters', 'rag_chunks']) {
      expect(
        await count(
          `select count(*)::text as n from ${table} where grade not in ('6','7','8','9','10')`,
        ),
      ).toBe(0);
    }
  });

  it('gives every chunk and every question a chapter', async () => {
    expect(await count('select count(*)::text as n from rag_chunks where chapter_id is null')).toBe(0);
    expect(await count('select count(*)::text as n from questions where chapter_id is null')).toBe(0);
  });

  it('reports the chapters that clear each quality bar', async () => {
    const reserveReady = await count(`
      select count(*)::text as n from chapters c where
        exists (select 1 from rag_chunks r where r.chapter_id = c.id)
        and exists (select 1 from chapter_concepts k where k.chapter_id = c.id)
        and (select count(*) from questions q where q.chapter_id = c.id) >= ${String(MIN_QUESTIONS_FOR_RESERVE)}
    `);
    const demoReady = await count(`
      select count(*)::text as n from chapters c where
        (select count(*) from questions q where q.chapter_id = c.id) >= ${String(DEMO_MIN_QUESTIONS)}
        and (select count(*) from rag_chunks r where r.chapter_id = c.id) >= ${String(DEMO_MIN_CHUNKS)}
        and (select count(*) from chapter_concepts k where k.chapter_id = c.id) >= ${String(DEMO_MIN_CONCEPTS)}
    `);

    expect(reserveReady).toBe(MEASURED.reserveReadyChapters);
    expect(demoReady).toBe(MEASURED.demoReadyChapters);
  });

  it('holds out roughly 30% of every chapter that can afford one, and none of the rest', async () => {
    const { rows } = await db.client.query<{
      readonly total: string;
      readonly held: string;
    }>(`
      select count(*)::text as total, count(*) filter (where is_held_out)::text as held
        from questions group by chapter_id
    `);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const total = Number(row.total);
      const held = Number(row.held);
      if (total >= MIN_QUESTIONS_FOR_RESERVE) {
        expect(held).toBe(Math.ceil(total * 0.3));
      } else {
        // Below the threshold the answer is "none", not "fewer".
        expect(held).toBe(0);
      }
    }
  });

  it('every source question is either imported or in the exclusion report', () => {
    // The property that makes "excluded is not dropped" checkable: the two
    // halves add up to the file. A silent `.filter()` would not.
    const excluded = readFileSync(resolve(EXTRACT_DIR, 'reports/excluded-questions.ndjson'), 'utf8')
      .trim()
      .split('\n');

    expect(MEASURED.eligibleQuestions + excluded.length).toBe(MEASURED.sourceQuestions);
  });
});
