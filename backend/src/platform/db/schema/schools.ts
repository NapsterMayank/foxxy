import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { GRADES } from '../../../shared/constants/curriculum';
import { users } from './identity';
import { tenants } from './tenants';

/**
 * schools · classes · class_enrolments — STUBS. Schema only.
 *
 * NO MODULE, NO SERVICE, NO ROUTES, and none should be added until Phase 1.
 * These three tables exist so that the teacher and principal phases have
 * something to attach to, and for no other reason today.
 *
 * 05-ROADMAP.md §8 prices the role enum, this stub and `audit_log` together at
 * "3 d now against ~8 d plus a live-data migration later". The eight days are
 * not the tables — tables are cheap. They are repointing `students`, every
 * teacher query and every authorisation check at a school that did not exist
 * when they were written, on a database with real children's data in it.
 *
 * A stub carries one real risk, which is that it looks finished. It is not:
 * there is no way to create a school, no way to enrol a student, and nothing
 * reads any of it. What it buys is that the FOREIGN KEY DIRECTION and the
 * GRADE TYPE are settled now, while settling them is free.
 */

export const schools = pgTable(
  'schools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * NOT NULL here, unlike the retrofitted `tenant_id` columns on the existing
     * student tables. Nothing has ever inserted a school, so there is no row to
     * be compatible with and no reason to accept a weaker constraint.
     */
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    board: text('board').notNull().default('CBSE'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('schools_tenant_idx').on(table.tenantId),
    check('schools_name_check', sql`length(btrim(${table.name})) > 0`),
  ],
);

const gradeList = sql.raw(GRADES.map((grade) => `'${grade}'`).join(', '));

/**
 * GRADE IS TEXT here too, with the same CHECK as `students.grade`.
 *
 * It would have been easy to leave the constraint off a stub "until it is
 * used". The failure plan §3 describes is exactly why not: an integer grade
 * does not error, it silently matches nothing. A stub with a looser rule than
 * the table it will eventually join against is a stub that imports bad data on
 * its first day of real use, and the symptom is an empty class list rather than
 * an error.
 *
 * `academic_year` is a text label ('2026-27') rather than a date range: it is
 * what a school calls the year, and the actual boundaries differ by board and
 * by state.
 */
export const classes = pgTable(
  'classes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    grade: text('grade').notNull(),
    section: text('section').notNull(),
    academicYear: text('academic_year').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One 8-A per school per year. Without this a re-import creates a second
    // 8-A and every enrolment afterwards is split across two classes.
    uniqueIndex('classes_school_grade_section_year_unique').on(
      table.schoolId,
      table.grade,
      table.section,
      table.academicYear,
    ),
    check('classes_grade_check', sql`${table.grade} in (${gradeList})`),
    check('classes_section_check', sql`length(btrim(${table.section})) > 0`),
    check('classes_academic_year_check', sql`${table.academicYear} ~ '^[0-9]{4}-[0-9]{2}$'`),
  ],
);

/**
 * Composite primary key on (class_id, student_user_id): a student is either in
 * a class or is not, so there is nothing to distinguish two rows and no
 * surrogate id worth the write cost. Same reasoning as `student_subjects`.
 *
 * It points at `users`, NOT at `students`. A student enrolled by a school
 * before they have completed onboarding has no `students` row yet, and a school
 * roster import is exactly the flow that creates accounts ahead of profiles.
 * Pointing at `students` would make the roster unimportable until every child
 * had logged in, which is backwards.
 *
 * BRITISH SPELLING, matching `last_practised_at` and `analyse` elsewhere. The
 * previous product used `class_enrollments`; harvesting its data is a rename in
 * an import script, which is cheaper than a codebase with two spellings of one
 * word.
 */
export const classEnrolments = pgTable(
  'class_enrolments',
  {
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'class_enrolments_pkey',
      columns: [table.classId, table.studentUserId],
    }),
    /** The unindexed-FK cascade scan, same as `chapter_mastery.chapter_id`. */
    index('class_enrolments_student_idx').on(table.studentUserId),
  ],
);

export type SchoolRow = typeof schools.$inferSelect;
export type NewSchoolRow = typeof schools.$inferInsert;
export type ClassRow = typeof classes.$inferSelect;
export type NewClassRow = typeof classes.$inferInsert;
export type ClassEnrolmentRow = typeof classEnrolments.$inferSelect;
export type NewClassEnrolmentRow = typeof classEnrolments.$inferInsert;
