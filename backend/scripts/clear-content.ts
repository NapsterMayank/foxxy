/**
 * Removes every row of DEVELOPMENT content, so a corpus import is measured
 * against an empty table rather than against `db:seed`'s leftovers.
 *
 * Run with `npm run db:clear-content`.
 *
 * ===========================================================================
 * WHY THIS IS A COMMAND AND NOT A PARAGRAPH IN A README.
 *
 * `npm run db:seed` writes 6 chapters, 120 questions and 180 rag chunks with
 * synthetic embeddings. Every verification count the corpus import reports —
 * "4,686 chunks imported", "no grade outside 6..10", "every chunk has a
 * chapter" — is wrong while those rows are present, and wrong in the direction
 * that looks fine: the numbers are simply larger than they should be, and
 * nobody notices 180 extra chunks in 4,866.
 *
 * `import-corpus.ts` does not depend on this having been run. It RECONCILES —
 * it deletes every content row that is not in the extract as part of its own
 * transaction — precisely so that "clear the seed data first" is not something
 * anyone has to remember. This command exists for the other case: wanting an
 * empty content schema without importing anything.
 *
 * ===========================================================================
 * IT ALSO DROPS `chk_probe`.
 *
 * A stray table left behind by a constraint experiment. It carries no data and
 * no test refers to it, but it is in `information_schema.tables`, which is what
 * anybody auditing the schema reads. A stray table is indistinguishable from a
 * table whose module has not been built yet, and this repository deliberately
 * has several of the latter (`schools`, `question_responses`) — so the stray
 * one has to go, or the convention that "an unexplained table is real" breaks.
 *
 * `if exists`, so this is safe on a database that never had it.
 */
import { pathToFileURL } from 'node:url';
import pg from 'pg';

/** Child-first: `chapters` is referenced by four of the others. */
const CONTENT_TABLES = [
  'misconception_patterns',
  'concept_graph',
  'chapter_concepts',
  'questions',
  'rag_chunks',
  'chapters',
] as const;

export async function clearContent(client: pg.ClientBase): Promise<Record<string, number>> {
  const before: Record<string, number> = {};

  await client.query('begin');
  try {
    for (const table of CONTENT_TABLES) {
      // Identifier interpolation from a frozen literal tuple, never from input.
      const { rows } = await client.query<{ readonly count: string }>(
        `select count(*)::text as count from ${table}`,
      );
      before[table] = Number(rows[0]?.count ?? '0');
    }

    // One TRUNCATE, so the foreign keys between them never have to be satisfied
    // in an intermediate state. `cascade` reaches `chapter_mastery`, which
    // references `chapters` and is student data that a cleared corpus would
    // orphan anyway.
    await client.query(`truncate table ${CONTENT_TABLES.join(', ')}, chapter_mastery cascade`);
    await client.query('drop table if exists chk_probe');
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  }

  return before;
}

async function main(): Promise<void> {
  // IMPORTED HERE, NOT AT THE TOP. `platform/config` validates the whole
  // environment and calls `process.exit(1)` when a variable is missing — which
  // is right for a server and wrong for a module the integration tests import
  // for its one exported function. A top-level import made loading this file
  // kill the test runner.
  const { config } = await import('../src/platform/config/index');
  const client = new pg.Client({ connectionString: config.db.url });
  await client.connect();
  try {
    const before = await clearContent(client);
    for (const [table, count] of Object.entries(before)) {
      process.stdout.write(`cleared ${table}: ${String(count)} rows\n`);
    }
    process.stdout.write('dropped chk_probe if it existed\n');
  } finally {
    await client.end();
  }
}

// Runs only when invoked as the entry point. `clearContent` is also imported
// by the integration tests, and a bare `main()` would have those tests wipe
// whatever database happened to be in `DATABASE_URL`.
const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`clear-content failed: ${message}\n`);
    process.exit(1);
  });
}
