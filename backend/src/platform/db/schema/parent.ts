import { sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { chapters } from './content';
import { users } from './identity';
import { students } from './learner';
import { DEFAULT_TENANT_ID, tenants } from './tenants';

/**
 * THE PARENT MODULE'S ONE TABLE — plan §4, "parent, billing, notify".
 *
 * ===========================================================================
 * THE UNIQUE CONSTRAINT IS THE WHOLE IDEMPOTENCE MECHANISM.
 *
 * §8.7: "digest generation is idempotent for a given week". `notify`'s job key
 * makes a duplicated ENQUEUE impossible and its `hasDigestFor` check makes a
 * duplicated RUN impossible, but neither protects the PARENT-TRIGGERED path —
 * a parent tapping "refresh" twice, or two of them on one account.
 *
 * `unique (parent_user_id, student_user_id, week_start)` does, in the database,
 * for every caller at once. The service writes with ON CONFLICT DO NOTHING and
 * reads the row back, so a second generation returns the FIRST digest rather
 * than a second one — which is what "running twice must not send twice" means
 * once the text can vary between two builds.
 *
 * PER (PARENT, CHILD, WEEK), NOT PER (PARENT, WEEK). A parent with two children
 * gets two digests in a week and they are different facts; keying on the parent
 * alone would silently discard the second child.
 * ===========================================================================
 *
 * ===========================================================================
 * WHY `misconception_code` IS NULLABLE, AND WHY THAT IS THE HONEST SHAPE.
 *
 * `questions.distractor_misconceptions` is NULL on all 2,741 imported questions
 * (D-077), so almost every real digest this year will carry NULL here. The
 * column is not "waiting to be filled in" — a null means "nothing was observed",
 * which is a statement the product makes deliberately and out loud (see
 * `domain/digest-content.ts`). A NOT NULL column with a `'none'` sentinel would
 * make the D-077 gap unqueryable.
 * ===========================================================================
 *
 * TWO ACTION COLUMNS, NOT ONE. Plan §4 lists a single `suggested_action`;
 * P7 requires both languages for anything a user reads, and the plan's own
 * `summary_en`/`summary_hi` pair sets the precedent. One column would have
 * meant the concrete action — the most useful line in the digest — was English
 * only, which is the exact way P7 decays.
 */
export const weeklyDigests = pgTable(
  'weekly_digests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The recipient. `users` rather than a parent-specific table, because a
     * parent is a `users` row with `role = 'parent'` (§4, identity).
     *
     * CASCADE: a deleted account takes its digests with it. They are derived
     * data — every one of them can be rebuilt from `practice_sessions`.
     */
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => students.userId, { onDelete: 'cascade' }),
    /** Midnight UTC on the Monday. A DATE, because a week has no time of day. */
    weekStart: date('week_start').notNull(),
    /** The five lines, joined by a newline. BOTH are NOT NULL — P7. */
    summaryEn: text('summary_en').notNull(),
    summaryHi: text('summary_hi').notNull(),
    /** The observed misconception's code, or NULL. See the header. */
    misconceptionCode: text('misconception_code'),
    suggestedActionEn: text('suggested_action_en').notNull(),
    suggestedActionHi: text('suggested_action_hi').notNull(),
    /**
     * Counts, kept so a digest can be re-read without re-running the week's
     * queries — and so "the digest said 3 days" can be checked against the
     * sessions afterwards. No score and no percentage is stored here, for the
     * same reason none is printed.
     */
    sessionsCount: integer('sessions_count').notNull().default(0),
    questionsAnswered: integer('questions_answered').notNull().default(0),
    daysPractised: integer('days_practised').notNull().default(0),
    /**
     * The chapter the digest's action points at, when it points at one.
     *
     * RESTRICT, matching `practice_sessions`: withdrawing a chapter is
     * `is_active = false`, and deleting one would destroy the record of what a
     * parent was told.
     */
    chapterId: uuid('chapter_id').references(() => chapters.id, { onDelete: 'restrict' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** §8.7 — one digest per parent per child per week. */
    unique('weekly_digests_week_key').on(table.parentUserId, table.studentUserId, table.weekStart),
    /**
     * BOTH LANGUAGES, NON-EMPTY, IN THE DATABASE — the same belt-and-braces
     * `notifications` uses. A type does not survive a raw INSERT, and an empty
     * `summary_hi` is exactly what a skipped translation looks like.
     */
    check('weekly_digests_summary_en_check', sql`length(btrim(${table.summaryEn})) > 0`),
    check('weekly_digests_summary_hi_check', sql`length(btrim(${table.summaryHi})) > 0`),
    check('weekly_digests_action_en_check', sql`length(btrim(${table.suggestedActionEn})) > 0`),
    check('weekly_digests_action_hi_check', sql`length(btrim(${table.suggestedActionHi})) > 0`),
    check('weekly_digests_sessions_check', sql`${table.sessionsCount} >= 0`),
    check('weekly_digests_questions_check', sql`${table.questionsAnswered} >= 0`),
    check(
      'weekly_digests_days_check',
      sql`${table.daysPractised} >= 0 and ${table.daysPractised} <= 7`,
    ),
    /** "This parent's digests, newest first" — the parent portal's read. */
    index('weekly_digests_parent_idx').on(table.parentUserId, table.weekStart.desc()),
    /** "Everything ever said about this child" — the support read. */
    index('weekly_digests_student_idx').on(table.studentUserId, table.weekStart.desc()),
    index('weekly_digests_tenant_idx').on(table.tenantId),
    index('weekly_digests_chapter_idx').on(table.chapterId),
  ],
);

export type WeeklyDigestRow = typeof weeklyDigests.$inferSelect;
export type NewWeeklyDigestRow = typeof weeklyDigests.$inferInsert;
