import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import pg from 'pg';

/**
 * The two migration sets that exist, and why there are two.
 *
 * `current` is the collapsed baseline — the one thing `db:migrate` applies and
 * the only one a new database ever sees.
 *
 * `superseded` is migrations 0000-0008, kept verbatim in `drizzle/_superseded/`
 * after the collapse (D-091). They are NOT dead weight and NOT documentation:
 * they are the ORACLE. `baseline-collapse.test.ts` applies them to one database
 * and the baseline to another and diffs the two schemas out of the catalogue,
 * which is the only thing that makes "the baseline is equivalent to the chain
 * it replaced" a checked claim rather than a story. Their own forward/rollback
 * tests keep running for the same reason: an oracle nobody exercises is an
 * oracle that has quietly stopped working.
 *
 * A SET, not a path, deliberately. Every reader below takes the set rather than
 * a directory string, so a caller cannot point a test at an arbitrary folder of
 * `.sql` files that has no journal to cross-check against — which is the D-046
 * defect wearing yet another hat.
 */
export type MigrationSet = 'current' | 'superseded';

const MIGRATION_DIRS: Record<MigrationSet, string> = {
  current: 'drizzle/migrations',
  superseded: 'drizzle/_superseded/migrations',
};

const DOWN_DIRS: Record<MigrationSet, string> = {
  current: 'drizzle/down',
  superseded: 'drizzle/_superseded/down',
};

/**
 * A real Postgres 16 + pgvector (§9.1).
 *
 * The database is NEVER faked. A faked database hides exactly the bugs worth
 * finding: constraint violations, transaction behaviour, and the gap between
 * what a query means and what SQL does.
 *
 * The CONTAINER is started once for the whole run by
 * `tests/helpers/global-postgres.ts`. This function carves a fresh, empty
 * DATABASE out of it for the calling test file.
 *
 * Per-file databases rather than a shared one, deliberately: the migration
 * test drops every table as part of proving the rollback works, and a shared
 * database would have it doing that underneath whatever else was running in
 * parallel. Isolation here is a correctness property, not tidiness.
 */
export interface TestPostgres {
  readonly url: string;
  readonly client: pg.Client;
  stop(): Promise<void>;
}

export async function startTestPostgres(): Promise<TestPostgres> {
  const adminUrl = inject('postgresAdminUrl');

  // A UUID with the hyphens removed: always a legal unquoted identifier, and
  // collision-free across parallel workers.
  const database = `t_${randomUUID().replace(/-/g, '')}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Identifier interpolation, which cannot be parameterised. Safe because
    // the value is generated immediately above and matches /^t_[0-9a-f]{32}$/.
    await admin.query(`create database ${database}`);
  } finally {
    await admin.end();
  }

  const url = adminUrl.replace(/\/postgres$/, `/${database}`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  return {
    url,
    client,
    async stop(): Promise<void> {
      await client.end();
      // The container is discarded at the end of the run, so dropping the
      // database is housekeeping rather than necessity — but it keeps a long
      // watch-mode session from accumulating hundreds of them.
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`drop database if exists ${database} with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/** Splits a Drizzle migration on its statement breakpoints. */
export function splitStatements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export function readMigration(fileName: string, set: MigrationSet = 'current'): string {
  return readFileSync(resolve(process.cwd(), MIGRATION_DIRS[set], fileName), 'utf8');
}

interface MigrationJournal {
  readonly entries: readonly { readonly idx: number; readonly tag: string }[];
}

/**
 * Every migration file name, in the order Drizzle applies them.
 *
 * THIS FUNCTION EXISTS BECAUSE OF A REAL DEFECT, not for tidiness. The
 * identity service harness used to carry a hardcoded list of migrations. When
 * `0001_link_codes` was added the list was not updated, so every service test
 * ran against a schema with no `link_codes` table — a whole suite quietly
 * testing the wrong database. Nothing failed; the tests that would have
 * noticed had not been written yet. A hardcoded list is a second source of
 * truth about which migrations exist, and second sources of truth drift.
 *
 * So the directory is the source of truth, AND it is cross-checked against
 * Drizzle's journal. Either alone reintroduces the same class of bug from the
 * other side:
 *
 *  - The directory alone would happily apply a stray `.sql` a colleague left
 *    behind, or apply files in an order Drizzle does not use.
 *  - The journal alone would silently SKIP a migration file whose journal
 *    entry was lost in a merge — which is precisely the original defect,
 *    wearing a different hat.
 *
 * When they disagree the function throws and names both sides, because a test
 * run against a half-applied schema is worse than no test run: it is green.
 */
export function listMigrations(set: MigrationSet = 'current'): string[] {
  const dir = resolve(process.cwd(), MIGRATION_DIRS[set]);

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
        `Journalled but not on disk: [${missingFromDisk.join(', ')}]. ` +
        'Applying either list would leave tests running against a schema that ' +
        'does not match production. Fix the mismatch before running tests.',
    );
  }

  // The journal order is the one Drizzle itself uses, and migrations are order
  // dependent — 0002 references tables 0000 created.
  return journalled;
}

/**
 * Applies EVERY migration, in order, to a fresh database.
 *
 * Harnesses call this instead of naming files. A migration added tomorrow is
 * picked up with no harness edit, which is the entire point.
 */
export async function applyAllMigrations(
  client: pg.Client,
  set: MigrationSet = 'current',
): Promise<void> {
  for (const fileName of listMigrations(set)) {
    for (const statement of splitStatements(readMigration(fileName, set))) {
      await client.query(statement);
    }
  }
}

export function readDownMigration(fileName: string, set: MigrationSet = 'current'): string {
  return readFileSync(resolve(process.cwd(), DOWN_DIRS[set], fileName), 'utf8');
}

/** The directory a set's forward migrations live in, relative to the repo root. */
export function migrationsDirFor(set: MigrationSet): string {
  return MIGRATION_DIRS[set];
}

/** The directory a set's down migrations live in, relative to the repo root. */
export function downDirFor(set: MigrationSet): string {
  return DOWN_DIRS[set];
}
