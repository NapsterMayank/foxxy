import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  readDownMigration,
  readMigration,
  splitStatements,
  startTestPostgres,
  type TestPostgres,
} from '../helpers/postgres';

/**
 * Migration `0001_pedagogy` — forward, backward, forward again.
 *
 * ===========================================================================
 * WHY A ROLLBACK IS EXERCISED FOR A MIGRATION THAT ONLY ADDS TABLES.
 *
 * Plan §4 rule 4: every migration runs forward AND backward against a copy of
 * the schema. It looks pointless here — three `create table`s reverse into
 * three `drop table`s — and it is exactly the case where the drift appears: a
 * fourth object added to the forward file and not to the down file leaves a
 * stray behind, and the re-apply then fails on "already exists". That failure
 * is the assertion. Nothing else would notice.
 *
 * ===========================================================================
 * THE STRUCTURAL CLAIMS ARE READ OUT OF THE CATALOGUE.
 *
 * Not out of the SQL, and not out of the TypeScript schema. Both of those are
 * inputs to the thing being tested; the catalogue is the outcome. `0000`'s
 * collapse found four indexes where the hand-written SQL and the schema had
 * silently disagreed for weeks precisely because no test had ever compared
 * either to the database.
 */

let db: TestPostgres;

const FORWARD = '0001_pedagogy.sql';
const BACKWARD = '0001_pedagogy.down.sql';

/**
 * ONE migration is named, which the D-075 lint rule permits and which is right
 * here: a migration's own forward/rollback test legitimately names its subject.
 * A LIST would be a second claim about which migrations exist.
 */
async function run(client: pg.Client, sql: string): Promise<void> {
  for (const statement of splitStatements(sql)) {
    await client.query(statement);
  }
}

/** 0001 depends on `chapters`, so the baseline has to be underneath it. */
async function applyBaseline(client: pg.Client): Promise<void> {
  await run(client, readMigration('0000_baseline.sql'));
}

beforeAll(async () => {
  db = await startTestPostgres();
  await applyBaseline(db.client);
  await run(db.client, readMigration(FORWARD));
}, 120_000);

afterAll(async () => {
  await db.stop();
});

async function columns(table: string): Promise<Record<string, { type: string; nullable: string }>> {
  const { rows } = await db.client.query<{
    readonly column_name: string;
    readonly data_type: string;
    readonly is_nullable: string;
  }>(
    `select column_name, data_type, is_nullable
       from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  );

  return Object.fromEntries(
    rows.map((row) => [row.column_name, { type: row.data_type, nullable: row.is_nullable }]),
  );
}

describe('the three tables exist with the columns the import plan needs', () => {
  it('carries every concept column the source has prose in', async () => {
    // Derived from `PlannedConcept`, which was settled by a pure, tested module
    // before any DDL existed — so the schema has no opinion of its own to drift.
    const found = await columns('chapter_concepts');
    for (const column of [
      'concept_number',
      'slug',
      'title_en',
      'title_hi',
      'learning_objective',
      'explanation_en',
      'explanation_hi',
      'example_content',
      'key_formula',
      'common_mistakes',
    ]) {
      expect(found[column]).toBeDefined();
    }
    expect(found.title_en?.nullable).toBe('NO');
    expect(found.common_mistakes?.type).toBe('jsonb');
  });

  it('carries the graph columns, with prerequisites as a text array', async () => {
    const found = await columns('concept_graph');
    expect(found.concept_code?.nullable).toBe('NO');
    expect(found.prerequisite_codes?.type).toBe('ARRAY');
    expect(found.prerequisite_codes?.nullable).toBe('NO');
    expect(found.bloom_level).toBeDefined();
    expect(found.cognitive_load).toBeDefined();
  });

  it('carries the misconception columns, including the orphan flag', async () => {
    const found = await columns('misconception_patterns');
    expect(found.pattern_code?.nullable).toBe('NO');
    expect(found.detection_rule?.type).toBe('jsonb');
    expect(found.remediation_concept_codes?.type).toBe('ARRAY');
    expect(found.severity).toBeDefined();
    expect(found.is_orphan?.nullable).toBe('NO');
  });

  it('gives NONE of the three a tenant_id', async () => {
    /**
     * D-073 made `tenant_id` NOT NULL on the six tables carrying STUDENT-OWNED
     * data. None of these three is student-owned — they are curriculum, exactly
     * like `chapters`, `questions` and `rag_chunks`, none of which carries a
     * tenant either. Grade 8 Science chapter 4's misconceptions are the same
     * misconceptions in every tenant.
     *
     * Asserted rather than assumed, because the obvious "consistency" fix is to
     * add the column — and a NOT NULL column whose only writer relies on its
     * default is exactly the theatre D-073 rejected.
     */
    for (const table of ['chapter_concepts', 'concept_graph', 'misconception_patterns']) {
      expect((await columns(table)).tenant_id).toBeUndefined();
    }
    // The control: a table that SHOULD have one, so this test cannot pass by
    // reading the wrong catalogue.
    expect((await columns('students')).tenant_id?.nullable).toBe('NO');
  });
});

describe('the keys and indexes the import relies on', () => {
  it('cascades both chapter foreign keys, so deleting a chapter cannot orphan', async () => {
    const { rows } = await db.client.query<{
      readonly table_name: string;
      readonly delete_rule: string;
    }>(`
      select tc.table_name, rc.delete_rule
        from information_schema.table_constraints tc
        join information_schema.referential_constraints rc
          on rc.constraint_name = tc.constraint_name
       where tc.constraint_type = 'FOREIGN KEY'
         and tc.table_name in ('chapter_concepts', 'concept_graph')
       order by tc.table_name
    `);

    expect(rows).toEqual([
      { table_name: 'chapter_concepts', delete_rule: 'CASCADE' },
      { table_name: 'concept_graph', delete_rule: 'CASCADE' },
    ]);
  });

  it('has NO foreign key from a concept code to anything', async () => {
    /**
     * THE KNOWN LIMITATION, pinned. `concept_graph.concept_code` does not join
     * to `chapter_concepts`: they are two independently-generated vocabularies
     * and there is no shared key. The only honest link is the chapter.
     *
     * This test exists so that the plausible-looking "improvement" — adding a
     * foreign key from `misconception_patterns.concept_code` to
     * `concept_graph.concept_code` — fails loudly. It would delete 37 of the 57
     * misconception patterns, which are human-authored descriptions that exist
     * nowhere else now the source has been read for the last time (D-095).
     */
    const { rows } = await db.client.query<{ readonly n: string }>(`
      select count(*)::text as n
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = tc.constraint_name
       where tc.constraint_type = 'FOREIGN KEY'
         and kcu.column_name = 'concept_code'
    `);
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('enforces one row per concept code and one per pattern code', async () => {
    const { rows } = await db.client.query<{ readonly indexname: string }>(`
      select indexname from pg_indexes
       where schemaname = 'public'
         and indexname in ('concept_graph_concept_code_unique', 'misconception_patterns_pattern_code_unique')
       order by indexname
    `);
    expect(rows.map((row) => row.indexname)).toEqual([
      'concept_graph_concept_code_unique',
      'misconception_patterns_pattern_code_unique',
    ]);
  });
});

describe('the migration rolls back and re-applies', () => {
  it('drops all three, then recreates them cleanly', async () => {
    await run(db.client, readDownMigration(BACKWARD));

    const { rows: afterDown } = await db.client.query<{ readonly table_name: string }>(`
      select table_name from information_schema.tables
       where table_schema = 'public'
         and table_name in ('chapter_concepts', 'concept_graph', 'misconception_patterns')
    `);
    expect(afterDown).toEqual([]);

    // The baseline's tables must survive a 0001 rollback untouched — a down
    // migration that reached further than its own forward migration would take
    // the whole schema with it.
    const { rows: chapters } = await db.client.query<{ readonly n: string }>(
      "select count(*)::text as n from information_schema.tables where table_name = 'chapters'",
    );
    expect(Number(chapters[0]?.n)).toBe(1);

    // Re-apply. If the down migration missed an object this fails on
    // "already exists", which is the whole reason the rollback is exercised.
    await run(db.client, readMigration(FORWARD));

    const { rows: afterUp } = await db.client.query<{ readonly table_name: string }>(`
      select table_name from information_schema.tables
       where table_schema = 'public'
         and table_name in ('chapter_concepts', 'concept_graph', 'misconception_patterns')
       order by table_name
    `);
    expect(afterUp.map((row) => row.table_name)).toEqual([
      'chapter_concepts',
      'concept_graph',
      'misconception_patterns',
    ]);
  });
});
