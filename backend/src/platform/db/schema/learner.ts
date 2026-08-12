import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { GRADES, LANGUAGES } from '../../../shared/constants/curriculum';
import { chapters } from './content';
import { users } from './identity';
import { DEFAULT_TENANT_ID, tenants } from './tenants';

/**
 * learner schema — 01-BACKEND-IMPLEMENTATION-PLAN.md §4, "learner".
 *
 * Owns the student profile, the subjects they study, and their mastery per
 * chapter. Assigned the `core` connection pool (04-RESILIENCE-PLAN.md §3.1,
 * wired in `src/app/module-pools.ts`).
 */

const gradeList = sql.raw(GRADES.map((grade) => `'${grade}'`).join(', '));
const languageList = sql.raw(LANGUAGES.map((language) => `'${language}'`).join(', '));

/**
 * The student profile.
 *
 * `user_id` is BOTH the primary key and the foreign key: a student profile has
 * no identity of its own, it is the learner-shaped view of a user. A separate
 * surrogate id would allow two profiles for one user, which nothing in the
 * product means and every query would then have to defend against.
 *
 * GRADE IS TEXT, and the CHECK is the enforcement (plan §3, §8.2). Storing it
 * as an integer is the single most repeated defect in the previous codebase:
 * `"6" !== 6` silences a filter rather than erroring, so the symptom is an
 * empty question list rather than a stack trace.
 *
 * WHAT THE DATABASE CAN AND CANNOT DO HERE — established by a test, after the
 * first draft of this comment claimed more than was true.
 *
 * It CAN enforce the value domain. The CHECK rejects any string outside
 * "6".."12", including the near-misses a bulk import produces: "05", "6 ",
 * "Class 6", "13".
 *
 * It CANNOT enforce the caller's TYPE. `insert ... values (6)` with a bare
 * integer literal SUCCEEDS and stores '6', because Postgres has an assignment
 * cast from integer to text and applies it silently. node-postgres reaches the
 * same place by another road, serialising a JavaScript `6` as an untyped
 * parameter that Postgres infers as text.
 *
 * So the value in the column is always right, and "grade 6 as a NUMBER is
 * rejected" (§8.2) is a rule only the learner module's Zod contract can
 * enforce. That contract is not a convenience wrapper — it is the only thing
 * standing between a JSON number and a grade column, and this note exists so
 * nobody deletes it believing the CHECK has it covered.
 */
export const students = pgTable(
  'students',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    grade: text('grade').notNull(),
    board: text('board').notNull().default('CBSE'),
    preferredLanguage: text('preferred_language').notNull().default('en'),
    /**
     * WHICH SCHOOL'S STUDENT THIS IS — 05-ROADMAP.md §8, `schema/tenants.ts`.
     *
     * Nullable with a default today, and it is the SINGLE most important of the
     * six tenant columns: everything else a school could see about a child
     * hangs off this row.
     */
    tenantId: uuid('tenant_id')
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('students_grade_check', sql`${table.grade} in (${gradeList})`),
    check('students_preferred_language_check', sql`${table.preferredLanguage} in (${languageList})`),
    check('students_display_name_check', sql`length(btrim(${table.displayName})) > 0`),
    /**
     * "Every student in this school" — the read every Phase 1 teacher screen
     * and every Phase 4 principal dashboard opens with. It answers nothing
     * today, which is the point: adding it now costs one line, and adding it
     * later costs an index build on the largest table in the product.
     */
    index('students_tenant_idx').on(table.tenantId),
  ],
);

/**
 * Which subjects a student studies. Composite PK on (student, subject) — a
 * student either studies a subject or does not, so there is nothing to
 * distinguish two rows and no surrogate id to add.
 *
 * `subject_code` is deliberately unconstrained text rather than an enum or an
 * FK to a subjects table. The CBSE subject set differs by grade and stream and
 * is expected to grow; a new subject must not require a migration. The content
 * module owns the canonical list.
 */
export const studentSubjects = pgTable(
  'student_subjects',
  {
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => students.userId, { onDelete: 'cascade' }),
    subjectCode: text('subject_code').notNull(),
    /** Denormalised from `students` — see `schema/tenants.ts`. */
    tenantId: uuid('tenant_id')
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'student_subjects_pkey',
      columns: [table.studentUserId, table.subjectCode],
    }),
    check('student_subjects_subject_code_check', sql`length(btrim(${table.subjectCode})) > 0`),
    index('student_subjects_tenant_idx').on(table.tenantId),
  ],
);

/**
 * Mastery per chapter, on a 0..1 scale.
 *
 * `numeric(4, 3)` rather than `double precision`: the value is compared
 * against thresholds and shown to a parent, and binary floating point makes
 * "0.8 or above" a question about representation. Four digits with three after
 * the point holds 0.000 to 1.000 exactly, and the CHECK closes both ends.
 *
 * §8.2 says "mastery clamps to 0..1". CLAMPING IS THE MODULE'S JOB; the CHECK
 * is the backstop that turns a clamping bug into a loud failure instead of a
 * mastery of 1.4 sitting in a parent report. Both, not either.
 *
 * ON INDEXES, because the obvious one is the wrong one.
 *
 * There is deliberately NO separate index on `student_user_id`: the composite
 * primary key is a btree whose LEADING column is `student_user_id`, so every
 * `where student_user_id = $1` lookup — which is how a progress screen reads
 * this table — is already index-backed. A second index on the same leading
 * column would cost every write and answer no query the first cannot. A test
 * asserts the lookup plan uses an index scan, which pins the PROPERTY that was
 * wanted rather than the particular index.
 *
 * The index this table genuinely lacks is the mirror image: `chapter_id` is a
 * foreign key and is NOT the leading column of anything, so without one every
 * `delete from chapters` sequentially scans the whole of `chapter_mastery` to
 * apply the cascade. That one is created below.
 */
export const chapterMastery = pgTable(
  'chapter_mastery',
  {
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => students.userId, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    masteryScore: numeric('mastery_score', { precision: 4, scale: 3 }).notNull().default('0'),
    attempts: integer('attempts').notNull().default(0),
    lastPractisedAt: timestamp('last_practised_at', { withTimezone: true }),
    /**
     * Denormalised from `students` — see `schema/tenants.ts`.
     *
     * Denormalised rather than joined because the Phase 4 principal dashboard
     * aggregates mastery ACROSS a school ("improvement by cohort", "four-week
     * retention"). A join to `students` on every one of those reads is a join
     * the tenant column exists to remove.
     */
    tenantId: uuid('tenant_id')
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'chapter_mastery_pkey',
      columns: [table.studentUserId, table.chapterId],
    }),
    check(
      'chapter_mastery_score_check',
      sql`${table.masteryScore} >= 0 and ${table.masteryScore} <= 1`,
    ),
    check('chapter_mastery_attempts_check', sql`${table.attempts} >= 0`),
    /** The unindexed-FK cascade scan. See the note above. */
    index('chapter_mastery_chapter_idx').on(table.chapterId),
    index('chapter_mastery_tenant_idx').on(table.tenantId),
  ],
);

export type StudentRow = typeof students.$inferSelect;
export type NewStudentRow = typeof students.$inferInsert;
export type StudentSubjectRow = typeof studentSubjects.$inferSelect;
export type NewStudentSubjectRow = typeof studentSubjects.$inferInsert;
export type ChapterMasteryRow = typeof chapterMastery.$inferSelect;
export type NewChapterMasteryRow = typeof chapterMastery.$inferInsert;
