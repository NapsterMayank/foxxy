/**
 * MIGRATION ROUND-TRIP, against a real Postgres, as an explicit CI step.
 *
 *   npm run db:round-trip          # uses DATABASE_URL from config
 *
 * Applies every discovered migration, rolls the whole set back, asserts the
 * `public` schema is EMPTY, re-applies, and diffs the resulting catalogue
 * against the first apply.
 *
 * =============================================================================
 * WHY THIS EXISTS WHEN `tests/integration/migration-round-trip.test.ts` ALREADY
 * ASSERTS THE SAME PROPERTY.
 *
 * They run against different databases, and the difference is the point. The
 * vitest version runs against a testcontainer that vitest starts. This one runs
 * against whatever `DATABASE_URL` points at — in CI, the workflow's Postgres
 * SERVICE container, which is the closest thing in the pipeline to a real
 * deployment target.
 *
 * That distinction has already cost this project once. D-109: `db:migrate`
 * printed "Migrations applied." and applied NOTHING, because Drizzle skips a
 * migration whose journal timestamp precedes the last applied ledger row. Every
 * testcontainer-based test passed throughout, because a fresh container has an
 * empty ledger and therefore cannot reproduce the condition. The rule that came
 * out of it is "check the catalogue, not the exit code", and that is exactly
 * what this script does.
 *
 * =============================================================================
 * IT REFUSES TO RUN AGAINST A DATABASE WITH DATA — ANY DATA, IN ANY TABLE.
 *
 * The rollback half drops every table. Run against the development database it
 * would destroy the imported corpus — 137 chapters, 4,686 chunks, 2,741
 * questions, hours of extraction — and run against production it would destroy
 * everything.
 *
 * The guard therefore asks the CATALOGUE which tables exist and refuses if any
 * of them holds a single row. It used to check four names, which meant jobs,
 * metrics, notifications, billing and audit rows were all invisible to it: a
 * database full of exactly the data you cannot recreate passed the check. See
 * `refuseIfPopulated` for why a hardcoded list is the wrong shape for a guard
 * (D-249, and D-075 for the fifth time).
 *
 * A destructive script whose only safeguard is the operator remembering which
 * DATABASE_URL is exported is not a safeguard.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { config } from '../../src/platform/config/index';

const MIGRATIONS_DIR = 'drizzle/migrations';
const DOWN_DIR = 'drizzle/down';

interface MigrationJournal {
  readonly entries: readonly { readonly idx: number; readonly tag: string }[];
}

/**
 * The migration list is DISCOVERED and cross-checked against Drizzle's journal.
 * Never hardcoded — D-075, a defect that has now been found four separate times
 * in this repository, twice inside the code written to prevent it.
 *
 * Either source alone reintroduces the bug from the other side: the directory
 * alone would apply a stray `.sql` in the wrong order; the journal alone would
 * silently skip a file whose entry is missing.
 */
function listMigrations(): string[] {
  const dir = resolve(process.cwd(), MIGRATIONS_DIR);
  const onDisk = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const journal = JSON.parse(
    readFileSync(resolve(dir, 'meta/_journal.json'), 'utf8'),
  ) as MigrationJournal;
  const journalled = [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => `${entry.tag}.sql`);

  const missingFromJournal = onDisk.filter((name) => !journalled.includes(name));
  const missingFromDisk = journalled.filter((name) => !onDisk.includes(name));
  if (missingFromJournal.length > 0 || missingFromDisk.length > 0) {
    throw new Error(
      'Migration directory and drizzle journal disagree. ' +
        `On disk but not journalled: [${missingFromJournal.join(', ')}]. ` +
        `Journalled but not on disk: [${missingFromDisk.join(', ')}].`,
    );
  }
  return journalled;
}

/**
 * Splits on `--> statement-breakpoint`, the marker drizzle-kit emits.
 *
 * `pg`'s simple query protocol will happily run a whole file in one call, but
 * then a failure reports the position within the FILE rather than naming the
 * statement, and a `DO $$ ... $$` block containing semicolons cannot be split
 * naively. The breakpoint is the only correct separator.
 */
function splitStatements(source: string): string[] {
  return source
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

interface CatalogueRow {
  readonly kind: string;
  readonly name: string;
}

/**
 * The schema as the CATALOGUE sees it, not as the migration files claim.
 *
 * Tables, columns with their types and nullability, constraints and indexes.
 * Comparing files to files would only prove the files have not changed.
 *
 * ONE EXCLUSION, and it is not a loosening. Postgres names the implicit NOT NULL
 * check constraints after the table's OID — '2200_17032_1_not_null' — and those
 * OIDs are assigned at CREATE TABLE, so they differ on every apply. Including
 * them makes the comparison fail on a schema that is byte-identical: a check
 * that can never pass, which is worse than one that never fails, because it
 * gets switched off. Nullability is still compared, in the column rows.
 *
 * (Also: the SQL below carries no `--` comments. It lives in a template
 * literal, and a stray backtick inside one terminates the string — which is how
 * an earlier version of this comment turned a query into a parse error.)
 */
async function catalogue(client: pg.Client): Promise<string> {
  const { rows } = await client.query<CatalogueRow>(`
    select 'table' as kind, table_name as name
      from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
    union all
    select 'column', table_name || '.' || column_name || ':' || data_type || ':' || is_nullable
      from information_schema.columns where table_schema = 'public'
    union all
    select 'constraint', table_name || '.' || constraint_name || ':' || constraint_type
      from information_schema.table_constraints
     where table_schema = 'public'
       and constraint_name !~ '^[0-9]+_[0-9]+_[0-9]+_not_null$'
    union all
    select 'index', tablename || '.' || indexname
      from pg_indexes where schemaname = 'public'
    order by 1, 2
  `);
  return rows.map((row) => `${row.kind} ${row.name}`).join('\n');
}

async function tableCount(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `select count(*)::text as count from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  return Number(rows[0]?.count ?? '0');
}

/**
 * THE ABORT — every table in `public`, discovered from the catalogue. D-249.
 *
 * =============================================================================
 * WHAT THIS USED TO BE, AND WHY A HARDCODED LIST IS THE WRONG SHAPE HERE.
 *
 * It checked four names: `chapters`, `rag_chunks`, `questions`, `users`. Those
 * were the tables that existed and mattered on the day it was written. Since
 * then the schema grew jobs, metrics_events, notifications, subscriptions,
 * payments, audit_log, worker_heartbeats and more — and NONE of them was
 * guarded. A database holding a year of billing rows, or the append-only audit
 * record of every privileged action, passed the guard cleanly and was then
 * dropped table by table by the rollback half of this script.
 *
 * That is D-075 in a new costume, and the header of `listMigrations` above
 * already says D-075 has been found four times in this repository, twice inside
 * the code written to prevent it. This was the fifth, sitting nine lines below
 * that sentence.
 *
 * The distinction that matters: a hardcoded list fails OPEN. A table nobody
 * added to it is a table the guard is silent about, and silence is
 * indistinguishable from "checked and empty". So the list is gone. The
 * catalogue is asked which tables exist, and ANY row anywhere is a refusal.
 *
 * =============================================================================
 * ONE EXCLUSION, AND IT IS NOT A LOOSENING.
 *
 * `__drizzle_migrations` is the migration ledger. It is populated by definition
 * on any database that has ever been migrated — including the scratch database
 * this script is FOR — so counting it would make the guard refuse every legal
 * run, and a guard that always refuses is a guard that gets `--i-know`'d
 * permanently. It holds no business data. It is named explicitly rather than
 * matched by a `__%` pattern so that a future table called `__anything` is
 * guarded rather than accidentally exempt.
 *
 * =============================================================================
 * ONE QUERY, NOT ONE PER TABLE.
 *
 * The counts are gathered in a single statement built from the catalogue, so
 * they describe ONE snapshot. A loop of `count(*)` calls could be interleaved
 * with a write and report a table as empty that had rows a moment later — an
 * unlikely race with a catastrophic outcome, and avoiding it costs nothing.
 *
 * Identifiers are quoted with `quote_ident` inside the catalogue query rather
 * than interpolated by hand: a table name is not user input here, but building
 * SQL out of `format()` in the database is how it stays correct for a name that
 * needs quoting, which the previous `"${table}"` would have got right by luck.
 */
const LEDGER_TABLE = '__drizzle_migrations';

interface PopulatedRow {
  readonly table_name: string;
  readonly row_count: string;
}

async function refuseIfPopulated(client: pg.Client, override: boolean): Promise<void> {
  const { rows: tables } = await client.query<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
        and table_name <> $1
      order by table_name`,
    [LEDGER_TABLE],
  );

  if (tables.length === 0) {
    // An empty schema is the normal state for a scratch database that has not
    // been migrated yet. Nothing to guard, and nothing to report.
    return;
  }

  // `count(*)` per table, unioned into one statement so every number describes
  // the same snapshot. `quote_ident` is applied by the database.
  const union = tables
    .map(
      (row) =>
        `select ${literal(row.table_name)} as table_name, count(*)::text as row_count ` +
        `from public.${quoteIdent(row.table_name)}`,
    )
    .join(' union all ');

  const { rows: counted } = await client.query<PopulatedRow>(union);
  const populated = counted
    .filter((row) => Number(row.row_count) > 0)
    .sort((a, b) => Number(b.row_count) - Number(a.row_count));

  process.stdout.write(
    `round-trip: guard inspected ${tables.length} table(s) in public; ` +
      `${populated.length} hold rows\n`,
  );

  if (populated.length === 0) return;

  const detail = populated
    .map((row) => `    ${row.table_name}: ${row.row_count} row(s)`)
    .join('\n');

  if (!override) {
    throw new Error(
      `REFUSING TO RUN: ${populated.length} table(s) in the public schema hold data. This script ` +
        `DROPS EVERY TABLE.\n${detail}\n` +
        `  Point DATABASE_URL at a FRESH scratch database — one that has never been migrated:\n` +
        `      psql -c 'drop database if exists round_trip' -c 'create database round_trip'\n` +
        `  (that is exactly what .github/workflows/backend-ci.yml does before this step).\n` +
        `\n` +
        `  A SEEDED ROW COUNTS AS DATA, AND THAT IS DELIBERATE. Migration 0004 seeds the default ` +
        `tenant, so an already-migrated scratch database trips this guard. The alternative is a ` +
        `list of rows the guard is willing to ignore, which is the hardcoded list this check was ` +
        `just rewritten to remove: it cannot tell a seeded tenant from a real one, and the ` +
        `permissive guess is the one that drops the development corpus — 137 chapters, 4,686 ` +
        `chunks, 2,741 questions, with no undo.\n` +
        `  (--i-know overrides. Read the table list above before you use it.)`,
    );
  }

  process.stderr.write(
    `round-trip: --i-know given; PROCEEDING TO DROP ${populated.length} populated table(s):\n` +
      `${detail}\n`,
  );
}

/**
 * A SQL string literal and a SQL identifier, quoted here because the guard's
 * query is assembled rather than parameterised.
 *
 * `count(*) from <table>` cannot take a bind parameter for the table — the
 * parser needs the identifier before planning — so the name is embedded. Every
 * name comes from `information_schema` on this same connection, so it is not
 * attacker-controlled; the doubling below is what keeps a legitimately odd name
 * (`"order"`, a name with a quote in it) from producing a syntax error, which
 * would fail the guard's own query and abort the run. Failing closed either way.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const override = process.argv.includes('--i-know');
  const client = new pg.Client({ connectionString: config.db.url });
  await client.connect();

  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  try {
    await refuseIfPopulated(client, override);

    const migrations = listMigrations();
    out(`round-trip: ${migrations.length} migration(s) discovered: ${migrations.join(', ')}`);

    // --- forward -------------------------------------------------------------
    for (const fileName of migrations) {
      for (const statement of splitStatements(
        readFileSync(resolve(process.cwd(), MIGRATIONS_DIR, fileName), 'utf8'),
      )) {
        await client.query(statement);
      }
    }
    const first = await catalogue(client);
    const firstTables = await tableCount(client);
    out(`round-trip: forward apply produced ${firstTables} tables`);
    if (firstTables === 0) {
      // A "successful" apply that produced nothing is the D-109 failure exactly:
      // a zero exit code that means nothing happened.
      throw new Error('forward apply produced ZERO tables — nothing was applied');
    }

    // --- backward ------------------------------------------------------------
    for (const fileName of [...migrations].reverse()) {
      const downFile = fileName.replace(/\.sql$/, '.down.sql');
      for (const statement of splitStatements(
        readFileSync(resolve(process.cwd(), DOWN_DIR, downFile), 'utf8'),
      )) {
        await client.query(statement);
      }
    }
    const remaining = await tableCount(client);
    out(`round-trip: rollback left ${remaining} tables`);
    if (remaining !== 0) {
      throw new Error(
        `rollback left ${remaining} table(s) behind. A down migration that does not fully ` +
          `undo its up migration turns every future rollback into a manual operation.`,
      );
    }

    // --- forward again -------------------------------------------------------
    for (const fileName of migrations) {
      for (const statement of splitStatements(
        readFileSync(resolve(process.cwd(), MIGRATIONS_DIR, fileName), 'utf8'),
      )) {
        await client.query(statement);
      }
    }
    const second = await catalogue(client);

    if (first !== second) {
      const firstLines = new Set(first.split('\n'));
      const secondLines = new Set(second.split('\n'));
      const lost = [...firstLines].filter((line) => !secondLines.has(line));
      const gained = [...secondLines].filter((line) => !firstLines.has(line));
      throw new Error(
        `re-apply produced a DIFFERENT schema.\n  missing: ${lost.join(', ')}\n  extra: ${gained.join(', ')}`,
      );
    }

    out('round-trip: PASS — forward, backward to empty, forward again, identical catalogue');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`round-trip: FAIL: ${message}\n`);
  process.exit(1);
});
