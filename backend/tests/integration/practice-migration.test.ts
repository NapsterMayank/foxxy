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
 * Migration `0002_practice` — forward, backward, forward again.
 *
 * ===========================================================================
 * THIS IS THE FIRST MIGRATION IN THE REPOSITORY THAT RENAMES SOMETHING, and
 * that is why the rollback matters more here than it did for `0001`.
 *
 * A rename reverses in two halves — the table name, and every constraint and
 * index name that was renamed alongside it. Reverse only one half and the
 * schema is left with `question_responses` carrying `practice_responses_*`
 * constraints, which is a state no forward migration and no `db:generate` will
 * ever produce, so nothing else in the codebase would notice. The re-apply at
 * the end is the assertion: it fails on a name it cannot find.
 *
 * ===========================================================================
 * THE STRUCTURAL CLAIMS ARE READ OUT OF THE CATALOGUE, never out of the SQL or
 * the TypeScript schema. Both of those are INPUTS to the thing being tested.
 */

let db: TestPostgres;

const FORWARD = '0002_practice.sql';
const BACKWARD = '0002_practice.down.sql';

async function run(client: pg.Client, sql: string): Promise<void> {
  for (const statement of splitStatements(sql)) {
    await client.query(statement);
  }
}

/** 0002 renames a table the baseline created, so the baseline goes first. */
async function applyBaseline(client: pg.Client): Promise<void> {
  await run(client, readMigration('0000_baseline.sql'));
}

beforeAll(async () => {
  db = await startTestPostgres();
  await applyBaseline(db.client);
  await run(db.client, readMigration(FORWARD));
}, 180_000);

afterAll(async () => {
  await db.stop();
});

async function tableNames(): Promise<string[]> {
  const { rows } = await db.client.query<{ readonly table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public'`,
  );
  return rows.map((row) => row.table_name);
}

async function columnNames(table: string): Promise<string[]> {
  const { rows } = await db.client.query<{ readonly column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return rows.map((row) => row.column_name);
}

async function constraintNames(table: string): Promise<string[]> {
  const { rows } = await db.client.query<{ readonly conname: string }>(
    `select conname from pg_constraint where conrelid = $1::regclass`,
    [table],
  );
  return rows.map((row) => row.conname);
}

describe('0002_practice — the D-057 merge', () => {
  it('renames question_responses to practice_responses', async () => {
    const tables = await tableNames();
    expect(tables).toContain('practice_responses');
    expect(tables).not.toContain('question_responses');
  });

  it('adds the session_id the merge exists for', async () => {
    expect(await columnNames('practice_responses')).toContain('session_id');
  });

  it('KEEPS the five evidence columns through the rename', async () => {
    // The reason 0002 renames rather than drops-and-recreates. These columns are
    // 05-ROADMAP.md §8's "unrecoverable if skipped" row; a recreate that omitted
    // one would be invisible until the teacher screen launched empty.
    const columns = await columnNames('practice_responses');
    for (const column of [
      'first_selected_index',
      'answer_changed',
      'hint_level_used',
      'confidence',
      'explanation_format_used',
    ]) {
      expect(columns).toContain(column);
    }
  });

  it('CARRIES THE COLUMN COMMENTS THROUGH THE RENAME', async () => {
    // A drop-and-recreate would have silently discarded every COMMENT ON COLUMN
    // migration 0006 attached — and a comment is the only place several of these
    // rules are written down at all.
    const { rows } = await db.client.query<{ readonly comment: string | null }>(
      `select col_description(a.attrelid, a.attnum) as comment
         from pg_attribute a
        where a.attrelid = 'practice_responses'::regclass and a.attname = 'confidence'`,
    );
    expect(rows[0]?.comment).toMatch(/UNRECOVERABLE/);
  });

  it('records D-058 on selected_index, because the rule is invisible in the type', async () => {
    const { rows } = await db.client.query<{ readonly comment: string | null }>(
      `select col_description(a.attrelid, a.attnum) as comment
         from pg_attribute a
        where a.attrelid = 'practice_responses'::regclass and a.attname = 'selected_index'`,
    );
    expect(rows[0]?.comment).toMatch(/D-058/);
  });

  it('renames the constraints alongside the table', async () => {
    const names = await constraintNames('practice_responses');
    expect(names).toContain('practice_responses_confidence_check');
    expect(names.filter((name) => name.startsWith('question_responses'))).toEqual([]);
  });

  it('makes a second set of responses for one session impossible', async () => {
    expect(await constraintNames('practice_responses')).toContain(
      'practice_responses_session_question_key',
    );
  });
});

describe('0002_practice — the three new tables', () => {
  it('creates them all', async () => {
    const tables = await tableNames();
    expect(tables).toContain('practice_sessions');
    expect(tables).toContain('xp_ledger');
    expect(tables).toContain('practice_retention');
  });

  it('gives every one of them a NOT NULL tenant (D-073)', async () => {
    const { rows } = await db.client.query<{
      readonly table_name: string;
      readonly is_nullable: string;
    }>(
      `select table_name, is_nullable from information_schema.columns
        where table_schema = 'public' and column_name = 'tenant_id'
          and table_name in ('practice_sessions', 'xp_ledger', 'practice_retention',
                             'practice_responses')`,
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.is_nullable).toBe('NO');
    }
  });

  it('makes one session award XP exactly once', async () => {
    expect(await constraintNames('xp_ledger')).toContain('xp_ledger_source_key');
  });

  it('refuses a half-submitted session', async () => {
    expect(await constraintNames('practice_sessions')).toContain(
      'practice_sessions_submitted_complete_check',
    );
  });
});

describe('0002_practice — rollback and re-apply', () => {
  it('reverses completely and re-applies', async () => {
    await run(db.client, readDownMigration(BACKWARD));

    const afterRollback = await tableNames();
    expect(afterRollback).toContain('question_responses');
    expect(afterRollback).not.toContain('practice_responses');
    expect(afterRollback).not.toContain('practice_sessions');
    expect(afterRollback).not.toContain('xp_ledger');
    expect(afterRollback).not.toContain('practice_retention');

    // The half a partial rollback would leave behind: the OLD table name with
    // the NEW constraint names. Re-applying is what catches it, because the
    // forward file drops constraints by their old names.
    const names = await constraintNames('question_responses');
    expect(names).toContain('question_responses_confidence_check');
    expect(names.filter((name) => name.startsWith('practice_responses'))).toEqual([]);

    await run(db.client, readMigration(FORWARD));
    expect(await tableNames()).toContain('practice_responses');
  }, 60_000);
});
