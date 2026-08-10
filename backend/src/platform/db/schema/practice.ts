import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  DIFFICULTIES,
  OPTIONS_PER_QUESTION,
} from '../../../shared/constants/curriculum';
import { questions } from './content';
import { students } from './learner';
import { DEFAULT_TENANT_ID, tenants } from './tenants';

/**
 * The confidence a student reported before answering. Nullable — it is only
 * present when the question actually asked, and inventing a value for the rest
 * would put a number in a teacher's screen that nobody ever said.
 */
export const RESPONSE_CONFIDENCE = ['unsure', 'unsure_ish', 'confident'] as const;
export type ResponseConfidence = (typeof RESPONSE_CONFIDENCE)[number];

const confidenceList = sql.raw(RESPONSE_CONFIDENCE.map((value) => `'${value}'`).join(', '));

/**
 * practice schema — the FIRST table of it, ahead of the module.
 *
 * `practice` (plan §8.6) is build step 11 and owns quiz sessions, scoring and
 * XP. None of that exists yet. This one table does, because it is the third
 * one-way door in PROGRESS.md §8 and the only one whose cost is measured in
 * months rather than hours.
 *
 * Assigned the `core` pool (04-RESILIENCE-PLAN.md §3.1).
 */

const difficultyList = sql.raw(DIFFICULTIES.map((value) => `'${value}'`).join(', '));

/**
 * ONE-WAY DOOR 3 — every answer a student ever gives.
 *
 * WHY IT EXISTS AT ALL, since nothing reads it yet: authored difficulty is a
 * guess. Real difficulty is the fraction of students who get a question right,
 * and it can only be computed from responses that were recorded AT THE TIME.
 * There is no way to reconstruct them later. Start logging in month one and
 * calibration is available in month six; start in month six and calibration is
 * available in month twelve. The table is nearly free and the data is not
 * recoverable, so it lands now.
 *
 * APPEND-ONLY. Deliberately a convention rather than a trigger: the only
 * writer is the practice module's single insert path, and a trigger blocking
 * UPDATE and DELETE would also have to exempt the FK cascade below, which is
 * more machinery than the protection is worth at one writer. Revisit if a
 * second writer appears.
 *
 * THE TWO FOREIGN KEY BEHAVIOURS ARE DIFFERENT ON PURPOSE:
 *
 *  - student → CASCADE. A student who deletes their account takes their answers
 *    with them. Calibration is aggregate and the privacy claim is not
 *    negotiable; if aggregates need to survive, they get their own rolled-up
 *    table, not a retained per-student row.
 *  - question → RESTRICT. A question cannot be deleted while responses to it
 *    exist. Deleting one destroys the calibration evidence for it, and the
 *    correct way to withdraw a question is `is_active = false`. The constraint
 *    turns "I'll just tidy up the bank" into an error instead of a loss.
 */
export const questionResponses = pgTable(
  'question_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => students.userId, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'restrict' }),
    selectedIndex: integer('selected_index').notNull(),
    isCorrect: boolean('is_correct').notNull(),
    timeSpentMs: integer('time_spent_ms').notNull(),
    /**
     * DENORMALISED ON PURPOSE — the difficulty the question carried WHEN IT WAS
     * SERVED, not whatever it carries now.
     *
     * Joining to `questions.difficulty` instead would look tidier and would
     * destroy the measurement: correcting a question from 'easy' to 'hard'
     * would retroactively rewrite every past response to claim the student had
     * faced a hard question. Calibration compares authored against observed, so
     * the authored value has to be frozen at the moment of the observation.
     */
    authoredDifficulty: text('authored_difficulty').notNull(),

    // =======================================================================
    // EVIDENCE CAPTURE — 05-ROADMAP.md §8, row 1: "0.5 d now / UNRECOVERABLE
    // later. History cannot be backfilled."
    //
    // §3 of the roadmap states the dependency plainly: the Phase 1 teacher
    // screen and the Phase 4 principal dashboard run on these five columns,
    // and "if the MVP does not record these, the teacher screen launches empty
    // and stays empty for months."
    //
    // THE ASYMMETRY IS THE WHOLE ARGUMENT. Every other hook in this codebase
    // costs a migration if it is skipped. These cost a cohort: a student who
    // practised in September and changed four answers with two hints leaves no
    // trace of either unless the columns existed in September. There is no
    // query, no export and no vendor that recovers it afterwards.
    //
    // NOTHING WRITES THESE YET. `practice` is build step 11. They are nullable
    // (except `hint_level_used`, where 0 is a true statement rather than an
    // absent one), and every one carries a COMMENT ON COLUMN in migration 0006
    // because none of it is inferable from the column name six months from now.
    // =======================================================================

    /**
     * The option index the student picked FIRST, before any change of mind.
     *
     * Not derivable from `selected_index`, which is the final answer. A student
     * who selects the misconception distractor and then corrects themselves has
     * demonstrated the misconception AND the recovery, and only the first half
     * is diagnostic. Without this column that student is indistinguishable from
     * one who was right immediately.
     *
     * CANONICAL, NOT SHUFFLED — the same rule as `selected_index` (D-058).
     * Practice shuffles options for presentation and translates back before
     * storing, because misconception codes are keyed by ORIGINAL option index
     * (D-048). A shuffled index here would silently mislabel every misconception.
     */
    firstSelectedIndex: integer('first_selected_index'),

    /**
     * Whether the answer changed at all.
     *
     * Redundant with `first_selected_index <> selected_index` WHEN the first
     * index is known — and a CHECK below enforces that they agree, so the two
     * can never tell different stories. It exists separately because "did this
     * student waver" is answerable even when the interface recorded only the
     * fact and not the value, and because it is the column a teacher screen
     * actually filters on.
     */
    answerChanged: boolean('answer_changed'),

    /**
     * How many hint levels the student consumed. 0 MEANS NONE, and is a real
     * observation rather than a missing one — hence NOT NULL with a default of
     * 0, unlike its neighbours.
     *
     * The question bank carries three hint levels. A correct answer at hint
     * level 3 and a correct answer at hint level 0 are the same row without
     * this column, and they are not the same evidence.
     */
    hintLevelUsed: integer('hint_level_used').notNull().default(0),

    /**
     * What the student said about their own confidence BEFORE answering.
     *
     * The single most valuable signal on this table and the one most obviously
     * impossible to reconstruct. Confident-and-wrong is a misconception;
     * unsure-and-right is a guess. Both look identical in `is_correct`, and
     * they call for opposite interventions.
     *
     * Nullable: only present where the interface asked.
     */
    confidence: text('confidence'),

    /**
     * Which explanation style the student chose to read afterwards — 'text',
     * 'worked_example', 'analogy', 'video', and whatever is added later.
     *
     * Deliberately unconstrained text rather than a CHECK: the set of formats
     * is a product experiment that will change several times, and a constraint
     * would make each change a migration. It is an ANALYTICS column, not a
     * decision column — nothing branches on it — so an unexpected value costs
     * a line in a report rather than a wrong answer.
     */
    explanationFormatUsed: text('explanation_format_used'),

    /** Denormalised from `students` — see `schema/tenants.ts`. */
    tenantId: uuid('tenant_id')
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'restrict' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'question_responses_selected_index_check',
      sql`${table.selectedIndex} >= 0 and ${table.selectedIndex} < ${sql.raw(String(OPTIONS_PER_QUESTION))}`,
    ),
    check('question_responses_time_spent_check', sql`${table.timeSpentMs} >= 0`),
    check(
      'question_responses_authored_difficulty_check',
      sql`${table.authoredDifficulty} in (${difficultyList})`,
    ),
    check(
      'question_responses_first_selected_index_check',
      sql`${table.firstSelectedIndex} is null
          or (${table.firstSelectedIndex} >= 0
              and ${table.firstSelectedIndex} < ${sql.raw(String(OPTIONS_PER_QUESTION))})`,
    ),
    /**
     * The two change columns must agree.
     *
     * Storing a derivable fact alongside the thing it derives from is how two
     * columns start disagreeing — and the disagreement would be invisible,
     * because both are individually plausible. Where both are present, the
     * database settles it.
     */
    check(
      'question_responses_answer_changed_check',
      sql`${table.firstSelectedIndex} is null
          or ${table.answerChanged} is null
          or ${table.answerChanged} = (${table.firstSelectedIndex} <> ${table.selectedIndex})`,
    ),
    check('question_responses_hint_level_check', sql`${table.hintLevelUsed} >= 0`),
    check(
      'question_responses_confidence_check',
      sql`${table.confidence} is null or ${table.confidence} in (${confidenceList})`,
    ),
    index('question_responses_tenant_idx').on(table.tenantId),
    /** Calibration: every response to one question, oldest first. */
    index('question_responses_question_idx').on(table.questionId, table.createdAt),
    /** A student's own history, newest first. */
    index('question_responses_student_idx').on(table.studentUserId, table.createdAt.desc()),
  ],
);

export type QuestionResponseRow = typeof questionResponses.$inferSelect;
export type NewQuestionResponseRow = typeof questionResponses.$inferInsert;
