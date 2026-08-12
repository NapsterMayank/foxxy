import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readDownMigration,
  readMigration,
  splitStatements,
  startTestPostgres,
  type TestPostgres,
} from '../helpers/postgres';

/**
 * Migration 0001 — resolves D-012.
 *
 * Plan §4, rule 4: every migration must run forward AND backward against a
 * copy of the schema. That is asserted at the bottom of this file.
 *
 * The rest of it is about the PARTIAL UNIQUE INDEX, because that index is the
 * entire reason the table exists. "One active code per student" was previously
 * a property of a cache key; moving it to a table only helps if the constraint
 * moves with it. A `link_codes` table without this index would be strictly
 * worse than the cache — durable, and unconstrained.
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

async function makeStudent(email: string): Promise<string> {
  const result = await postgres.client.query<{ id: string }>(
    `insert into users (email, password_hash, role) values ($1, 'x', 'student') returning id`,
    [email],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('failed to create the test student');
  return id;
}

async function issue(studentId: string, code: string): Promise<void> {
  await postgres.client.query(
    `insert into link_codes (student_user_id, code, expires_at)
       values ($1, $2, now() + interval '15 minutes')`,
    [studentId, code],
  );
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await run(readMigration('0000_identity.sql', 'superseded'));
  await run(readMigration('0001_link_codes.sql', 'superseded'));
}, 180_000);

afterAll(async () => {
  await postgres.stop();
}, 60_000);

describe('0001_link_codes — forward', () => {
  it('creates the link_codes table alongside the existing five', async () => {
    expect(await tableNames()).toEqual([
      'email_verification_tokens',
      'link_codes',
      'parent_child_links',
      'password_reset_tokens',
      'sessions',
      'users',
    ]);
  });

  it('drops code_expires_at from parent_child_links', async () => {
    const result = await postgres.client.query(
      `select column_name from information_schema.columns
        where table_name = 'parent_child_links' and column_name = 'code_expires_at'`,
    );
    expect(result.rowCount).toBe(0);
  });

  it('KEEPS link_code on parent_child_links as the historical record', async () => {
    // Which code created the link is worth knowing. When it expired is not —
    // that belonged to the code, and the code now has its own row.
    const result = await postgres.client.query(
      `select column_name from information_schema.columns
        where table_name = 'parent_child_links' and column_name = 'link_code'`,
    );
    expect(result.rowCount).toBe(1);
  });
});

describe('the partial unique index — "one active code per student"', () => {
  it('allows a student their first code', async () => {
    const student = await makeStudent('one@example.test');
    await expect(issue(student, 'AAAAAA')).resolves.toBeUndefined();
  });

  it('REFUSES a second unconsumed code for the same student', async () => {
    // The rule enforced by Postgres rather than promised by the application.
    // Two concurrent issue requests cannot both win, and no future code path
    // can forget it.
    const student = await makeStudent('two@example.test');
    await issue(student, 'BBBBBB');
    await expect(issue(student, 'CCCCCC')).rejects.toThrow(
      /link_codes_one_active_per_student/,
    );
  });

  it('allows a new code once the previous one is consumed', async () => {
    const student = await makeStudent('three@example.test');
    await issue(student, 'DDDDDD');
    await postgres.client.query(
      `update link_codes set consumed_at = now() where student_user_id = $1`,
      [student],
    );
    await expect(issue(student, 'EEEEEE')).resolves.toBeUndefined();
  });

  it('lets consumed rows accumulate without ever blocking a new code', async () => {
    // The audit trail must not become a denial of service against the student.
    const student = await makeStudent('four@example.test');
    for (const code of ['FFFFFF', 'GGGGGG', 'HHHHHH']) {
      await issue(student, code);
      await postgres.client.query(
        `update link_codes set consumed_at = now() where student_user_id = $1 and consumed_at is null`,
        [student],
      );
    }
    const count = await postgres.client.query(
      `select count(*)::int as count from link_codes where student_user_id = $1`,
      [student],
    );
    expect((count.rows[0] as { count: number }).count).toBe(3);
  });

  it('does not restrict DIFFERENT students to one code between them', async () => {
    const first = await makeStudent('five@example.test');
    const second = await makeStudent('six@example.test');
    await issue(first, 'JJJJJJ');
    await expect(issue(second, 'KKKKKK')).resolves.toBeUndefined();
  });
});

describe('the global code uniqueness', () => {
  it('refuses the same code for two students', async () => {
    // A parent submits a bare code with no student id, so the code alone has
    // to identify the student. Two students holding 'LLLLLL' would make the
    // submission ambiguous — and ambiguity here means linking a parent to the
    // wrong child.
    const first = await makeStudent('seven@example.test');
    const second = await makeStudent('eight@example.test');
    await issue(first, 'LLLLLL');
    await expect(issue(second, 'LLLLLL')).rejects.toThrow(/link_codes_code_unique/);
  });
});

describe('durability — the reason this table exists at all (D-012)', () => {
  it('survives as a row, so a restart cannot invalidate an outstanding code', async () => {
    // The cache implementation lost every outstanding code on restart, and a
    // parent entering a code their child had just read aloud was told it was
    // invalid. A row does not evaporate.
    const student = await makeStudent('nine@example.test');
    await issue(student, 'MMMMMM');
    const result = await postgres.client.query<{ code: string; consumed_at: Date | null }>(
      `select code, consumed_at from link_codes where student_user_id = $1`,
      [student],
    );
    expect(result.rows[0]?.code).toBe('MMMMMM');
    expect(result.rows[0]?.consumed_at).toBeNull();
  });

  it('cascades codes away when the student is deleted', async () => {
    const student = await makeStudent('ten@example.test');
    await issue(student, 'NNNNNN');
    await postgres.client.query(`delete from users where id = $1`, [student]);
    const remaining = await postgres.client.query(
      `select 1 from link_codes where code = 'NNNNNN'`,
    );
    expect(remaining.rowCount).toBe(0);
  });
});

describe('0001_link_codes — rollback', () => {
  it('restores code_expires_at, drops link_codes, and re-applies cleanly', async () => {
    await run(readDownMigration('0001_link_codes.down.sql', 'superseded'));

    expect(await tableNames()).not.toContain('link_codes');
    const restored = await postgres.client.query(
      `select column_name from information_schema.columns
        where table_name = 'parent_child_links' and column_name = 'code_expires_at'`,
    );
    expect(restored.rowCount).toBe(1);

    // Forward again on the rolled-back schema: a rollback that cannot be
    // followed by a re-apply is not a rollback.
    await run(readMigration('0001_link_codes.sql', 'superseded'));
    expect(await tableNames()).toContain('link_codes');
  }, 60_000);
});
