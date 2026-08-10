import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyAllMigrations,
  readDownMigration,
  readMigration,
  splitStatements,
  startTestPostgres,
  type TestPostgres,
} from '../helpers/postgres';

/**
 * Migration 0008 — `tenant_id` becomes NOT NULL. Decision D-073.
 *
 * ===========================================================================
 * WHAT THIS MIGRATION IS FOR, RESTATED WHERE IT IS TESTED.
 *
 * 0004 added `tenant_id` NULLABLE with a default, and put the enforcement in
 * `platform/authz` under the rule "deny when BOTH sides carry a tenant and they
 * differ". D-073 records why that could not stay: `tenant_id` was added early to
 * AVOID a migration across every table once real student data exists, and a
 * nullable column with a lenient guard does not avoid that migration — it defers
 * it, while reading as complete. The cost is still owed and the tracker says it
 * is paid.
 *
 * ===========================================================================
 * THE COLUMN IS HALF THE CHANGE. The other half is in `platform/authz` (a
 * missing tenant on either side is now a deny) and in the three modules (every
 * insert supplies the tenant from the authenticated actor). Those are tested
 * where they live. THIS file tests the database: that the constraint exists on
 * every one of the six tables, that it actually refuses a null, and that the
 * migration goes forward, backward and forward again — plan §4, rule 4.
 */

let postgres: TestPostgres;

const DEFAULT_TENANT = '11111111-1111-4111-8111-111111111111';

/** The six tables D-073 names. Every one carries student data. */
const TENANTED_TABLES = [
  'users',
  'parent_child_links',
  'students',
  'student_subjects',
  'chapter_mastery',
  'question_responses',
] as const;

async function run(sql: string): Promise<void> {
  for (const statement of splitStatements(sql)) {
    await postgres.client.query(statement);
  }
}

async function isNullable(table: string): Promise<boolean> {
  const result = await postgres.client.query<{ is_nullable: string }>(
    `select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = $1 and column_name = 'tenant_id'`,
    [table],
  );
  return result.rows[0]?.is_nullable === 'YES';
}

async function columnDefault(table: string): Promise<string | null> {
  const result = await postgres.client.query<{ column_default: string | null }>(
    `select column_default from information_schema.columns
      where table_schema = 'public' and table_name = $1 and column_name = 'tenant_id'`,
    [table],
  );
  return result.rows[0]?.column_default ?? null;
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await applyAllMigrations(postgres.client);
}, 180_000);

afterAll(async () => {
  await postgres.stop();
}, 60_000);

describe('0008_tenant_not_null — forward', () => {
  it('makes tenant_id NOT NULL on all six student-owned tables', async () => {
    for (const table of TENANTED_TABLES) {
      expect({ table, nullable: await isNullable(table) }).toEqual({ table, nullable: false });
    }
  });

  it('KEEPS the column default, which is not the same as keeping the loophole', async () => {
    /**
     * The default stays for two reasons, and neither is "so inserts can skip it":
     * it is what makes `SET NOT NULL` a metadata-only change, and it keeps a
     * hand-written INSERT in a psql repair session working.
     *
     * Application inserts supply the tenant EXPLICITLY. That cannot be asserted
     * here — a default cannot tell "not supplied" from "supplied and equal to
     * the default" — so it is asserted where it can be: in
     * `learner.service.test.ts`, by moving an actor to a SECOND tenant and
     * checking the row follows. That is a claim the default cannot satisfy.
     */
    for (const table of TENANTED_TABLES) {
      expect(await columnDefault(table)).toContain(DEFAULT_TENANT);
    }
  });

  it('REFUSES an explicit null, which is the constraint doing its job', async () => {
    // The constraint is not the metadata row above, it is this. A column can be
    // reported NOT NULL by `information_schema` only if it really is, but
    // asserting on the behaviour rather than the catalogue is what survives a
    // future change to how the column is declared.
    await expect(
      postgres.client.query(
        `insert into users (email, password_hash, role, tenant_id)
           values ('null-tenant@example.test', 'x', 'student', null)`,
      ),
    ).rejects.toThrow(/null value in column "tenant_id"/);
  });

  it('still accepts an insert that omits the column, filling it from the default', async () => {
    // Every existing raw-SQL test fixture and every psql repair does this. If it
    // broke, the migration would have made the database stricter than the
    // product needs and every fixture would need rewriting.
    const result = await postgres.client.query<{ tenant_id: string }>(
      `insert into users (email, password_hash, role)
         values ('default-tenant@example.test', 'x', 'student')
         returning tenant_id`,
    );
    expect(result.rows[0]?.tenant_id).toBe(DEFAULT_TENANT);
  });

  it('leaves content untenanted — the corpus is shared curriculum', async () => {
    // `chapters`, `questions` and `rag_chunks` deliberately have no `tenant_id`
    // at all (0004). Tenanting NCERT would either duplicate the whole corpus per
    // customer or leave a column that is always the default and always ignored —
    // a filter everybody has to remember and nobody needs. A migration that
    // "tightened tenancy everywhere" would have added it here too.
    for (const table of ['chapters', 'questions', 'rag_chunks']) {
      const result = await postgres.client.query(
        `select 1 from information_schema.columns
          where table_schema = 'public' and table_name = $1 and column_name = 'tenant_id'`,
        [table],
      );
      expect(result.rowCount).toBe(0);
    }
  });

  it('leaves audit_log and notifications nullable, deliberately and on the record', async () => {
    /**
     * NOT AN OVERSIGHT, and worth an assertion so that it stays a decision.
     *
     * Neither is student-owned data reached through `assertCanAccess`, and
     * neither has a writer that knows a tenant: `audit_log` records system
     * actions whose actor is null by design (D-063), and the in-app notification
     * channel is handed a recipient and nothing else.
     *
     * Tightening them now would produce NOT NULL columns whose only writer
     * relies on the column default — theatre of exactly the kind D-073 rejects.
     * Tracked as an open item with the mechanism (resolve the tenant from the
     * recipient / the actor) rather than done badly here.
     */
    expect(await isNullable('audit_log')).toBe(true);
    expect(await isNullable('notifications')).toBe(true);
  });
});

describe('0008_tenant_not_null — the backfill', () => {
  it('fills a pre-existing null rather than failing on it', async () => {
    /**
     * The backfill is a no-op against a database built by this migration chain,
     * because 0004's column default already applied to every row. It is written
     * anyway, and this test is why: a migration that is correct only against a
     * database in one particular state fails the first time it meets another —
     * a row inserted by a script that named the column explicitly as null, say.
     *
     * So: roll the constraint off, create exactly that row, and re-apply.
     */
    await run(readDownMigration('0008_tenant_not_null.down.sql', 'superseded'));
    await postgres.client.query(
      `insert into users (email, password_hash, role, tenant_id)
         values ('legacy@example.test', 'x', 'student', null)`,
    );

    await run(readMigration('0008_tenant_not_null.sql', 'superseded'));

    const result = await postgres.client.query<{ tenant_id: string }>(
      `select tenant_id from users where email = 'legacy@example.test'`,
    );
    expect(result.rows[0]?.tenant_id).toBe(DEFAULT_TENANT);
    expect(await isNullable('users')).toBe(false);
  });

  it('is idempotent — applying it twice changes nothing and raises nothing', async () => {
    // `SET NOT NULL` on a column that already has the constraint is accepted and
    // does nothing, and every UPDATE is guarded by `where tenant_id is null`.
    // Migrations get re-run: by a retried deploy, by a harness, by a human who
    // is not sure whether the first attempt landed.
    await run(readMigration('0008_tenant_not_null.sql', 'superseded'));

    for (const table of TENANTED_TABLES) {
      expect(await isNullable(table)).toBe(false);
    }
  });
});

describe('0008_tenant_not_null — rollback and re-apply (plan §4, rule 4)', () => {
  it('rolls back to nullable, keeps every row, and re-applies cleanly', async () => {
    await postgres.client.query(
      `insert into users (email, password_hash, role)
         values ('survivor@example.test', 'x', 'student')`,
    );

    await run(readDownMigration('0008_tenant_not_null.down.sql', 'superseded'));

    for (const table of TENANTED_TABLES) {
      expect({ table, nullable: await isNullable(table) }).toEqual({ table, nullable: true });
    }

    // WHAT THE ROLLBACK LOSES: nothing in the data. Only the constraint comes
    // off — the column, its default, its foreign key and its index all survive,
    // and every row keeps the tenant it had. A "rollback" that dropped the
    // column would lose every row's tenant assignment.
    const survivor = await postgres.client.query<{ tenant_id: string | null }>(
      `select tenant_id from users where email = 'survivor@example.test'`,
    );
    expect(survivor.rows[0]?.tenant_id).toBe(DEFAULT_TENANT);
    expect(await columnDefault('users')).toContain(DEFAULT_TENANT);

    // Forward again. A rollback that cannot be followed by a re-apply is not a
    // rollback.
    await run(readMigration('0008_tenant_not_null.sql', 'superseded'));

    for (const table of TENANTED_TABLES) {
      expect({ table, nullable: await isNullable(table) }).toEqual({ table, nullable: false });
    }
  });
});

describe('the indexes tenant filtering needs already exist', () => {
  it('has a btree on tenant_id for every one of the six tables', async () => {
    /**
     * Created by 0004 and asserted here rather than there, because this is the
     * migration that makes the column something every read can rely on.
     *
     * "Every student in this tenant" is the first query a Phase 1 teacher screen
     * and a Phase 4 principal dashboard run. Building the index now costs
     * milliseconds; building it in eighteen months costs an index build on the
     * largest table in the product.
     */
    for (const table of TENANTED_TABLES) {
      const result = await postgres.client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'public' and tablename = $1`,
        [table],
      );
      const covering = result.rows.filter((row) => row.indexdef.includes('tenant_id'));
      expect({ table, indexed: covering.length > 0 }).toEqual({ table, indexed: true });
    }
  });
});
