import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  DIFFICULTIES,
  OPTIONS_PER_QUESTION,
} from '../../../shared/constants/curriculum';
import { RESPONSE_CONFIDENCES } from '../../../shared/constants/practice';
import { chapters, questions } from './content';
import { students } from './learner';
import { DEFAULT_TENANT_ID, tenants } from './tenants';

/**
 * The confidence a student reported before answering. Nullable — it is only
 * present when the question actually asked, and inventing a value for the rest
 * would put a number in a teacher's screen that nobody ever said.
 *
 * The VOCABULARY now lives in `shared/constants/practice.ts`, where the practice
 * module can also reach it — modules cannot import `platform/db` at all (§7.4),
 * so a set declared only here would have to be re-declared there, and a
 * re-declared closed set drifts from the CHECK enforcing it.
 */
const confidenceList = sql.raw(RESPONSE_CONFIDENCES.map((value) => `'${value}'`).join(', '));

/**
 * practice schema — plan §8.6, build step 11.
 *
 * Four tables: `practice_sessions`, `practice_responses`, `xp_ledger` and
 * `practice_retention`. Assigned the `core` pool (04-RESILIENCE-PLAN.md §3.1).
 *
 * ===========================================================================
 * `practice_responses` WAS `question_responses` — D-057, migration 0002.
 *
 * The response log landed three build steps ahead of this module because it is
 * the third one-way door in PROGRESS.md §8 (history cannot be backfilled).
 * D-057 then decided that it and the plan's separate `practice_responses` are
 * ONE table rather than two nearly-identical ones — two tables would mean
 * `practice` writing each row twice, and the two copies eventually disagreeing.
 *
 * Migration 0002 RENAMES rather than drops-and-recreates. The table is empty
 * today, so a drop would have been harmless today and catastrophic on the first
 * deployment where it is not — and a migration whose safety depends on a table
 * still being empty is a migration nobody can re-read and trust.
 * ===========================================================================
 */

const difficultyList = sql.raw(DIFFICULTIES.map((value) => `'${value}'`).join(', '));

/**
 * ONE PRACTICE ATTEMPT, from the moment the questions are drawn.
 *
 * The row is created at `startSession` and completed at `submitSession`. Every
 * completion column — `submitted_at`, `score_percent`, `xp_earned`, `is_valid` —
 * is nullable while the session is in flight and constrained to be present
 * together once it is not: a session cannot be half-submitted, and a CHECK is
 * what makes that true rather than a convention.
 *
 * THE TWO JSONB COLUMNS ARE NOT A SHORTCUT AROUND NORMALISATION.
 *
 * `option_order` is the shuffle map (D-058). Options are shuffled per session
 * for presentation ONLY, and every index this system ever persists is the
 * ORIGINAL one, because misconception codes are keyed by original option index
 * (D-048). The map has to survive between the request that served the questions
 * and the request that receives the answer, and it belongs to the session
 * rather than to any one response — so it lives here, on the session, and
 * `practice_responses.selected_index` is written only after translating through
 * it.
 *
 * `answers` is the IN-FLIGHT accumulator that `submitAnswer` appends to. It is
 * deliberately not `practice_responses`: §8.6 requires the responses, the
 * session score, the XP ledger entry and mastery to land in ONE transaction, so
 * nothing may be written to `practice_responses` before that transaction opens.
 * Answers accumulate here, and submission materialises them.
 */
export const practiceSessions = pgTable(
  'practice_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => students.userId, { onDelete: 'cascade' }),
    /**
     * RESTRICT, like `practice_responses.question_id` and for the same reason:
     * deleting a chapter would destroy the evidence of every session run
     * against it. Withdrawing a chapter is `is_active = false`.
     */
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'restrict' }),
    /**
     * The questions drawn, IN THE ORDER THEY WERE SERVED.
     *
     * Frozen at `startSession`. A session answers exactly these questions and
     * no others — which is what makes "response count equals question count"
     * (§8.6 anti-cheat rule 3) a statement about server-held data rather than
     * about whatever the client chose to send.
     */
    questionIds: uuid('question_ids').array().notNull(),
    /**
     * How many questions this session is MEANT to have.
     *
     * `question_ids` grows as questions are served, so its length is progress,
     * not length. Scoring and anti-cheat rule 3 read this.
     */
    targetQuestionCount: integer('target_question_count').notNull().default(6),
    /** `{ [questionId]: number[] }` — presentation index -> ORIGINAL index. */
    optionOrder: jsonb('option_order').notNull().default({}),
    /** `{ [questionId]: { selectedIndex, ... } }`, canonical indices only. */
    answers: jsonb('answers').notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    scorePercent: integer('score_percent'),
    xpEarned: integer('xp_earned'),
    /** FALSE when an anti-cheat rule failed. The session still scores — zero. */
    isValid: boolean('is_valid'),
    invalidReason: text('invalid_reason'),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('practice_sessions_question_ids_check', sql`cardinality(${table.questionIds}) > 0`),
    check(
      'practice_sessions_target_question_count_check',
      sql`${table.targetQuestionCount} >= 1 and ${table.targetQuestionCount} <= 20`,
    ),
    check(
      'practice_sessions_score_percent_check',
      sql`${table.scorePercent} is null
          or (${table.scorePercent} >= 0 and ${table.scorePercent} <= 100)`,
    ),
    check('practice_sessions_xp_check', sql`${table.xpEarned} is null or ${table.xpEarned} >= 0`),
    /**
     * A SESSION IS EITHER IN FLIGHT OR COMPLETE. There is no third state.
     *
     * Without this, a crash between two UPDATEs leaves a row with a
     * `submitted_at` and no score — which every history screen renders as a
     * session worth zero, indistinguishable from a genuinely failed attempt.
     */
    check(
      'practice_sessions_submitted_complete_check',
      sql`${table.submittedAt} is null
          or (${table.scorePercent} is not null
              and ${table.xpEarned} is not null
              and ${table.isValid} is not null)`,
    ),
    /** An invalid session names its reason; a valid one carries none. */
    check(
      'practice_sessions_invalid_reason_check',
      sql`(${table.isValid} is not false or ${table.invalidReason} is not null)
          and (${table.isValid} is not true or ${table.invalidReason} is null)`,
    ),
    index('practice_sessions_tenant_idx').on(table.tenantId),
    index('practice_sessions_student_idx').on(table.studentUserId, table.startedAt.desc()),
    index('practice_sessions_chapter_idx').on(table.chapterId),
  ],
);

export type PracticeSessionRow = typeof practiceSessions.$inferSelect;
export type NewPracticeSessionRow = typeof practiceSessions.$inferInsert;

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
export const practiceResponses = pgTable(
  'practice_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * THE SESSION THIS ANSWER BELONGS TO — D-057.
     *
     * The column the merge exists for. It is what makes submission idempotent:
     * `(session_id, question_id)` is UNIQUE below, so a second submission of the
     * same session cannot write a second set of responses even if every guard
     * above it were removed.
     *
     * CASCADE, unlike the question FK. A session and its responses are one fact.
     */
    sessionId: uuid('session_id')
      .notNull()
      .references(() => practiceSessions.id, { onDelete: 'cascade' }),
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

    /**
     * The pace target for this question's difficulty, AS IT WAS when the
     * question was served. Frozen for the same reason `authored_difficulty` is.
     */
    timeTargetMs: integer('time_target_ms').notNull(),

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
      'practice_responses_selected_index_check',
      sql`${table.selectedIndex} >= 0 and ${table.selectedIndex} < ${sql.raw(String(OPTIONS_PER_QUESTION))}`,
    ),
    check('practice_responses_time_spent_check', sql`${table.timeSpentMs} >= 0`),
    check('practice_responses_time_target_ms_check', sql`${table.timeTargetMs} > 0`),
    check(
      'practice_responses_authored_difficulty_check',
      sql`${table.authoredDifficulty} in (${difficultyList})`,
    ),
    check(
      'practice_responses_first_selected_index_check',
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
      'practice_responses_answer_changed_check',
      sql`${table.firstSelectedIndex} is null
          or ${table.answerChanged} is null
          or ${table.answerChanged} = (${table.firstSelectedIndex} <> ${table.selectedIndex})`,
    ),
    check('practice_responses_hint_level_check', sql`${table.hintLevelUsed} >= 0`),
    check(
      'practice_responses_confidence_check',
      sql`${table.confidence} is null or ${table.confidence} in (${confidenceList})`,
    ),
    index('practice_responses_tenant_idx').on(table.tenantId),
    /** Calibration: every response to one question, oldest first. */
    index('practice_responses_question_idx').on(table.questionId, table.createdAt),
    /** A student's own history, newest first. */
    index('practice_responses_student_idx').on(table.studentUserId, table.createdAt.desc()),
    /** Every response of one session, for the history screen. */
    index('practice_responses_session_idx').on(table.sessionId),
    /**
     * SUBMISSION IDEMPOTENCY, AT THE LOWEST LEVEL THAT CAN ENFORCE IT.
     *
     * The service refuses a second submission of an already-submitted session,
     * and this constraint refuses it again underneath. Two guards, because the
     * cost of a double write is a student's XP permanently disagreeing with
     * their history — and the service-level guard is a read-then-write, which
     * two concurrent submissions of the same session can both pass.
     */
    unique('practice_responses_session_question_key').on(table.sessionId, table.questionId),
  ],
);

export type PracticeResponseRow = typeof practiceResponses.$inferSelect;
export type NewPracticeResponseRow = typeof practiceResponses.$inferInsert;

/**
 * THE XP LEDGER — plan §4: append-only, and a total is a SUM over it.
 *
 * Never a mutable counter column on `students`. Counters drift, and a drifted
 * XP total cannot be reconciled against anything because the history that would
 * settle it was never written down. There is a service test asserting that a
 * student's reported total equals the sum of these rows, which is only a
 * meaningful test because there is no second place the total could come from.
 *
 * `(source, source_id)` is UNIQUE. That is the whole idempotency mechanism: one
 * practice session can award XP exactly once, enforced by the database rather
 * than by the submission path remembering to check.
 */
export const xpLedger = pgTable(
  'xp_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => students.userId, { onDelete: 'cascade' }),
    /** What earned it — 'practice_session' is the only source today. */
    source: text('source').notNull(),
    /** The id of that thing. A practice session id, today. */
    sourceId: uuid('source_id').notNull(),
    amount: integer('amount').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * NON-NEGATIVE, and deliberately not "positive".
     *
     * Zero is a real and important entry: an invalid attempt scores zero and
     * still earns a ledger row, because "this session awarded nothing" is a fact
     * worth being able to read back. A missing row would be indistinguishable
     * from a submission that never happened.
     */
    check('xp_ledger_amount_check', sql`${table.amount} >= 0`),
    unique('xp_ledger_source_key').on(table.source, table.sourceId),
    index('xp_ledger_student_idx').on(table.studentUserId, table.createdAt.desc()),
    index('xp_ledger_tenant_idx').on(table.tenantId),
  ],
);

export type XpLedgerRow = typeof xpLedger.$inferSelect;
export type NewXpLedgerRow = typeof xpLedger.$inferInsert;

/**
 * THE SPACED-RETENTION SCHEDULE — 05-ROADMAP.md §6, "full — SM-2 or FSRS".
 *
 * One row per student per chapter: when this chapter is next due, and the SM-2
 * state needed to compute the interval after that. The arithmetic is a pure
 * domain function on the injected clock; this table is only where its output
 * rests between sessions.
 *
 * CHAPTER-level rather than question-level, deliberately. The product schedules
 * a practice session, not a flashcard, and a per-question schedule would need
 * per-question review to be a thing the interface offers — which it is not.
 */
export const practiceRetention = pgTable(
  'practice_retention',
  {
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => students.userId, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'restrict' }),
    /** When this chapter should next be practised. The mission reads it. */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    intervalDays: integer('interval_days').notNull(),
    /** SM-2's ease factor. Floored at 1.3 by the algorithm and by this CHECK. */
    easeFactor: numeric('ease_factor', { precision: 4, scale: 2 }).notNull(),
    repetitions: integer('repetitions').notNull(),
    lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true }).notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'practice_retention_pkey',
      columns: [table.studentUserId, table.chapterId],
    }),
    check('practice_retention_interval_check', sql`${table.intervalDays} >= 0`),
    check('practice_retention_ease_check', sql`${table.easeFactor} >= 1.3`),
    check('practice_retention_repetitions_check', sql`${table.repetitions} >= 0`),
    /** The mission's due-review query: one student, earliest due first. */
    index('practice_retention_due_idx').on(table.studentUserId, table.dueAt),
    index('practice_retention_tenant_idx').on(table.tenantId),
  ],
);

export type PracticeRetentionRow = typeof practiceRetention.$inferSelect;
export type NewPracticeRetentionRow = typeof practiceRetention.$inferInsert;
