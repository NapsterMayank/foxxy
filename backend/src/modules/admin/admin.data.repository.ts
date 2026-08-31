import { sql, type SQL } from 'drizzle-orm';
import type { AdminDbHandle } from './admin.repository';

/**
 * =============================================================================
 * admin — THE DATA READS. Same rules as `admin.repository.ts`: SELECT only, no
 * tables owned, nothing written, enforced by lint rather than remembered.
 *
 * A SECOND FILE rather than a longer first one. The monitoring reads answer
 * "is the system healthy"; these answer "what happened to this learner". They
 * share a constraint and nothing else — different tables, different lifetimes,
 * different reasons to change — and one file doing both would be the thing that
 * grows until nobody reads it before editing.
 *
 * -----------------------------------------------------------------------------
 * WHAT COMES OUT OF HERE IS STILL RAW.
 *
 * These rows carry real emails, real display names and real message text. The
 * masking happens ONE LAYER UP, in the service, because a repository that
 * masked would make the reveal endpoint impossible to build without a second
 * unmasked path — and a second path is how the first one eventually gets
 * bypassed. One road in, one gate on it.
 * =============================================================================
 */

/** `(created_at DESC, id DESC)` keyset, as a reusable predicate. */
function keysetBefore(column: SQL, idColumn: SQL, at: Date, id: string): SQL {
  return sql`(${column}, ${idColumn}) < (${at}, ${id}::uuid)`;
}

/**
 * Every row shape below extends `Record<string, unknown>` because that is what
 * `db.execute<T>` constrains on. The NAMED fields are what make `row.email`
 * legal instead of `row['email']`; the index signature is what satisfies the
 * driver. Both, for the same reason as `OverviewRow` in the sibling file.
 */
export interface UserRow extends Record<string, unknown> {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly tenant_id: string;
  readonly email_verified_at: Date | string | null;
  readonly created_at: Date | string;
}

export interface LearnerRow extends Record<string, unknown> {
  readonly display_name: string;
  readonly grade: string;
  readonly board: string;
  readonly preferred_language: string;
  readonly subjects: string[] | null;
}

export interface ActivityRow extends Record<string, unknown> {
  readonly kind: string;
  readonly ref_id: string;
  readonly visit_id: string | null;
  readonly chapter_id: string | null;
  readonly started_at: Date | string;
  readonly last_event_at: Date | string | null;
  readonly outcome: string;
}

export interface PracticeSessionRow extends Record<string, unknown> {
  readonly id: string;
  readonly student_user_id: string;
  readonly chapter_id: string;
  readonly visit_id: string | null;
  readonly started_at: Date | string;
  readonly submitted_at: Date | string | null;
  readonly score_percent: number | null;
  readonly xp_earned: number | null;
  readonly is_valid: boolean | null;
  readonly invalid_reason: string | null;
  readonly questions_served: number;
  readonly target_question_count: number;
  readonly created_at: Date | string;
}

/**
 * `string | number` ON THE COUNT COLUMNS, AND IT IS NOT HEDGING.
 *
 * `count(*)` is `bigint`, which node-postgres hands back as WIRE TEXT so that
 * values above 2^53 survive the trip. `jsonb_array_length` and `cardinality`
 * are `integer` and arrive as numbers. Declaring all of them `number` would
 * be a type that is wrong at runtime for half of them, and the symptom is a
 * count rendered as "12" that sorts before "9".
 *
 * So the union is the truth, and the service converts once at the boundary.
 */
export interface ChatSessionRow extends Record<string, unknown> {
  readonly id: string;
  readonly student_user_id: string;
  readonly visit_id: string | null;
  readonly mode: string;
  readonly subject: string;
  readonly chapter_id: string | null;
  readonly language: string;
  readonly started_at: Date | string;
  readonly last_message_at: Date | string | null;
  readonly message_count: string | number;
  readonly abstentions: string | number;
}

export interface ChatTurnRow extends Record<string, unknown> {
  readonly id: string;
  readonly role: string;
  readonly content: string;
  readonly action: string | null;
  readonly abstained: boolean;
  readonly citation_count: number;
  readonly created_at: Date | string;
}

export interface TraceRow extends Record<string, unknown> {
  readonly id: string;
  readonly message_id: string;
  readonly grade: string;
  readonly subject: string;
  readonly model: string;
  readonly abstained: boolean;
  readonly abstain_reason: string | null;
  readonly query: string;
  readonly prompt: string;
  readonly answer: string;
  readonly retrieved_count: number;
  readonly citation_count: number;
  readonly fabricated_count: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly latency_ms: number;
  readonly created_at: Date | string;
}

export interface SubscriptionRow extends Record<string, unknown> {
  readonly id: string;
  readonly subject_user_id: string;
  /**
   * THE UNIONS ARE DECLARED HERE BECAUSE THE DATABASE ENFORCES THEM.
   *
   * `subscriptions_payer_kind_check` and `subscriptions_status_check` are CHECK
   * constraints, so a row outside these sets cannot exist — the column IS the
   * closed set and the type says the same thing. Widening to `string` and
   * narrowing again in the service would be re-deriving in TypeScript a fact
   * Postgres already guarantees, and the narrowing would need a fallback branch
   * for a value that cannot occur.
   *
   * If a CHECK is ever widened, this type is one of the places that must change
   * with it — which is the right kind of coupling.
   */
  readonly payer_kind: 'user' | 'school';
  readonly plan_code: string;
  readonly status: 'pending' | 'active' | 'past_due' | 'cancelled' | 'expired';
  readonly provider: string;
  readonly amount_minor_units: number;
  readonly currency: string;
  readonly current_period_end: Date | string | null;
  readonly cancelled_at: Date | string | null;
  readonly created_at: Date | string;
}

export interface AuditRow extends Record<string, unknown> {
  readonly id: string;
  readonly actor_user_id: string | null;
  readonly actor_role: string | null;
  readonly action: string;
  readonly resource_type: string;
  readonly resource_id: string | null;
  readonly tenant_id: string | null;
  readonly metadata: Record<string, unknown>;
  readonly created_at: Date | string;
}

export interface CoverageRow extends Record<string, unknown> {
  readonly questions_total: string;
  readonly questions_active: string;
  readonly questions_held_out: string;
  readonly questions_with_misconceptions: string;
  readonly chapters_total: string;
  readonly chapters_with_questions: string;
  readonly chapters_with_concepts: string;
  readonly chapters_with_chunks: string;
  readonly chunks_total: string;
  readonly chunks_embedded: string;
}

export interface Page<T> {
  readonly rows: readonly T[];
}

export interface AdminDataRepository {
  users(limit: number, before: { at: Date; id: string } | null): Promise<readonly UserRow[]>;
  user(id: string): Promise<UserRow | null>;
  learner(userId: string): Promise<LearnerRow | null>;
  userCounts(
    userId: string,
  ): Promise<{ practiceSessions: number; chatSessions: number; sessions: number }>;
  activity(
    learnerId: string,
    limit: number,
    before: { at: Date; id: string } | null,
  ): Promise<readonly ActivityRow[]>;
  practiceSessions(
    limit: number,
    before: { at: Date; id: string } | null,
    studentUserId: string | null,
  ): Promise<readonly PracticeSessionRow[]>;
  practiceSession(id: string): Promise<PracticeSessionRow | null>;
  chatSessions(
    limit: number,
    before: { at: Date; id: string } | null,
    studentUserId: string | null,
  ): Promise<readonly ChatSessionRow[]>;
  chatSession(id: string): Promise<ChatSessionRow | null>;
  chatTurns(sessionId: string): Promise<readonly ChatTurnRow[]>;
  trace(id: string): Promise<TraceRow | null>;
  /** The trace explaining one message, or null when the turn produced none. */
  traceByMessage(messageId: string): Promise<TraceRow | null>;
  subscriptions(
    limit: number,
    before: { at: Date; id: string } | null,
  ): Promise<readonly SubscriptionRow[]>;
  auditEntries(
    limit: number,
    before: { at: Date; id: string } | null,
  ): Promise<readonly AuditRow[]>;
  coverage(): Promise<CoverageRow>;
  /** Distinct non-null visits for a learner, over their WHOLE history. */
  visitCount(learnerId: string): Promise<number>;
  /** The raw values behind a mask. Reached ONLY from the reveal path. */
  revealUserEmail(id: string): Promise<string | null>;
  revealLearnerName(userId: string): Promise<string | null>;
  revealTranscript(sessionId: string): Promise<readonly string[]>;
  revealTrace(id: string): Promise<{ query: string; prompt: string; answer: string } | null>;
  coverageByGradeSubject(): Promise<
    readonly { grade: string; subject_code: string; chapters: string; questions: string }[]
  >;
}

export function createAdminDataRepository(db: AdminDbHandle): AdminDataRepository {
  /** `and <keyset>` or nothing, so every list shares one paging shape. */
  const before = (
    at: SQL,
    id: SQL,
    cursor: { at: Date; id: string } | null,
  ): SQL => (cursor === null ? sql`true` : keysetBefore(at, id, cursor.at, cursor.id));

  return {
    async users(limit, cursor): Promise<readonly UserRow[]> {
      const result = await db.db.execute<UserRow>(sql`
        select id, email::text as email, role, tenant_id, email_verified_at, created_at
          from users
         where ${before(sql`created_at`, sql`id`, cursor)}
         order by created_at desc, id desc
         limit ${limit}
      `);
      return result.rows;
    },

    async user(id): Promise<UserRow | null> {
      const result = await db.db.execute<UserRow>(sql`
        select id, email::text as email, role, tenant_id, email_verified_at, created_at
          from users where id = ${id}::uuid
      `);
      return result.rows[0] ?? null;
    },

    /**
     * The learner profile and its subjects in one round trip.
     *
     * `student_subjects` is a separate table with a composite key, so the
     * obvious shape is two queries or a join that multiplies the profile row
     * per subject. `array_agg` in a lateral keeps it one row and one trip.
     */
    async learner(userId): Promise<LearnerRow | null> {
      const result = await db.db.execute<LearnerRow>(sql`
        select s.display_name, s.grade, s.board, s.preferred_language,
               (select array_agg(ss.subject_code order by ss.subject_code)
                  from student_subjects ss
                 where ss.student_user_id = s.user_id) as subjects
          from students s
         where s.user_id = ${userId}::uuid
      `);
      return result.rows[0] ?? null;
    },

    async userCounts(userId): Promise<{
      practiceSessions: number;
      chatSessions: number;
      sessions: number;
    }> {
      const result = await db.db.execute<
        Record<string, unknown> & {
          practice_sessions: string;
          chat_sessions: string;
          sessions: string;
        }
      >(sql`
        select
          (select count(*) from practice_sessions where student_user_id = ${userId}::uuid) as practice_sessions,
          (select count(*) from chat_sessions     where student_user_id = ${userId}::uuid) as chat_sessions,
          (select count(*) from sessions          where user_id         = ${userId}::uuid) as sessions
      `);
      const row = result.rows[0];
      return {
        practiceSessions: Number(row?.practice_sessions ?? 0),
        chatSessions: Number(row?.chat_sessions ?? 0),
        sessions: Number(row?.sessions ?? 0),
      };
    },

    /**
     * THE D-401 VIEW, READ BY THE ROUTE IT WAS BUILT FOR.
     *
     * `v_learner_activity` unions chat and practice so one learner's day is one
     * query instead of two stitched on a timestamp. It carries no access check
     * of its own — the gate and the audit row are the access control here, and
     * the tenant column is present so a human can still scope by it.
     */
    async activity(learnerId, limit, cursor): Promise<readonly ActivityRow[]> {
      const result = await db.db.execute<ActivityRow>(sql`
        select kind, ref_id, visit_id, chapter_id, started_at, last_event_at, outcome
          from v_learner_activity
         where student_user_id = ${learnerId}::uuid
           and ${before(sql`started_at`, sql`ref_id`, cursor)}
         order by started_at desc, ref_id desc
         limit ${limit}
      `);
      return result.rows;
    },

    /**
     * `questions_served` IS `cardinality(question_ids)`, NOT the target.
     *
     * The array grows as questions are handed out, so its length is PROGRESS and
     * `target_question_count` beside it is the INTENT. An operator needs both:
     * served below target is how a chapter that has run dry looks from here.
     */
    /**
     * COUNTED OVER THE WHOLE FEED, NOT OVER A PAGE.
     *
     * The page-local version of this number was wrong in two directions at
     * once: a visit spanning a page boundary was counted twice by a reader
     * walking pages, and a learner with more visits than fit on one page was
     * under-reported. "How many sittings was this" is a question about the
     * learner, so it is asked of the learner rather than of the fifty rows that
     * happened to load.
     */
    async visitCount(learnerId): Promise<number> {
      const result = await db.db.execute<Record<string, unknown> & { visits: string }>(sql`
        select count(distinct visit_id) as visits
          from v_learner_activity
         where student_user_id = ${learnerId}::uuid
           and visit_id is not null
      `);
      return Number(result.rows[0]?.visits ?? 0);
    },

    async practiceSessions(limit, cursor, studentUserId): Promise<readonly PracticeSessionRow[]> {
      const result = await db.db.execute<PracticeSessionRow>(sql`
        select id, student_user_id, chapter_id, visit_id, started_at, submitted_at,
               score_percent, xp_earned, is_valid, invalid_reason,
               cardinality(question_ids) as questions_served,
               target_question_count, created_at
          from practice_sessions
         where ${before(sql`started_at`, sql`id`, cursor)}
           and (${studentUserId === null ? sql`true` : sql`student_user_id = ${studentUserId}::uuid`})
         order by started_at desc, id desc
         limit ${limit}
      `);
      return result.rows;
    },

    async practiceSession(id): Promise<PracticeSessionRow | null> {
      const result = await db.db.execute<PracticeSessionRow>(sql`
        select id, student_user_id, chapter_id, visit_id, started_at, submitted_at,
               score_percent, xp_earned, is_valid, invalid_reason,
               cardinality(question_ids) as questions_served,
               target_question_count, created_at
          from practice_sessions where id = ${id}::uuid
      `);
      return result.rows[0] ?? null;
    },

    /**
     * Chat sessions with their turn counts.
     *
     * `message_count` and `abstentions` are aggregated in the SAME query rather
     * than fetched per row: a list of fifty sessions would otherwise be fifty-one
     * round trips, which is the classic N+1 and shows up first on the screen
     * somebody opens during an incident.
     */
    async chatSessions(limit, cursor, studentUserId): Promise<readonly ChatSessionRow[]> {
      const result = await db.db.execute<ChatSessionRow>(sql`
        select cs.id, cs.student_user_id, cs.visit_id, cs.mode, cs.subject, cs.chapter_id,
               cs.language, cs.started_at, cs.last_message_at,
               coalesce(m.message_count, 0) as message_count,
               coalesce(m.abstentions, 0)   as abstentions
          from chat_sessions cs
          left join lateral (
            select count(*) as message_count,
                   count(*) filter (where abstained) as abstentions
              from chat_messages where session_id = cs.id
          ) m on true
         where ${before(sql`cs.started_at`, sql`cs.id`, cursor)}
           and (${studentUserId === null ? sql`true` : sql`cs.student_user_id = ${studentUserId}::uuid`})
         order by cs.started_at desc, cs.id desc
         limit ${limit}
      `);
      return result.rows;
    },

    async chatSession(id): Promise<ChatSessionRow | null> {
      const result = await db.db.execute<ChatSessionRow>(sql`
        select cs.id, cs.student_user_id, cs.visit_id, cs.mode, cs.subject, cs.chapter_id,
               cs.language, cs.started_at, cs.last_message_at,
               coalesce(m.message_count, 0) as message_count,
               coalesce(m.abstentions, 0)   as abstentions
          from chat_sessions cs
          left join lateral (
            select count(*) as message_count,
                   count(*) filter (where abstained) as abstentions
              from chat_messages where session_id = cs.id
          ) m on true
         where cs.id = ${id}::uuid
      `);
      return result.rows[0] ?? null;
    },

    /**
     * The turns, ORDERED BY `seq` AND NOT BY `created_at`.
     *
     * A question and its reply can share a millisecond, and under a fixed clock
     * they share it always — so ordering by time returns them in whatever order
     * the plan produced and the transcript reads backwards at random. `seq` is
     * a bigserial and is what ordering here actually means.
     *
     * `content` IS SELECTED and is redacted one layer up. Nothing but its
     * LENGTH survives into the response.
     */
    async chatTurns(sessionId): Promise<readonly ChatTurnRow[]> {
      const result = await db.db.execute<ChatTurnRow>(sql`
        select id, role, content, action, abstained,
               jsonb_array_length(citations) as citation_count,
               created_at
          from chat_messages
         where session_id = ${sessionId}::uuid
         order by seq asc
      `);
      return result.rows;
    },

    async trace(id): Promise<TraceRow | null> {
      const result = await db.db.execute<TraceRow>(sql`
        select id, message_id, grade, subject, model, abstained, abstain_reason,
               query, prompt, answer,
               jsonb_array_length(retrieved)            as retrieved_count,
               jsonb_array_length(citations)            as citation_count,
               jsonb_array_length(fabricated_citations) as fabricated_count,
               input_tokens, output_tokens, latency_ms, created_at
          from retrieval_traces where id = ${id}::uuid
      `);
      return result.rows[0] ?? null;
    },

    /**
     * =========================================================================
     * THE OTHER DIRECTION OF A JOIN THAT ONLY WENT ONE WAY.
     *
     * A trace carries its `message_id`, so trace -> message always worked.
     * Message -> trace did not, and adding `messageId` to the turn shape did
     * not fix it on its own: an id with no endpoint behind it is a fact the UI
     * can display and not act on, which is how the session screen ended up
     * carrying a footnote apologising for a link it could not build.
     *
     * A SEPARATE METHOD rather than widening `trace(id)` to accept either kind
     * of id. One parameter that means two different things is resolved by
     * guessing, and the guess would be "try it as a trace id, then as a message
     * id" — which turns a typo into a second query and an ambiguous 404.
     *
     * `limit 1` and newest-first: one message has at most one trace today, and
     * ordering makes that assumption survive the day it stops being true.
     * =========================================================================
     */
    async traceByMessage(messageId): Promise<TraceRow | null> {
      const result = await db.db.execute<TraceRow>(sql`
        select id, message_id, grade, subject, model, abstained, abstain_reason,
               query, prompt, answer,
               jsonb_array_length(retrieved)            as retrieved_count,
               jsonb_array_length(citations)            as citation_count,
               jsonb_array_length(fabricated_citations) as fabricated_count,
               input_tokens, output_tokens, latency_ms, created_at
          from retrieval_traces
         where message_id = ${messageId}::uuid
         order by created_at desc
         limit 1
      `);
      return result.rows[0] ?? null;
    },

    async subscriptions(limit, cursor): Promise<readonly SubscriptionRow[]> {
      const result = await db.db.execute<SubscriptionRow>(sql`
        select id, subject_user_id, payer_kind, plan_code, status, provider,
               amount_minor_units, currency, current_period_end, cancelled_at, created_at
          from subscriptions
         where ${before(sql`created_at`, sql`id`, cursor)}
         order by created_at desc, id desc
         limit ${limit}
      `);
      return result.rows;
    },

    async auditEntries(limit, cursor): Promise<readonly AuditRow[]> {
      const result = await db.db.execute<AuditRow>(sql`
        select id, actor_user_id, actor_role, action, resource_type, resource_id,
               tenant_id, metadata, created_at
          from audit_log
         where ${before(sql`created_at`, sql`id`, cursor)}
         order by created_at desc, id desc
         limit ${limit}
      `);
      return result.rows;
    },

    /**
     * WHERE THE CONTENT IS THIN — one statement, ten numbers.
     *
     * `questions_with_misconceptions` is the one to look at first: D-077 records
     * that it is zero on every imported question, which means misconception
     * remediation is wired end to end and has nothing to say. A feature that
     * looks built and behaves empty is the failure this screen exists to make
     * visible without running a script.
     */
    /**
     * TWO DENOMINATOR FIXES LIVE IN THIS QUERY, and both were numbers that read
     * as facts while being neither.
     *
     *  counted across ALL questions while
     *  counted only the servable ones. Side by side that
     * reads as a ratio and is not one; both are now over the active set.
     *
     *  was ,
     * which counted a chapter whose only questions are held out or withdrawn as
     * covered. A held-out question must NEVER be served in practice, so such a
     * chapter is exactly as empty to a learner as one with no questions at all.
     */
    async coverage(): Promise<CoverageRow> {
      const result = await db.db.execute<CoverageRow>(sql`
        select
          (select count(*) from questions)                                  as questions_total,
          (select count(*) from questions where is_active)                  as questions_active,
          (select count(*) from questions where is_held_out)                as questions_held_out,
          -- Same denominator as questions_active -- see the note above the method.
          (select count(*) from questions
            where is_active and distractor_misconceptions is not null)      as questions_with_misconceptions,
          (select count(*) from chapters)                                   as chapters_total,
          -- Practisable questions only -- see the note above the method.
          (select count(distinct chapter_id) from questions
            where is_active and not is_held_out)                            as chapters_with_questions,
          (select count(distinct chapter_id) from chapter_concepts)         as chapters_with_concepts,
          (select count(distinct chapter_id) from rag_chunks
            where chapter_id is not null)                                   as chapters_with_chunks,
          (select count(*) from rag_chunks)                                 as chunks_total,
          (select count(*) from rag_chunks where embedding is not null)     as chunks_embedded
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error('admin.coverage: no row');
      return row;
    },

    /**
     * =========================================================================
     * THE REVEAL READS. Four narrow queries, each returning ONE masked value.
     *
     * Deliberately not "select * and let the service pick". A wide select puts
     * every column of the row in memory and one careless spread away from a
     * response — and the whole point of this endpoint is that unmasking is
     * narrow. Each query returns the column it is named after and nothing else.
     * =========================================================================
     */
    async revealUserEmail(id): Promise<string | null> {
      const result = await db.db.execute<Record<string, unknown> & { email: string }>(
        sql`select email::text as email from users where id = ${id}::uuid`,
      );
      return result.rows[0]?.email ?? null;
    },

    async revealLearnerName(userId): Promise<string | null> {
      const result = await db.db.execute<Record<string, unknown> & { display_name: string }>(
        sql`select display_name from students where user_id = ${userId}::uuid`,
      );
      return result.rows[0]?.display_name ?? null;
    },

    /** Ordered by `seq`, for the reason given on `chatTurns`. */
    async revealTranscript(sessionId): Promise<readonly string[]> {
      const result = await db.db.execute<Record<string, unknown> & { line: string }>(
        sql`select role || ': ' || content as line
              from chat_messages
             where session_id = ${sessionId}::uuid
             order by seq asc`,
      );
      return result.rows.map((row) => row.line);
    },

    async revealTrace(
      id,
    ): Promise<{ query: string; prompt: string; answer: string } | null> {
      const result = await db.db.execute<
        Record<string, unknown> & { query: string; prompt: string; answer: string }
      >(sql`select query, prompt, answer from retrieval_traces where id = ${id}::uuid`);
      const row = result.rows[0];
      return row === undefined
        ? null
        : { query: row.query, prompt: row.prompt, answer: row.answer };
    },

    async coverageByGradeSubject(): Promise<
      readonly { grade: string; subject_code: string; chapters: string; questions: string }[]
    > {
      const result = await db.db.execute<
        Record<string, unknown> & {
          grade: string;
          subject_code: string;
          chapters: string;
          questions: string;
        }
      >(sql`
        select c.grade, c.subject_code,
               count(distinct c.id) as chapters,
               count(q.id)          as questions
          from chapters c
          left join questions q on q.chapter_id = c.id
         group by c.grade, c.subject_code
         order by c.grade, c.subject_code
      `);
      return result.rows;
    },
  };
}
