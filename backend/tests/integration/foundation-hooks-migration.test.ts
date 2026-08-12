import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_ROLES, SIGNUP_ROLES } from '@/shared/constants/roles';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../helpers/postgres';

/**
 * THE FOUNDATION HOOKS — 05-ROADMAP.md §8 — AS PROPERTIES OF THE APPLIED
 * SCHEMA, not as assertions about particular migration files.
 *
 * ===========================================================================
 * WHY THIS FILE WAS REWRITTEN, AND WHAT THE DEFECT ACTUALLY WAS (D-075, fifth
 * occurrence).
 *
 * It used to be called "migrations 0004-0007". It applied the current set, then
 * PEELED THE NEWEST MIGRATION BACK OFF in `beforeAll` to reach the world those
 * superseded files described, and its last test rolled the superseded 0004-0008
 * chain backwards by name. Every new migration broke it, and every previous
 * repair was the same repair: add one more `readDownMigration(...)` line. It
 * had been patched that way for `0002_practice` (D-106) and it broke again the
 * moment `0003_parent` landed.
 *
 * The peel was never the point. Everything below is a property of the schema
 * this product actually ships — tenancy is real and defaulted, the role CHECK
 * is wide while signup is narrow, the evidence columns are documented and
 * constrained, notifications require both languages, jobs deduplicate. Those
 * properties are asserted here against WHATEVER `applyAllMigrations()`
 * produces, discovered from the directory and cross-checked against Drizzle's
 * journal. A migration added tomorrow needs no edit to this file; a migration
 * that BREAKS one of these properties fails here, which is the only thing this
 * file was ever for.
 *
 * The rollback half moved to `migration-round-trip.test.ts`, generalised. See
 * the note at the bottom of this file for what was deleted and why.
 *
 * ===========================================================================
 * THE TABLE IS `practice_responses`, NOT `question_responses`.
 *
 * `0002_practice` renamed it (D-057), carrying every evidence column, comment
 * and CHECK across. The old name is the pre-rename world, and this file no
 * longer pretends to live there — the superseded SQL that spells it
 * `question_responses` is still exercised verbatim, as an oracle, by
 * `baseline-collapse.test.ts`.
 */

let postgres: TestPostgres;

const DEFAULT_TENANT = '11111111-1111-4111-8111-111111111111';

/** The evidence table, post-rename. One name, used everywhere below. */
const RESPONSES = 'practice_responses';

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
  // THE WHOLE SET, AND NOTHING PEELED OFF IT. `applyAllMigrations` discovers
  // the migrations from the directory and cross-checks Drizzle's journal, so
  // this line is already correct for every migration that will ever be added.
  await applyAllMigrations(postgres.client);
}, 180_000);

afterAll(async () => {
  await postgres.stop();
}, 60_000);

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

const TENANTED_TABLES = [
  'users',
  'parent_child_links',
  'students',
  'student_subjects',
  'chapter_mastery',
  RESPONSES,
] as const;

describe('tenancy — the sharpest hook on the roadmap', () => {
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
// Roles, schools and audit
// ---------------------------------------------------------------------------

describe('the role CHECK carries ten values', () => {
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

describe('the schools/classes stub', () => {
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
// Evidence capture
// ---------------------------------------------------------------------------

describe('evidence capture — the unrecoverable hook', () => {
  it('carries all five columns', async () => {
    const columns = await columnNames(RESPONSES);
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
    // `\d+ practice_responses` has to be enough.
    const result = await postgres.client.query<{ column_name: string; description: string }>(
      `select a.attname as column_name, col_description(a.attrelid, a.attnum) as description
         from pg_attribute a
        where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped`,
      [RESPONSES],
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
        where table_name = $1 and column_name = 'hint_level_used'`,
      [RESPONSES],
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
        where conname = $1`,
      [`${RESPONSES}_confidence_check`],
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
        where conrelid = $1::regclass
          and pg_get_constraintdef(oid) ilike '%explanation_format_used%'`,
      [RESPONSES],
    );
    expect(check.rows[0]?.count).toBe('0');
  });

  it('forces answer_changed to AGREE with first_selected_index', async () => {
    // Storing a derivable fact beside the thing it derives from is how two
    // columns start disagreeing — and the disagreement would be invisible,
    // because both values are individually plausible.
    const check = await postgres.client.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = $1`,
      [`${RESPONSES}_answer_changed_check`],
    );
    expect(check.rows[0]?.definition).toContain('answer_changed');
    expect(check.rows[0]?.definition).toContain('first_selected_index');
  });
});

// ---------------------------------------------------------------------------
// Notifications, jobs and metrics
// ---------------------------------------------------------------------------

describe('notifications require BOTH languages', () => {
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

describe('the jobs table', () => {
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

describe('metrics_events', () => {
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
// DELETED: `every foundation migration rolls back and re-applies`
//
// It rolled the SUPERSEDED 0004-0008 chain backwards by name and forwards
// again. Three reasons it is gone rather than repaired:
//
//  1. IT ASSERTED A FICTION. Those five migrations no longer exist as discrete
//     steps. The deployed history is `0000_baseline`, which was collapsed out
//     of them (D-091). Nothing will ever roll 0007 back to 0006 again, in any
//     environment, so "that sequence still works" is not a fact about this
//     product — and a test whose subject cannot occur is a test that can only
//     ever cost maintenance.
//
//  2. IT WAS THE D-075 SHAPE, expressed as ten statements instead of an array
//     so the lint rule could not see it. Ten hand-ordered migration names IS a
//     list; writing it vertically does not change what it claims. The rule has
//     since been strengthened to count them (see `eslint.config.js`).
//
//  3. THE PROPERTY IT WAS REACHING FOR IS BETTER TESTED GENERICALLY. Plan §4
//     rule 4 — every migration applies, reverses and re-applies — now lives in
//     `migration-round-trip.test.ts`, driven by `listMigrations()`. It covers
//     the CURRENT set, which is the set anyone can actually roll back, and it
//     covers `0003_parent` and everything after it with no edit.
//
// The superseded chain is not abandoned: `baseline-collapse.test.ts` still
// applies all nine of those files verbatim and diffs the resulting catalogue
// against the baseline's. That is the oracle, and it is the only job those
// files still have.
// ---------------------------------------------------------------------------
