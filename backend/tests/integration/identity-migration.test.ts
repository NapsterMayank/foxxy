import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readDownMigration,
  readMigration,
  splitStatements,
  startTestPostgres,
  type TestPostgres,
} from '../helpers/postgres';

/**
 * Build step 3 is done when "the migration applies and rolls back cleanly".
 * This is that check, against a real Postgres 16 + pgvector.
 *
 * Container startup pulls an image on a cold machine, hence the long timeout.
 */
let postgres: TestPostgres;

async function run(sql: string): Promise<void> {
  for (const statement of splitStatements(sql)) {
    await postgres.client.query(statement);
  }
}

async function tableNames(): Promise<string[]> {
  const result = await postgres.client.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await run(readMigration('0000_identity.sql', 'superseded'));
}, 180_000);

afterAll(async () => {
  await postgres.stop();
}, 60_000);

describe('0000_identity — forward', () => {
  it('creates every identity table', async () => {
    expect(await tableNames()).toEqual([
      'email_verification_tokens',
      'parent_child_links',
      'password_reset_tokens',
      'sessions',
      'users',
    ]);
  });

  it('enables the citext and vector extensions', async () => {
    const result = await postgres.client.query<{ extname: string }>(
      `select extname from pg_extension where extname in ('citext', 'vector') order by extname`,
    );
    expect(result.rows.map((row) => row.extname)).toEqual(['citext', 'vector']);
  });

  it('stores users.email as citext', async () => {
    const result = await postgres.client.query<{ udt_name: string }>(
      `select udt_name from information_schema.columns
        where table_name = 'users' and column_name = 'email'`,
    );
    expect(result.rows[0]?.udt_name).toBe('citext');
  });

  it('treats email as case-insensitive and unique', async () => {
    await postgres.client.query(
      `insert into users (email, password_hash, role) values ('Case@Example.com', 'x', 'student')`,
    );
    await expect(
      postgres.client.query(
        `insert into users (email, password_hash, role) values ('case@example.com', 'x', 'student')`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('rejects a role outside (student, parent)', async () => {
    await expect(
      postgres.client.query(
        `insert into users (email, password_hash, role) values ('teacher@example.com', 'x', 'teacher')`,
      ),
    ).rejects.toThrow(/users_role_check/);
  });

  it('enforces one link row per (parent, student) pair', async () => {
    const parent = await postgres.client.query<{ id: string }>(
      `insert into users (email, password_hash, role) values ('p1@example.com', 'x', 'parent') returning id`,
    );
    const student = await postgres.client.query<{ id: string }>(
      `insert into users (email, password_hash, role) values ('s1@example.com', 'x', 'student') returning id`,
    );
    const parentId = parent.rows[0]?.id;
    const studentId = student.rows[0]?.id;

    await postgres.client.query(
      `insert into parent_child_links (parent_user_id, student_user_id) values ($1, $2)`,
      [parentId, studentId],
    );
    await expect(
      postgres.client.query(
        `insert into parent_child_links (parent_user_id, student_user_id) values ($1, $2)`,
        [parentId, studentId],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('defaults a new link to pending — a code alone grants nothing', async () => {
    const result = await postgres.client.query<{ status: string }>(
      `select status from parent_child_links limit 1`,
    );
    expect(result.rows[0]?.status).toBe('pending');
  });

  it('rejects a link status outside (pending, approved, revoked)', async () => {
    await expect(
      postgres.client.query(`update parent_child_links set status = 'maybe'`),
    ).rejects.toThrow(/parent_child_links_status_check/);
  });

  it('rejects a session token hash that is already in use', async () => {
    const user = await postgres.client.query<{ id: string }>(
      `insert into users (email, password_hash, role) values ('s2@example.com', 'x', 'student') returning id`,
    );
    const userId = user.rows[0]?.id;
    await postgres.client.query(
      `insert into sessions (user_id, token_hash, expires_at) values ($1, 'hash-1', now() + interval '30 days')`,
      [userId],
    );
    await expect(
      postgres.client.query(
        `insert into sessions (user_id, token_hash, expires_at) values ($1, 'hash-1', now() + interval '30 days')`,
        [userId],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('cascades session deletion when the user is deleted', async () => {
    const user = await postgres.client.query<{ id: string }>(
      `insert into users (email, password_hash, role) values ('s3@example.com', 'x', 'student') returning id`,
    );
    const userId = user.rows[0]?.id;
    await postgres.client.query(
      `insert into sessions (user_id, token_hash, expires_at) values ($1, 'hash-cascade', now() + interval '1 day')`,
      [userId],
    );
    await postgres.client.query(`delete from users where id = $1`, [userId]);
    const remaining = await postgres.client.query(
      `select 1 from sessions where token_hash = 'hash-cascade'`,
    );
    expect(remaining.rowCount).toBe(0);
  });
});

describe('0000_identity — rollback', () => {
  it('drops every table it created, then re-applies cleanly', async () => {
    await run(readDownMigration('0000_identity.down.sql', 'superseded'));
    expect(await tableNames()).toEqual([]);

    // Forward again on the rolled-back schema: a rollback that cannot be
    // followed by a re-apply is not a rollback.
    await run(readMigration('0000_identity.sql', 'superseded'));
    expect(await tableNames()).toHaveLength(5);
  }, 60_000);
});
