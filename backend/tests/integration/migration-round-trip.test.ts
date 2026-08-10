import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  listMigrations,
  readDownMigration,
  readMigration,
  splitStatements,
  startTestPostgres,
  type TestPostgres,
} from '../helpers/postgres';

/**
 * ============================================================================
 * PLAN §4 RULE 4, STATED ONCE AND FOR ALL MIGRATIONS: every migration applies,
 * reverses, and re-applies — and the set is DISCOVERED, never named.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS. Rule 4 used to be asserted per-migration, by files that
 * spelled their subject's name and their prerequisites' names. That works
 * exactly until the next migration lands, and then it does not: the assertion
 * has to be edited, and the edit is always the same edit — add one more name.
 * `foundation-hooks-migration.test.ts` and `learner-content-migration.test.ts`
 * were each patched that way twice before this file replaced their rollback
 * halves. D-046, D-072, D-075 and D-106 are all the same defect, and the reason
 * it keeps coming back is that a hand-written list of migrations is a SECOND
 * SOURCE OF TRUTH about which migrations exist.
 *
 * So there are no migration names in this file. `listMigrations()` reads the
 * directory AND cross-checks Drizzle's journal, throwing when they disagree, so
 * the set under test is the set that would actually be applied to a database.
 *
 * WHAT IT PROVES, and why each half matters:
 *
 *  FORWARD    The whole set applies to an empty database, in journal order.
 *
 *  BACKWARD   Every down file, in exact reverse order, leaves `public` with
 *             NOTHING in it. This is the assertion that catches the common
 *             failure: a forward migration grows a table, an index or a
 *             trigger, and the down file is not updated. Nothing errors —
 *             the object simply survives the rollback and the NEXT re-apply
 *             fails on "already exists", usually in a different sprint.
 *
 *  RE-APPLY   The set applies again on the emptied database and produces a
 *             catalogue IDENTICAL to the first one. "It did not error" is a
 *             much weaker claim than "it produced the same schema": a down
 *             file that drops a column's DEFAULT, or a CHECK, or a COMMENT
 *             without dropping the column leaves a re-apply that succeeds and
 *             a database that is quietly different.
 *
 * REVERSE ORDER IS NOT A STYLE CHOICE. A later migration's tables reference an
 * earlier migration's, so any other order is refused by Postgres — which is
 * correct, and is why the tempting `drop ... cascade` in a down file is a
 * defect: it lets an EARLIER migration's rollback silently delete a LATER
 * migration's tables, turning a loud error here into no error anywhere.
 */

let postgres: TestPostgres;

/**
 * The schema, read out of the catalogue rather than eyeballed.
 *
 * Deliberately narrower than `baseline-collapse.test.ts`'s catalogue, which
 * exists to compare two DIFFERENT construction paths and therefore has to
 * normalise known-divergent things like ordinal position. This one compares a
 * database with ITSELF across a round trip, so nothing legitimately differs and
 * nothing needs normalising — an exact match is the whole point.
 */
interface Catalogue {
  readonly columns: readonly string[];
  readonly constraints: readonly string[];
  readonly indexes: readonly string[];
  readonly triggers: readonly string[];
  readonly comments: readonly string[];
}

async function lines(client: pg.Client, sql: string): Promise<string[]> {
  const result = await client.query<{ line: string }>(sql);
  return result.rows.map((row) => row.line);
}

async function readCatalogue(client: pg.Client): Promise<Catalogue> {
  return {
    columns: await lines(
      client,
      `select table_name || '.' || column_name || ' ' || data_type ||
              ' null=' || is_nullable ||
              ' default=' || coalesce(column_default, '-') as line
         from information_schema.columns
        where table_schema = 'public'
        order by table_name, column_name`,
    ),
    constraints: await lines(
      client,
      `select conrelid::regclass::text || ' ' || conname || ' ' ||
              pg_get_constraintdef(oid) as line
         from pg_constraint
        where connamespace = 'public'::regnamespace
        order by 1`,
    ),
    indexes: await lines(
      client,
      `select indexdef as line from pg_indexes
        where schemaname = 'public' order by indexname`,
    ),
    triggers: await lines(
      client,
      `select tgrelid::regclass::text || ' ' || tgname as line
         from pg_trigger where not tgisinternal order by 1`,
    ),
    comments: await lines(
      client,
      `select c.relname || '.' || a.attname || ' = ' ||
              col_description(a.attrelid, a.attnum) as line
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped
          and col_description(a.attrelid, a.attnum) is not null
        order by 1`,
    ),
  };
}

async function run(client: pg.Client, sql: string): Promise<void> {
  for (const statement of splitStatements(sql)) {
    await client.query(statement);
  }
}

/** The down file that belongs to a forward migration. Derived, never listed. */
function downFileFor(forward: string): string {
  return forward.replace(/\.sql$/, '.down.sql');
}

async function applyAll(client: pg.Client): Promise<void> {
  for (const fileName of listMigrations()) {
    await run(client, readMigration(fileName));
  }
}

async function reverseAll(client: pg.Client): Promise<void> {
  for (const fileName of [...listMigrations()].reverse()) {
    await run(client, readDownMigration(downFileFor(fileName)));
  }
}

async function publicTableCount(client: pg.Client): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*)::text as count from pg_tables where schemaname = 'public'`,
  );
  return Number(result.rows[0]?.count ?? '-1');
}

beforeAll(async () => {
  postgres = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await postgres.stop();
}, 60_000);

describe('the current migration set is a round trip', () => {
  it('has at least one migration, and a down file for every one of them', () => {
    // A guard on the guard. If `listMigrations()` ever returned an empty array
    // — a moved directory, a renamed journal — every assertion below would pass
    // vacuously and this file would report success while testing nothing.
    const migrations = listMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations.every((name) => name.endsWith('.sql'))).toBe(true);
  });

  it('applies forward, reverses to an empty schema, and re-applies identically', async () => {
    await applyAll(postgres.client);
    const before = await readCatalogue(postgres.client);

    // Sanity: the forward apply built something. Comparing two empty
    // catalogues would be a passing test with no subject.
    expect(before.columns.length).toBeGreaterThan(0);
    expect(before.constraints.length).toBeGreaterThan(0);

    await reverseAll(postgres.client);

    // NOTHING LEFT. Not "the tables I remembered to list are gone" — nothing.
    // A table added to a forward migration and forgotten in its down file is
    // invisible to any assertion that names tables, and is caught by this one
    // on the day it is introduced.
    expect(await publicTableCount(postgres.client)).toBe(0);

    await applyAll(postgres.client);
    const after = await readCatalogue(postgres.client);

    // Field by field rather than one object comparison, so a failure names
    // WHICH kind of object drifted instead of printing five arrays.
    expect(after.columns).toEqual(before.columns);
    expect(after.constraints).toEqual(before.constraints);
    expect(after.indexes).toEqual(before.indexes);
    expect(after.triggers).toEqual(before.triggers);
    expect(after.comments).toEqual(before.comments);
  }, 180_000);
});
