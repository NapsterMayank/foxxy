import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { GRADES, LANGUAGES, SUBJECTS } from '../../../shared/constants/curriculum';
import { FOXY_ACTIONS, FOXY_MESSAGE_ROLES, FOXY_MODES } from '../../../shared/constants/foxy';
import { chapters } from './content';
import { students } from './learner';
import { DEFAULT_TENANT_ID, tenants } from './tenants';

/**
 * foxy schema — plan §4 ("foxy") and §8.5, build step 10.
 *
 * Three tables: `chat_sessions`, `chat_messages` and `retrieval_traces`.
 * Assigned the `ai` pool (04-RESILIENCE-PLAN.md §3.1) — the same pool as
 * `retrieval`, because a Foxy turn IS a retrieval plus a model call and a slow
 * one must not be able to hold a connection that a login or a chapter listing
 * needs.
 *
 * ===========================================================================
 * `parent` HAS BEEN QUERYING THESE TABLES SINCE BUILD STEP 12 — through a
 * catalogue probe.
 *
 * `parent.repository.readTranscript` runs `to_regclass('public.chat_sessions')`
 * and returns `present: false` when the tables are absent, which the service
 * turns into `source: 'not_yet_available'`. It then selects
 * `id, mode, started_at, last_message_at` from `chat_sessions` and
 * `id, session_id, role, content, created_at` from `chat_messages`, and maps
 * `role = 'user'` to `'student'` and anything else to `'foxy'`.
 *
 * THOSE COLUMN NAMES AND THAT ROLE VOCABULARY ARE A CONTRACT, not a suggestion.
 * They were written against plan §4 before this file existed, and the moment
 * this migration lands the probe starts returning true — so a rename here is a
 * silent break in the parent transcript, which is the one surface where the
 * failure would be invisible (an empty transcript reads as "a quiet child").
 * There is an integration test that reads a real transcript through `parent`
 * for exactly this reason.
 * ===========================================================================
 */

const modeList = sql.raw(FOXY_MODES.map((value) => `'${value}'`).join(', '));
const roleList = sql.raw(FOXY_MESSAGE_ROLES.map((value) => `'${value}'`).join(', '));
const actionList = sql.raw(FOXY_ACTIONS.map((value) => `'${value}'`).join(', '));
const gradeList = sql.raw(GRADES.map((value) => `'${value}'`).join(', '));
const subjectList = sql.raw(SUBJECTS.map((value) => `'${value}'`).join(', '));
const languageList = sql.raw(LANGUAGES.map((value) => `'${value}'`).join(', '));

/**
 * ONE CONVERSATION, in one mode, about one subject.
 *
 * ===========================================================================
 * THE SUBJECT IS STORED AND THE GRADE IS NOT. That asymmetry is deliberate.
 *
 * §8.5's flow says "load the student's grade and subjects" on every message, so
 * the GRADE is read fresh from `learner` per turn — a student who moves from
 * class 8 to class 9 must not keep receiving class 8 passages because a session
 * they opened in March froze it.
 *
 * The SUBJECT is a property of the conversation rather than of the student: a
 * session is about science or about mathematics, the student chose which when
 * they opened it, and re-deriving it per turn would mean guessing. It is
 * validated against the student's enrolled subjects at `startSession` and never
 * again — which is right, because dropping a subject should not retroactively
 * make an existing conversation unanswerable.
 * ===========================================================================
 */
export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * CASCADE. A deleted student takes their conversations with them — this is
     * the most personal data in the product and there is no argument for
     * keeping an orphan copy of it.
     */
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => students.userId, { onDelete: 'cascade' }),
    /** D-073: NOT NULL, and the service stamps the tenant the guard passed on. */
    tenantId: uuid('tenant_id')
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    /** `doubt` | `explain` | `practice`. Fixed at creation. */
    mode: text('mode').notNull(),
    /** Canonical, from `shared/constants/curriculum`. See the header. */
    subject: text('subject').notNull(),
    /**
     * The chapter this conversation is anchored to, or NULL for "anywhere in
     * the subject".
     *
     * RESTRICT rather than cascade: deleting a chapter must not delete a child's
     * conversations. Withdrawing a chapter is `is_active = false`, and a
     * conversation about a withdrawn chapter is still a conversation that
     * happened.
     */
    chapterId: uuid('chapter_id').references(() => chapters.id, { onDelete: 'restrict' }),
    /**
     * The default response language for this session, from the student's
     * profile. The `hindi` ACTION overrides it for a single turn without
     * changing it — see `shared/constants/foxy.ts`.
     */
    language: text('language').notNull().default('en'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * NULL until the first message. Distinguishable from `started_at` on
     * purpose: a session opened and abandoned is a real thing to be able to
     * count, and copying `started_at` here at creation would erase it.
     */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    /**
     * WHICH OPEN OF THE APP THIS CONVERSATION BELONGS TO — D-401.
     *
     * A correlation id and nothing else. The client mints one uuid per app
     * launch and sends it as `X-Visit-Id`; every chat and practice session
     * started under that launch carries it. It is what turns "this student did
     * six things today" into "this student did six things across two visits",
     * which is the question neither table could answer before.
     *
     * NOT the auth session id, and the distinction matters: `sessions` is one
     * row per LOGIN, and a cookie survives weeks of opens, so the auth session
     * is constant across exactly the visits this column exists to separate.
     *
     * NULLABLE, and it stays nullable. It is absent on every row written before
     * this migration, on any non-browser caller, and whenever a proxy strips the
     * header. A NOT NULL would make a missing correlation id fail a learning
     * action — trading a working product for a tidy column.
     *
     * NEVER AUTHORISES ANYTHING. It is client-supplied, so it is read for
     * correlation only: no lookup is scoped by it, no access check consults it,
     * and `readVisitId` discards anything that is not a uuid rather than
     * storing what the caller sent.
     */
    visitId: uuid('visit_id'),
  },
  (table) => [
    check('chat_sessions_mode_check', sql`${table.mode} in (${modeList})`),
    check('chat_sessions_subject_check', sql`${table.subject} in (${subjectList})`),
    check('chat_sessions_language_check', sql`${table.language} in (${languageList})`),
    // Newest first is the only order the transcript and the session list ever
    // want, and `parent.readTranscript` orders by exactly this.
    index('chat_sessions_student_idx').on(table.studentUserId, table.startedAt.desc()),
    index('chat_sessions_tenant_idx').on(table.tenantId),
    index('chat_sessions_chapter_idx').on(table.chapterId),
    // PARTIAL. Most rows written before D-401 have no visit, and a full index
    // over a column that is mostly NULL pays for entries no query will read —
    // every lookup here is `visit_id = $1`, which never matches NULL.
    index('chat_sessions_visit_idx')
      .on(table.visitId)
      .where(sql`visit_id is not null`),
  ],
);

/**
 * ONE TURN — a student's message, or Foxy's reply.
 *
 * ===========================================================================
 * THE CITATION AND ABSTENTION CHECKS ARE THE PRODUCT'S TWO HARDEST CLAIMS,
 * WRITTEN AS CONSTRAINTS.
 *
 *  1. A `user` message can never carry citations and can never be an
 *     abstention. Both are things the SYSTEM says, and a row that claimed
 *     otherwise would make the parent transcript show a child citing a textbook.
 *
 *  2. AN ABSTENTION CARRIES NO CITATIONS. Abstaining means "I could not find
 *     this in your textbook"; a citation attached to that sentence is a
 *     contradiction, and it is the exact shape a half-finished refactor would
 *     produce (retrieval abstains, the citation extractor runs anyway).
 *
 * Neither is enforceable by remembering. The service is careful; the CHECK is
 * what makes carelessness impossible.
 * ===========================================================================
 *
 * `citations` IS AN ARRAY OF OBJECTS `{ chunkId, chapterNumber, chapterTitle }`.
 * The shape is validated by the domain before the write (§7.4 keeps validation
 * out of the repository); the CHECK here only asserts it IS an array, using
 * `CASE` rather than `AND` because Postgres does not guarantee `AND` evaluation
 * order in a CHECK and `jsonb_array_length` on a non-array raises a raw type
 * error instead of naming the constraint (D-039).
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * INSERTION ORDER, AND THE REASON IT IS A COLUMN RATHER THAN A TIMESTAMP.
     *
     * A transcript is read in the order it happened, and `created_at` cannot
     * express that reliably: a student's question and Foxy's reply can share a
     * millisecond, and under a FIXED CLOCK — which every test uses, and must —
     * they share it always. Ordering by `created_at` alone then returns the two
     * turns in whatever order the plan produced, so a transcript reads
     * "assistant, user" at random and the history handed to the model is
     * incoherent.
     *
     * That is not a test artefact. It is a real ordering bug that a fixed clock
     * makes deterministic and a real clock makes intermittent — which is the
     * worse of the two.
     *
     * A `bigserial` is monotonic per insert, needs no read-then-write (so two
     * concurrent turns cannot be handed the same number), and is what every
     * ordering below actually means.
     */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    /** Denormalised from the session so a tenant predicate needs no join. */
    tenantId: uuid('tenant_id')
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    /** `user` | `assistant`. The WIRE words — `parent` maps them for display. */
    role: text('role').notNull(),
    content: text('content').notNull(),
    /**
     * Which of the six buttons produced this turn, or NULL for free text.
     *
     * Stored because it is the only way to answer "which action produces bad
     * answers" — the question any evaluation of a guided interface starts with.
     * A free-text turn is genuinely NULL rather than a `'freetext'` sentinel,
     * so the distinction stays queryable.
     */
    action: text('action'),
    citations: jsonb('citations').notNull().default([]),
    abstained: boolean('abstained').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('chat_messages_role_check', sql`${table.role} in (${roleList})`),
    check(
      'chat_messages_action_check',
      sql`${table.action} is null or ${table.action} in (${actionList})`,
    ),
    check('chat_messages_content_check', sql`length(btrim(${table.content})) > 0`),
    check(
      'chat_messages_citations_array_check',
      sql`case when jsonb_typeof(${table.citations}) = 'array' then true else false end`,
    ),
    // Claim 1 — see the header.
    check(
      'chat_messages_user_no_citations_check',
      sql`${table.role} <> 'user' or (${table.abstained} = false and jsonb_array_length(${table.citations}) = 0)`,
    ),
    // Claim 2 — see the header.
    check(
      'chat_messages_abstention_no_citations_check',
      sql`${table.abstained} = false or jsonb_array_length(${table.citations}) = 0`,
    ),
    // ON `seq`, not on `created_at` — see the note on the column. This index is
    // the one every transcript read and every history window uses.
    index('chat_messages_session_idx').on(table.sessionId, table.seq),
    index('chat_messages_tenant_idx').on(table.tenantId),
  ],
);

/**
 * THE TRACE — plan §4: "the only way you will ever debug a bad answer. Write it
 * from the first day."
 *
 * ONE ROW PER TURN, INCLUDING ABSTENTIONS. An abstention is the answer most
 * worth debugging — "why did Foxy refuse a question that is obviously in the
 * book" is the first complaint any grounded tutor receives — so a trace written
 * only on the model path would be missing for precisely the turns anybody asks
 * about.
 *
 * ===========================================================================
 * WHAT IS IN HERE, AND WHAT IS DELIBERATELY NOT.
 *
 * In: the question as asked, the normalised query, every retrieved chunk id
 * with its score, the ASSEMBLED PROMPT, the answer, the citations that survived
 * verification, latency, both token counts and the model id.
 *
 * Not in: a student id, a name, an email, or anything else identifying. The
 * trace is reachable FROM a message by `message_id` — plan §4 keys it that way
 * and a trace that could not be tied to the turn it explains would be useless —
 * but it carries no identifier of its own, so a query against this table is a
 * query about ANSWERS rather than a second copy of a child's activity log.
 *
 * `model` IS STORED RATHER THAN ASSUMED. The model id is an environment
 * variable (`LLM_MODEL`), so "which model produced this answer" is not
 * derivable from the code at any later date. Stamping it per row is the only
 * thing that makes a regression after a model change attributable.
 * ===========================================================================
 */
export const retrievalTraces = pgTable(
  'retrieval_traces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** CASCADE: a deleted message takes the explanation of itself with it. */
    messageId: uuid('message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    /** The question exactly as the student asked it. */
    query: text('query').notNull(),
    /** What was actually embedded and searched, after normalisation. */
    rewrittenQuery: text('rewritten_query').notNull(),
    grade: text('grade').notNull(),
    subject: text('subject').notNull(),
    /** `[{ chunkId, score, rank }]` — every candidate that reached the prompt. */
    retrieved: jsonb('retrieved').notNull().default([]),
    /** The citations that SURVIVED verification. */
    citations: jsonb('citations').notNull().default([]),
    /** Ids the model cited that were never retrieved, and were stripped. */
    fabricatedCitations: jsonb('fabricated_citations').notNull().default([]),
    /**
     * THE ASSEMBLED PROMPT, verbatim.
     *
     * The single most useful column here and the one most likely to be dropped
     * as "big". Without it, a bad answer can be reproduced only by re-running
     * the assembler as it exists TODAY — which is a different assembler from
     * the one that produced the answer being investigated.
     */
    prompt: text('prompt').notNull(),
    /** What the student was shown. Empty only when nothing was streamed. */
    answer: text('answer').notNull().default(''),
    abstained: boolean('abstained').notNull().default(false),
    /** Why, when it abstained: the retrieval reason or the safety refusal. */
    abstainReason: text('abstain_reason'),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('retrieval_traces_grade_check', sql`${table.grade} in (${gradeList})`),
    check('retrieval_traces_tokens_check', sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0`),
    check('retrieval_traces_latency_check', sql`${table.latencyMs} >= 0`),
    check(
      'retrieval_traces_retrieved_array_check',
      sql`case when jsonb_typeof(${table.retrieved}) = 'array' then true else false end`,
    ),
    check(
      'retrieval_traces_citations_array_check',
      sql`case when jsonb_typeof(${table.citations}) = 'array' then true else false end`,
    ),
    index('retrieval_traces_message_idx').on(table.messageId),
    index('retrieval_traces_created_idx').on(table.createdAt.desc()),
    index('retrieval_traces_tenant_idx').on(table.tenantId),
  ],
);
