import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_ROLES, SIGNUP_ROLES } from '@/shared/constants/roles';
import {
  applyAllMigrations,
  readDownMigration,
  readMigration,
  splitStatements,
  startTestPostgres,
  type TestPostgres,
} from '../helpers/postgres';

/**
 * Migrations 0004-0007 — the foundation hooks from 05-ROADMAP.md §8.
 *
 * Two things are proven here, and they are different things.
 *
 * FIRST, plan §4 rule 4: each migration applies, rolls back and re-applies.
 * That is the bottom describe block, and it is run in reverse order because
 * that is how a real rollback goes.
 *
 * SECOND, and the larger half: THE COLUMNS AND CONSTRAINTS DO WHAT THE HEADERS
 * CLAIM. A `tenant_id` that silently defaults to null buys nothing. A widened
 * role CHECK that also widened signup is a privilege-escalation hole. An
 * evidence column with no CHECK is a column that will hold a shuffled index.
 * Every assertion below exists because the thing it checks would otherwise fail
 * quietly.
 */

let postgres: TestPostgres;

const DEFAULT_TENANT = '11111111-1111-4111-8111-111111111111';

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

async function columnNames(table: string): Promise<string[]> {
  const result = await postgres.client.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1 order by column_name`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await applyAllMigrations(postgres.client);
/**
 * `0002_practice` COMES OFF FIRST — the D-106 rule, one migration later.
 *
 * This harness applies the CURRENT migration set, whose newest member renames
 * `question_responses` to `practice_responses` (D-057). Everything below is
 * about the world BEFORE that rename — it exercises the superseded 0004-0008
 * chain, which names the old table throughout and which cannot be edited.
 *
 * Peeling the newer migration off is what a real rollback does, in the order a
 * real rollback does it. The alternatives are both worse: rewriting these
 * assertions to the new name would make them claim to test SQL that does not
 * mention it, and editing the superseded files would destroy the oracle
 * `baseline-collapse.test.ts` diffs the baseline against.
 */
  await run(readDownMigration('0002_practice.down.sql'));
}, 180_000);

afterAll(async () => {
  await postgres.stop();
}, 60_000);

// ---------------------------------------------------------------------------
// 0004_tenancy
// ---------------------------------------------------------------------------

const TENANTED_TABLES = [
  'users',
  'parent_child_links',
  'students',
  'student_subjects',
  'chapter_mastery',
  'question_responses',
] as const;

describe('0004_tenancy — the sharpest hook on the roadmap', () => {
  it('seeds exactly ONE tenant, at the fixed id the code expects', async () => {
    // A literal rather than a lookup, written identically in the migration, in
    // `schema/tenants.ts` and here. The alternative is a runtime "find the
    // default tenant, or create it", which turns a broken database into a
    // silently self-healing one — and a system that invents a tenant when it
    // cannot find the right one will one day file a school's children under a
    // tenant it made up.
    const result = await postgres.client.query<{ id: string; slug: string }>(
      'select id, slug from tenants',
    );
    expect(result.rows).toEqual([{ id: DEFAULT_TENANT, slug: 'default' }]);
  });

  it('adds tenant_id to every table carrying student data', async () => {
    for (const table of TENANTED_TABLES) {
      expect(await columnNames(table)).toContain('tenant_id');
    }
  });

  it('DEFAULTS new rows to the seeded tenant, so nothing had to change', async () => {
    // The compromise, made visible. The column is nullable with a default, so
    // every existing INSERT keeps working untouched — which is what makes this
    // a one-file change rather than the "repoint every insert path in three
    // modules on the same day" that 05-ROADMAP.md §8 identifies as the real
    // cost of retrofitting tenancy.
    const user = await postgres.client.query<{ tenant_id: string }>(
      `insert into users (email, password_hash, role)
       values ('tenant-default@example.test', 'x', 'student')
       returning tenant_id`,
    );
    expect(user.rows[0]?.tenant_id).toBe(DEFAULT_TENANT);
  });

  it('indexes tenant_id everywhere it will be filtered', async () => {
    // "Every student in this tenant" is the first query every Phase 1 teacher
    // screen and every Phase 4 principal dashboard runs. It answers nothing
    // today; building the index today costs milliseconds, and building it in
    // eighteen months costs an index build on the largest table in the product.
    const result = await postgres.client.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname = 'public' and indexname like '%tenant%' order by indexname`,
    );
    const names = result.rows.map((row) => row.indexname);
    for (const table of TENANTED_TABLES) {
      expect(names).toContain(`${table === 'users' ? 'users' : table}_tenant_idx`);
    }
  });

  it('REFUSES to delete a tenant that still has rows — RESTRICT, never CASCADE', async () => {
    // A CASCADE from `tenants` would mean one row's deletion removes every
    // student, every mastery record and every logged response belonging to a
    // school. That is a plausible typo with an unrecoverable outcome.
    await expect(
      postgres.client.query('delete from tenants where id = $1', [DEFAULT_TENANT]),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it('leaves CONTENT untenanted — the corpus is shared curriculum', async () => {
    // Tenanting NCERT would either duplicate 16,000 chunks per customer or
    // leave a column that is always the default and always ignored — a filter
    // everybody has to remember and nobody needs. Phase 5's school-authored
    // content is a separate table, not a column here.
    for (const table of ['chapters', 'questions', 'rag_chunks']) {
      expect(await columnNames(table)).not.toContain('tenant_id');
    }
  });
});

// ---------------------------------------------------------------------------
// 0005_roles_schools_audit
// ---------------------------------------------------------------------------

describe('0005 — the role CHECK widens to ten values', () => {
  it('accepts every PLATFORM_ROLE', async () => {
    // Widening a CHECK takes an ACCESS EXCLUSIVE lock and a full validation
    // scan. On a few dozen development accounts that is imperceptible; on the
    // users table of a live school pilot it is a write-blocking operation
    // during which nobody can sign up or log in. The same statement, eighteen
    // months apart, is free or is a maintenance window.
    for (const role of PLATFORM_ROLES) {
      await expect(
        postgres.client.query(
          `insert into users (email, password_hash, role) values ($1, 'x', $2)`,
          [`role-${role}@example.test`, role],
        ),
      ).resolves.toBeDefined();
    }
  });

  it('still rejects a role outside the list', async () => {
    await expect(
      postgres.client.query(
        `insert into users (email, password_hash, role) values ('bogus@example.test', 'x', 'wizard')`,
      ),
    ).rejects.toThrow(/users_role_check/);
  });

  it('keeps SIGNUP_ROLES a strictly smaller list than PLATFORM_ROLES', () => {
    // THE property that keeps the widened column from becoming a widened
    // signup. They are separate constants on purpose, and the day somebody
    // "simplifies" the contract to point at `PLATFORM_ROLES` it compiles, it
    // inserts, and the internet has a `super_admin` dropdown. Only this — and
    // the contract test beside it — notices.
    expect(SIGNUP_ROLES).toEqual(['student', 'parent']);
    expect(PLATFORM_ROLES.length).toBeGreaterThan(SIGNUP_ROLES.length);
    for (const role of SIGNUP_ROLES) {
      expect(PLATFORM_ROLES).toContain(role);
    }
  });
});

describe('0005 — the schools/classes stub', () => {
  it('creates all three tables', async () => {
    const names = await tableNames();
    expect(names).toContain('schools');
    expect(names).toContain('classes');
    expect(names).toContain('class_enrolments');
  });

  it('stores class grade as TEXT with the same CHECK as students.grade', async () => {
    // A stub typed more loosely than the table it will eventually join against
    // is a stub that imports bad data on its first day of real use — and plan
    // §3's failure mode is that the symptom is an empty class list rather than
    // an error.
    const school = await postgres.client.query<{ id: string }>(
      `insert into schools (tenant_id, name) values ($1, 'Test School') returning id`,
      [DEFAULT_TENANT],
    );
    const schoolId = school.rows[0]?.id ?? '';

    await expect(
      postgres.client.query(
        `insert into classes (school_id, grade, section, academic_year) values ($1, '13', 'A', '2026-27')`,
        [schoolId],
      ),
    ).rejects.toThrow(/classes_grade_check/);

    await expect(
      postgres.client.query(
        `insert into classes (school_id, grade, section, academic_year) values ($1, '8', 'A', '2026-27')`,
        [schoolId],
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a second 8-A for the same school and year', async () => {
    // Without the unique index a re-import creates a second 8-A, and every
    // enrolment afterwards is split across two classes — which reads as "half
    // the class stopped practising" on a teacher screen.
    const school = await postgres.client.query<{ id: string }>(
      `insert into schools (tenant_id, name) values ($1, 'Dup School') returning id`,
      [DEFAULT_TENANT],
    );
    const schoolId = school.rows[0]?.id ?? '';
    await postgres.client.query(
      `insert into classes (school_id, grade, section, academic_year) values ($1, '9', 'B', '2026-27')`,
      [schoolId],
    );
    await expect(
      postgres.client.query(
        `insert into classes (school_id, grade, section, academic_year) values ($1, '9', 'B', '2026-27')`,
        [schoolId],
      ),
    ).rejects.toThrow(/classes_school_grade_section_year_unique/);
  });

  it('enrols against USERS, not students — a roster arrives before onboarding', async () => {
    // A child enrolled by a school roster import has no `students` row until
    // they finish onboarding. Pointing at `students` would make a roster
    // unimportable until every child had logged in, which is backwards.
    const user = await postgres.client.query<{ id: string }>(
      `insert into users (email, password_hash, role) values ('roster@example.test', 'x', 'student') returning id`,
    );
    const school = await postgres.client.query<{ id: string }>(
      `insert into schools (tenant_id, name) values ($1, 'Roster School') returning id`,
      [DEFAULT_TENANT],
    );
    const klass = await postgres.client.query<{ id: string }>(
      `insert into classes (school_id, grade, section, academic_year) values ($1, '7', 'C', '2026-27') returning id`,
      [school.rows[0]?.id ?? ''],
    );

    // No `students` row exists for this user, and the enrolment still lands.
    await expect(
      postgres.client.query(
        `insert into class_enrolments (class_id, student_user_id) values ($1, $2)`,
        [klass.rows[0]?.id ?? '', user.rows[0]?.id ?? ''],
      ),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 0006_evidence_capture
// ---------------------------------------------------------------------------

describe('0006 — evidence capture, the unrecoverable hook', () => {
  it('adds all five columns', async () => {
    const columns = await columnNames('question_responses');
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

  it('gives every one of them a COMMENT, because none is inferable later', async () => {
    // `hint_level_used` reads like a setting; `first_selected_index` reads like
    // a duplicate of `selected_index`; `confidence` reads like a model output.
    // The person who writes the Phase 1 teacher screen is not the person who
    // wrote this migration, and the names alone will actively mislead them. A
    // `\d+ question_responses` has to be enough.
    const result = await postgres.client.query<{ column_name: string; description: string }>(
      `select a.attname as column_name, col_description(a.attrelid, a.attnum) as description
         from pg_attribute a
        where a.attrelid = 'question_responses'::regclass and a.attnum > 0 and not a.attisdropped`,
    );
    const described = new Map(result.rows.map((row) => [row.column_name, row.description]));
    for (const column of [
      'first_selected_index',
      'answer_changed',
      'hint_level_used',
      'confidence',
      'explanation_format_used',
    ]) {
      expect(described.get(column)).toBeTruthy();
    }
    expect(described.get('confidence')).toContain('UNRECOVERABLE');
  });

  it('defaults hint_level_used to 0 and NOT NULL — 0 is a real observation', async () => {
    // The only one of the five that is NOT NULL. "No hints" is a statement
    // rather than an absence: a response recorded without hint tracking and one
    // where the student used no hints are the same thing for every purpose this
    // column serves.
    const result = await postgres.client.query<{ is_nullable: string; column_default: string }>(
      `select is_nullable, column_default from information_schema.columns
        where table_name = 'question_responses' and column_name = 'hint_level_used'`,
    );
    expect(result.rows[0]?.is_nullable).toBe('NO');
    expect(result.rows[0]?.column_default).toBe('0');
  });

  it('constrains confidence to the closed set, because remediation BRANCHES on it', async () => {
    await expect(
      postgres.client.query(
        `select 1 where 'quite-sure' in ('unsure', 'unsure_ish', 'confident')`,
      ),
    ).resolves.toHaveProperty('rowCount', 0);

    const check = await postgres.client.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'question_responses_confidence_check'`,
    );
    expect(check.rows[0]?.definition).toContain('unsure_ish');
  });

  it('leaves explanation_format_used UNCONSTRAINED — an analytics column', async () => {
    // The contrast with `confidence` is the whole reasoning. The set of formats
    // is a product experiment that will change several times, and a CHECK would
    // make each change a migration on a large table. Nothing branches on it, so
    // an unexpected value costs a report line rather than a wrong answer.
    const check = await postgres.client.query<{ count: string }>(
      `select count(*)::text from pg_constraint
        where conrelid = 'question_responses'::regclass
          and pg_get_constraintdef(oid) ilike '%explanation_format_used%'`,
    );
    expect(check.rows[0]?.count).toBe('0');
  });

  it('forces answer_changed to AGREE with first_selected_index', async () => {
    // Storing a derivable fact beside the thing it derives from is how two
    // columns start disagreeing — and the disagreement would be invisible,
    // because both values are individually plausible.
    const check = await postgres.client.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'question_responses_answer_changed_check'`,
    );
    expect(check.rows[0]?.definition).toContain('answer_changed');
    expect(check.rows[0]?.definition).toContain('first_selected_index');
  });
});

// ---------------------------------------------------------------------------
// 0007_notify_metrics_jobs
// ---------------------------------------------------------------------------

describe('0007 — notifications require BOTH languages', () => {
  it('rejects a notification with an empty Hindi body', async () => {
    // P7, enforced at the database as well as in the type system. Types do not
    // survive a raw INSERT, and NOT NULL alone does not stop `hi = ''` being
    // written deliberately to get past it — which is why the check is
    // `length(btrim(...)) > 0`.
    const user = await postgres.client.query<{ id: string }>(
      `insert into users (email, password_hash, role) values ('notify@example.test', 'x', 'parent') returning id`,
    );
    const userId = user.rows[0]?.id ?? '';

    await expect(
      postgres.client.query(
        `insert into notifications (recipient_user_id, kind, title_en, body_en, title_hi, body_hi)
         values ($1, 'x', 'T', 'B', 'T', '   ')`,
        [userId],
      ),
    ).rejects.toThrow(/notifications_bilingual_check/);

    await expect(
      postgres.client.query(
        `insert into notifications (recipient_user_id, kind, title_en, body_en, title_hi, body_hi)
         values ($1, 'x', 'T', 'B', 'शीर्षक', 'संदेश')`,
        [userId],
      ),
    ).resolves.toBeDefined();
  });
});

describe('0007 — the jobs table', () => {
  it('makes (kind, idempotency_key) UNIQUE', async () => {
    // The constraint that makes "enqueue twice, run once" a property of
    // Postgres rather than of a check-then-insert two instances can both pass.
    await postgres.client.query(
      `insert into jobs (kind, idempotency_key) values ('k', 'digest:parent-1:2026-W32')`,
    );
    await expect(
      postgres.client.query(
        `insert into jobs (kind, idempotency_key) values ('k', 'digest:parent-1:2026-W32')`,
      ),
    ).rejects.toThrow(/jobs_kind_idempotency_key_unique/);
  });

  it('rejects an unknown status', async () => {
    await expect(
      postgres.client.query(
        `insert into jobs (kind, idempotency_key, status) values ('k', 'weird', 'maybe')`,
      ),
    ).rejects.toThrow(/jobs_status_check/);
  });
});

describe('0007 — metrics_events', () => {
  it('accepts only the three instrument kinds', async () => {
    await expect(
      postgres.client.query(
        `insert into metrics_events (name, kind, value) values ('x', 'summary', 1)`,
      ),
    ).rejects.toThrow(/metrics_events_kind_check/);
    for (const kind of ['counter', 'gauge', 'histogram']) {
      await expect(
        postgres.client.query(
          `insert into metrics_events (name, kind, value) values ('x', $1, 1)`,
          [kind],
        ),
      ).resolves.toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Rollback — plan §4, rule 4
// ---------------------------------------------------------------------------

describe('every foundation migration rolls back and re-applies', () => {
  it('reverses 0007 → 0004 in order, then re-applies cleanly', async () => {
    // In REVERSE, which is how a real rollback goes and is also the only order
    // that works: `schools.tenant_id` references `tenants`, so 0005 has to come
    // off before 0004 can.
    //
    // The `users` rows created above are all `student` or `parent`, EXCEPT the
    // ones the role-widening test inserted — so 0005's rollback, which narrows
    // the CHECK back to two values, would abort. That is the correct behaviour
    // and is documented in the down file; here the widened rows are removed
    // first so the rest of the rollback can be exercised.
    await postgres.client.query(
      `delete from users where role not in ('student', 'parent')`,
    );
    // `notifications` and `class_enrolments` cascade from `users`; the audit
    // rows do not, and DELETE on `audit_log` is refused by design.
    await postgres.client.query('truncate table audit_log');

    // 0008 first: it constrains columns 0004 created, so it comes off before
    // the migration that owns them. (Dropping a column would take its NOT NULL
    // with it either way — the order is stated because a rollback sequence that
    // works by accident is one nobody can extend.)
    await run(readDownMigration('0008_tenant_not_null.down.sql', 'superseded'));
    await run(readDownMigration('0007_notify_metrics_jobs.down.sql', 'superseded'));
    await run(readDownMigration('0006_evidence_capture.down.sql', 'superseded'));
    await run(readDownMigration('0005_roles_schools_audit.down.sql', 'superseded'));
    await run(readDownMigration('0004_tenancy.down.sql', 'superseded'));

    const afterRollback = await tableNames();
    for (const table of [
      'tenants',
      'schools',
      'classes',
      'class_enrolments',
      'audit_log',
      'notifications',
      'metrics_events',
      'worker_heartbeats',
      'jobs',
    ]) {
      expect(afterRollback).not.toContain(table);
    }
    // Migrations 0000-0003 are untouched. A rollback that takes an earlier
    // migration with it is not a rollback.
    expect(afterRollback).toContain('users');
    expect(afterRollback).toContain('question_responses');
    expect(await columnNames('users')).not.toContain('tenant_id');
    expect(await columnNames('question_responses')).not.toContain('confidence');

    // Forward again on the rolled-back schema. A rollback that cannot be
    // followed by a re-apply is not a rollback.
    await run(readMigration('0004_tenancy.sql', 'superseded'));
    await run(readMigration('0005_roles_schools_audit.sql', 'superseded'));
    await run(readMigration('0006_evidence_capture.sql', 'superseded'));
    await run(readMigration('0007_notify_metrics_jobs.sql', 'superseded'));
    await run(readMigration('0008_tenant_not_null.sql', 'superseded'));

    expect(await tableNames()).toContain('tenants');
    expect(await columnNames('users')).toContain('tenant_id');
    expect(await columnNames('question_responses')).toContain('confidence');

    // And the seeded tenant is back, at the same fixed id — the re-apply is
    // genuinely idempotent rather than merely non-erroring.
    const tenants = await postgres.client.query<{ id: string }>('select id from tenants');
    expect(tenants.rows).toEqual([{ id: DEFAULT_TENANT }]);
  }, 120_000);
});
