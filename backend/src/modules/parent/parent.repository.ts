import { sql } from 'drizzle-orm';
import type { DbHandle } from '@/platform/db/index';
import type { BilingualText } from '@/platform/notify-channel/index';
import type {
  ChapterWeek,
  MisconceptionSighting,
} from './domain/digest-evidence';
import type { WeekActivity } from './domain/snapshot';
import type { WeekWindow } from './domain/week-window';
import type { DigestRecord, TranscriptSession } from './parent.types';

/**
 * ALL database access for the parent module — §7, rule 4.
 *
 * Enforced by ESLint: `@/platform/db` and `drizzle-orm` are importable only
 * from a `*.repository.ts` file.
 *
 * ===========================================================================
 * THIS FILE READS FOUR OTHER MODULES' TABLES AND WRITES EXACTLY ONE.
 *
 * `practice_sessions`, `practice_responses`, `chapters`, `questions`,
 * `misconception_patterns` and `parent_child_links` are all read here, and none
 * of them belongs to `parent`. That is a deliberate exception to the usual
 * shape, and the reasoning is worth stating so nobody has to guess:
 *
 *   The parent module is a READ-ONLY REPORTING CONSUMER. A digest is a query
 *   across the whole product's evidence, and the alternative — asking
 *   `practice` to expose a `readParentEvidence` method — would move the parent
 *   digest's business rules into the practice module, which is the worse
 *   coupling. `practice.repository.ts` already reads `chapters` for the same
 *   class of reason.
 *
 * THE LINE THAT MUST NOT BE CROSSED: this module WRITES only `weekly_digests`.
 * A link is revoked by asking `identity` (the injected `LinkRevoker`), never by
 * an UPDATE here. `__tests__/parent.repository-writes.test.ts` reads this
 * file's source and fails if any other table is written, because "we only read"
 * is a claim that decays the first time an UPDATE looks convenient.
 * ===========================================================================
 *
 * EVERY QUERY IS SCOPED BY TENANT AS WELL AS BY STUDENT. The tenant predicate
 * is belt-and-braces, never the belt: `assertCanAccess` has already refused a
 * cross-tenant caller before any of these run (D-091). A `where` clause is
 * "enforced by remembering to write it", which is exactly what `platform/authz`
 * exists to remove — but the day one of these queries is copied into a new
 * method, the predicate travelling with it costs nothing.
 */

export type ParentDbHandle = DbHandle;

/** Where a digest's rows come from, and what one is written back as. */
export interface NewDigest {
  readonly parentUserId: string;
  readonly studentUserId: string;
  /** `YYYY-MM-DD` of the week's Monday. */
  readonly weekStart: string;
  readonly summary: BilingualText;
  readonly suggestedAction: BilingualText;
  readonly misconceptionCode: string | null;
  readonly sessionsCount: number;
  readonly questionsAnswered: number;
  readonly daysPractised: number;
  readonly chapterId: string | null;
  readonly tenantId: string;
  readonly generatedAt: Date;
}

export interface ParentRepository {
  /** The four headline counts for one week, from submitted sessions only. */
  readWeekActivity(
    studentUserId: string,
    tenantId: string,
    window: WeekWindow,
  ): Promise<WeekActivity>;
  /** Per-chapter effort for the week, with the mean score from BEFORE it. */
  readChapterWeeks(
    studentUserId: string,
    tenantId: string,
    window: WeekWindow,
  ): Promise<readonly ChapterWeek[]>;
  /** Misconceptions the child actually walked into. Empty today — D-077. */
  readMisconceptions(
    studentUserId: string,
    tenantId: string,
    window: WeekWindow,
  ): Promise<readonly MisconceptionSighting[]>;
  /** Recoveries and hints — effort signals that are not scores. */
  readEffortSignals(
    studentUserId: string,
    tenantId: string,
    window: WeekWindow,
  ): Promise<{ readonly recoveries: number; readonly hintsUsed: number }>;
  /** One stored digest, or null. */
  findDigest(
    parentUserId: string,
    studentUserId: string,
    weekStart: string,
  ): Promise<DigestRecord | null>;
  /**
   * Writes a digest, or does nothing if this week's already exists.
   *
   * Returns whether the row was created. `ON CONFLICT DO NOTHING` plus a read
   * back, so two concurrent generations agree on ONE digest rather than racing.
   */
  insertDigest(digest: NewDigest): Promise<{ readonly created: boolean }>;
  /**
   * Every parent with at least one approved link, for the weekly scan.
   *
   * SYSTEM-LEVEL: there is no actor. The set is resolved entirely from
   * `parent_child_links`, so no caller can widen it.
   */
  listParentsWithApprovedChildren(): Promise<readonly string[]>;
  /**
   * The approved children of one parent, WITH THE TENANT OF EACH SIDE.
   *
   * The digest job has no session to authorise against, so it authorises from
   * the data: this returns both tenants and the caller refuses any pair that
   * does not match. Same rule as the request path, same source (`users`).
   */
  listApprovedChildrenOf(parentUserId: string): Promise<
    readonly {
      readonly linkId: string;
      readonly studentUserId: string;
      readonly parentTenantId: string;
      readonly studentTenantId: string;
    }[]
  >;
  /**
   * The child's Foxy conversations.
   *
   * `foxy` is build step 10 and does not exist. Rather than stub a shape,
   * this probes the catalogue for `chat_sessions` and returns
   * `{ present: false }` until the tables land — at which point the query below
   * runs unchanged. READ ONLY: there is no write path to a transcript here or
   * anywhere in this module.
   */
  readTranscript(
    studentUserId: string,
    tenantId: string,
    limit: number,
  ): Promise<{ readonly present: boolean; readonly sessions: readonly TranscriptSession[] }>;
}

interface CountRow extends Record<string, unknown> {
  sessions: string | number;
  questions_answered: string | number;
  chapters_touched: string | number;
  days_practised: string | number;
}

/** `count()` arrives as a string from node-postgres. Converted in one place. */
function toCount(value: string | number | null): number {
  return value === null ? 0 : Number(value);
}

interface DigestRow extends Record<string, unknown> {
  id: string;
  parent_user_id: string;
  student_user_id: string;
  /** `YYYY-MM-DD`, or a `Date` if the driver's date parser is installed. */
  week_start: string | Date;
  summary_en: string;
  summary_hi: string;
  suggested_action_en: string;
  suggested_action_hi: string;
  misconception_code: string | null;
  /**
   * WIDER THAN THE COLUMN, DELIBERATELY — matching the `recoveries`/`hints` row
   * type further down this file.
   *
   * `db.execute<Row>` is an unchecked CLAIM about what the driver hands back,
   * not a parse. node-postgres decides per OID whether an `integer` arrives as a
   * number and whether a `date` arrives as a string or a `Date`, and that
   * decision is global process state a dependency bump can change. Declaring
   * these as the narrow type makes the `Number(...)`/`String(...)` below look
   * redundant — which is exactly what lint reported, and acting on that report
   * would delete the only thing standing between a driver change and
   * `"3" + 1 === "31"` in a parent's weekly digest.
   */
  sessions_count: string | number;
  questions_answered: string | number;
  days_practised: string | number;
  /**
   * A STRING, NOT A `Date` — and this cost a defect.
   *
   * It was declared `Date` and passed straight through to
   * `DigestRecord.generatedAt`, which is typed `Date`. Drizzle's `db.execute()`
   * runs raw SQL and does NOT install node-postgres's `timestamptz` parser: the
   * query builder does its own column mapping, so a raw execute hands back the
   * wire text — `'2026-08-10 14:01:20.396047+00'`. Measured, not assumed.
   *
   * Nothing caught it, and nothing was going to. `db.execute<Row>` is an
   * unchecked CLAIM about the row shape, so the compiler believed `Date` all
   * the way out to the service's return type; the value serialises to JSON
   * perfectly well (as a subtly different string from the ISO one every other
   * endpoint emits) and only explodes when somebody calls a `Date` method on
   * it. The first caller to do so was this module's own test.
   */
  generated_at: string | Date;
}

/**
 * A timestamp column into a real `Date`.
 *
 * Tolerant of BOTH shapes on purpose: `db.execute()` yields the wire string
 * today, and a future switch to the query builder — or a driver bump that
 * installs the parser — would yield a `Date`. A converter that handled only the
 * shape observed on the day it was written is how this defect comes back.
 */
function toDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  /**
   * Postgres's wire text is `2026-08-10 14:01:20.396047+00`. Two things about
   * it are not ISO-8601 and BOTH make `new Date()` return `Invalid Date`:
   *
   *   - a SPACE between the date and the time, rather than `T`;
   *   - a TWO-DIGIT offset `+00`, where ISO wants `+00:00` or `Z`.
   *
   * Found the hard way — the first repair here handled only the space and
   * produced an `Invalid Date`, which is worse than the string it replaced
   * because it satisfies `instanceof Date`. The test therefore asserts
   * `Number.isNaN(getTime())` as well as the type.
   */
  const iso = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  return new Date(iso);
}

function toDigestRecord(row: DigestRow): DigestRecord {
  return {
    id: row.id,
    parentUserId: row.parent_user_id,
    childUserId: row.student_user_id,
    // `date` comes back as `YYYY-MM-DD` already. Normalised through `Date` when
    // it does not, because `String(someDate).slice(0, 10)` would silently emit
    // `'Mon Jun 0'` — a wire contract broken into something that still looks
    // like a string. Same class of defect as `generated_at` above.
    weekStart:
      row.week_start instanceof Date
        ? row.week_start.toISOString().slice(0, 10)
        : row.week_start.slice(0, 10),
    summary: { en: row.summary_en, hi: row.summary_hi },
    suggestedAction: { en: row.suggested_action_en, hi: row.suggested_action_hi },
    misconceptionCode: row.misconception_code,
    sessionsCount: Number(row.sessions_count),
    questionsAnswered: Number(row.questions_answered),
    daysPractised: Number(row.days_practised),
    generatedAt: toDate(row.generated_at),
  };
}

export function createParentRepository(handle: ParentDbHandle): ParentRepository {
  const { db } = handle;

  return {
    async readWeekActivity(studentUserId, tenantId, window): Promise<WeekActivity> {
      /**
       * SUBMITTED SESSIONS ONLY.
       *
       * An abandoned session is not an achievement, and counting one would let
       * a child inflate every number in a parent's digest by opening the app
       * and closing it. `submitted_at` is also what the window is measured on:
       * a session started on Sunday and submitted on Monday belongs to the week
       * it was finished in, which is the week its evidence exists in.
       */
      const result = await db.execute<CountRow>(sql`
        select
          count(distinct s.id)                                      as sessions,
          count(r.id)                                               as questions_answered,
          count(distinct s.chapter_id)                              as chapters_touched,
          count(distinct (s.submitted_at at time zone 'UTC')::date) as days_practised
        from practice_sessions s
        left join practice_responses r on r.session_id = s.id
        where s.student_user_id = ${studentUserId}
          and s.tenant_id = ${tenantId}
          and s.submitted_at is not null
          and s.submitted_at >= ${window.from.toISOString()}
          and s.submitted_at < ${window.to.toISOString()}
      `);

      const row = result.rows[0];
      if (row === undefined) {
        return { sessions: 0, questionsAnswered: 0, chaptersTouched: 0, daysPractised: 0 };
      }
      return {
        sessions: toCount(row.sessions),
        questionsAnswered: toCount(row.questions_answered),
        chaptersTouched: toCount(row.chapters_touched),
        daysPractised: toCount(row.days_practised),
      };
    },

    async readChapterWeeks(studentUserId, tenantId, window): Promise<readonly ChapterWeek[]> {
      /**
       * THE COMPARISON IS AGAINST THE CHILD'S OWN EARLIER SESSIONS.
       *
       * `chapter_mastery` holds only the CURRENT value — there is no mastery
       * history table — so "did they get better at this" cannot be answered
       * from it. It can be answered from `practice_sessions`, which are
       * timestamped and immutable once submitted, so that is what this reads.
       *
       * `prior_average` is null when the child never practised the chapter
       * before this week, and the domain treats that as "not an improvement"
       * rather than as improvement from zero.
       */
      const result = await db.execute<{
        chapter_id: string;
        title_en: string;
        title_hi: string | null;
        sessions: string | number;
        questions_answered: string | number;
        average_score: string | number;
        prior_average: string | number | null;
      }>(sql`
        with sessions_week as (
          -- One row per SESSION. The response count is a scalar sub-select
          -- rather than a join, because joining responses and then averaging
          -- score_percent would weight each session by how many questions it
          -- happened to contain — a six-question session would count three
          -- times as much as a two-question one, silently.
          select
            s.id,
            s.chapter_id,
            s.score_percent,
            (select count(*) from practice_responses r where r.session_id = s.id) as answered
          from practice_sessions s
          where s.student_user_id = ${studentUserId}
            and s.tenant_id = ${tenantId}
            and s.submitted_at >= ${window.from.toISOString()}
            and s.submitted_at < ${window.to.toISOString()}
            and s.score_percent is not null
        ),
        this_week as (
          select
            chapter_id,
            count(*)             as sessions,
            sum(answered)        as questions_answered,
            avg(score_percent)   as average_score
          from sessions_week
          group by chapter_id
        ),
        before as (
          select s.chapter_id, avg(s.score_percent) as prior_average
          from practice_sessions s
          where s.student_user_id = ${studentUserId}
            and s.tenant_id = ${tenantId}
            and s.submitted_at < ${window.from.toISOString()}
            and s.score_percent is not null
          group by s.chapter_id
        )
        select
          t.chapter_id,
          c.title_en,
          c.title_hi,
          t.sessions,
          t.questions_answered,
          t.average_score,
          b.prior_average
        from this_week t
        join chapters c on c.id = t.chapter_id
        left join before b on b.chapter_id = t.chapter_id
        order by t.chapter_id
      `);

      return result.rows.map((row) => ({
        chapterId: row.chapter_id,
        /**
         * A MISSING HINDI TITLE FALLS BACK TO THE ENGLISH ONE.
         *
         * `chapters.title_hi` is nullable and 9 imported chapters carry a
         * placeholder title. One English chapter name inside an otherwise Hindi
         * sentence is worse than a translated one and far better than a
         * sentence that reads "… in null" or a line dropped entirely.
         */
        title: { en: row.title_en, hi: row.title_hi ?? row.title_en },
        sessions: toCount(row.sessions),
        questionsAnswered: toCount(row.questions_answered),
        averageScore: Number(row.average_score),
        priorAverageScore: row.prior_average === null ? null : Number(row.prior_average),
      }));
    },

    async readMisconceptions(
      studentUserId,
      tenantId,
      window,
    ): Promise<readonly MisconceptionSighting[]> {
      /**
       * THE JOIN THAT RETURNS NOTHING TODAY, AND IS WRITTEN PROPERLY ANYWAY.
       *
       * `questions.distractor_misconceptions` is a jsonb OBJECT KEYED BY OPTION
       * INDEX (migration 0003 of the superseded chain, D-048), and it is NULL on
       * all 2,741 imported questions (D-077). So this returns `[]` for every
       * real child this year.
       *
       * It reads `first_selected_index` rather than `selected_index`, and that
       * is the pedagogical point of the column: a child who picked the
       * misconception distractor and then corrected themselves DEMONSTRATED the
       * misconception. The final answer hides it; the first one is the
       * diagnosis.
       *
       * `misconception_patterns.pattern_code` — not `misconception_code`, which
       * is the name three source shapes were wrongly written against (D-098).
       * The join is LEFT, so a code with no pattern row still counts as a
       * sighting and reports its own code as the description rather than
       * vanishing.
       */
      const result = await db.execute<{
        code: string;
        description: string | null;
        title_en: string;
        title_hi: string | null;
        occurrences: string | number;
      }>(sql`
        select
          m.code,
          p.description,
          m.title_en,
          m.title_hi,
          count(*) as occurrences
        from (
          select
            q.distractor_misconceptions ->> (r.first_selected_index)::text as code,
            c.title_en,
            c.title_hi
          from practice_responses r
          join practice_sessions s on s.id = r.session_id
          join questions q on q.id = r.question_id
          join chapters c on c.id = s.chapter_id
          where r.student_user_id = ${studentUserId}
            and s.tenant_id = ${tenantId}
            and s.submitted_at >= ${window.from.toISOString()}
            and s.submitted_at < ${window.to.toISOString()}
            and r.is_correct = false
            and r.first_selected_index is not null
            and q.distractor_misconceptions is not null
        ) m
        left join misconception_patterns p on p.pattern_code = m.code
        where m.code is not null
        group by m.code, p.description, m.title_en, m.title_hi
        order by count(*) desc, m.code asc
      `);

      return result.rows.map((row) => ({
        code: row.code,
        // Never a fabricated description. With no pattern row the code IS the
        // description, which reads badly and is true — and the honesty gate
        // still refuses a code that was not observed.
        description: row.description ?? row.code,
        // `misconception_patterns` HAS NO HINDI COLUMN — not "usually null", it
        // does not exist (D-098, open item 14). Null here is the truth.
        descriptionHi: null,
        chapterTitle: { en: row.title_en, hi: row.title_hi ?? row.title_en },
        occurrences: toCount(row.occurrences),
      }));
    },

    async readEffortSignals(
      studentUserId,
      tenantId,
      window,
    ): Promise<{ readonly recoveries: number; readonly hintsUsed: number }> {
      const result = await db.execute<{ recoveries: string | number; hints: string | number }>(sql`
        select
          count(*) filter (
            where r.answer_changed = true and r.is_correct = true
          ) as recoveries,
          coalesce(sum(r.hint_level_used), 0) as hints
        from practice_responses r
        join practice_sessions s on s.id = r.session_id
        where r.student_user_id = ${studentUserId}
          and s.tenant_id = ${tenantId}
          and s.submitted_at >= ${window.from.toISOString()}
          and s.submitted_at < ${window.to.toISOString()}
      `);

      const row = result.rows[0];
      return {
        recoveries: toCount(row?.recoveries ?? 0),
        hintsUsed: toCount(row?.hints ?? 0),
      };
    },

    async findDigest(parentUserId, studentUserId, weekStart): Promise<DigestRecord | null> {
      const result = await db.execute<DigestRow>(sql`
        select * from weekly_digests
        where parent_user_id = ${parentUserId}
          and student_user_id = ${studentUserId}
          and week_start = ${weekStart}::date
        limit 1
      `);
      const row = result.rows[0];
      return row === undefined ? null : toDigestRecord(row);
    },

    async insertDigest(digest: NewDigest): Promise<{ readonly created: boolean }> {
      /**
       * ON CONFLICT DO NOTHING, AGAINST THE UNIQUE CONSTRAINT.
       *
       * Not "check then insert": two concurrent generations — a parent tapping
       * refresh while the weekly worker runs — would both find nothing and both
       * insert. The unique index is the only thing that can settle that, and
       * `created` is derived from whether THIS statement produced a row, so the
       * loser reports `created: false` truthfully rather than overwriting.
       */
      const result = await db.execute<{ id: string }>(sql`
        insert into weekly_digests (
          parent_user_id, student_user_id, week_start,
          summary_en, summary_hi,
          suggested_action_en, suggested_action_hi,
          misconception_code,
          sessions_count, questions_answered, days_practised,
          chapter_id, tenant_id, generated_at
        ) values (
          ${digest.parentUserId}, ${digest.studentUserId}, ${digest.weekStart}::date,
          ${digest.summary.en}, ${digest.summary.hi},
          ${digest.suggestedAction.en}, ${digest.suggestedAction.hi},
          ${digest.misconceptionCode},
          ${digest.sessionsCount}, ${digest.questionsAnswered}, ${digest.daysPractised},
          ${digest.chapterId}, ${digest.tenantId}, ${digest.generatedAt.toISOString()}
        )
        on conflict (parent_user_id, student_user_id, week_start) do nothing
        returning id
      `);
      return { created: result.rows.length > 0 };
    },

    async listParentsWithApprovedChildren(): Promise<readonly string[]> {
      const result = await db.execute<{ parent_user_id: string }>(sql`
        select distinct parent_user_id
        from parent_child_links
        where status = 'approved'
        order by parent_user_id
      `);
      return result.rows.map((row) => row.parent_user_id);
    },

    async listApprovedChildrenOf(parentUserId: string) {
      const result = await db.execute<{
        link_id: string;
        student_user_id: string;
        parent_tenant_id: string;
        student_tenant_id: string;
      }>(sql`
        select
          l.id                as link_id,
          l.student_user_id   as student_user_id,
          pu.tenant_id        as parent_tenant_id,
          su.tenant_id        as student_tenant_id
        from parent_child_links l
        join users pu on pu.id = l.parent_user_id
        join users su on su.id = l.student_user_id
        where l.parent_user_id = ${parentUserId}
          and l.status = 'approved'
        order by l.student_user_id
      `);
      return result.rows.map((row) => ({
        linkId: row.link_id,
        studentUserId: row.student_user_id,
        parentTenantId: row.parent_tenant_id,
        studentTenantId: row.student_tenant_id,
      }));
    },

    async readTranscript(studentUserId, tenantId, limit) {
      /**
       * THE FOXY SEAM.
       *
       * `chat_sessions` and `chat_messages` are plan §4's foxy tables and foxy
       * is build step 10 — it does not exist. This probes the catalogue rather
       * than assuming: the day those tables land, the query below starts
       * returning rows with no change here.
       *
       * Deliberately NOT a stub returning fabricated conversations, and
       * deliberately not an empty array with no explanation — the caller turns
       * `present: false` into `source: 'not_yet_available'`, so a parent looking
       * at an empty list can tell "no conversations" from "this feature has not
       * shipped".
       */
      const probe = await db.execute<{ present: boolean }>(sql`
        select (to_regclass('public.chat_sessions') is not null
                and to_regclass('public.chat_messages') is not null) as present
      `);
      if (probe.rows[0]?.present !== true) {
        return { present: false, sessions: [] };
      }

      // `string | Date` on every timestamp, for the reason spelled out on
      // `DigestRow.generated_at`: `db.execute()` hands back the wire text, and
      // declaring `Date` here would put the SAME defect on the transcript path
      // — where it would surface the day foxy ships rather than today.
      const sessions = await db.execute<{
        id: string;
        mode: string;
        started_at: string | Date;
        last_message_at: string | Date | null;
      }>(sql`
        select id, mode, started_at, last_message_at
        from chat_sessions
        where student_user_id = ${studentUserId}
          and tenant_id = ${tenantId}
        order by started_at desc
        limit ${limit}
      `);
      if (sessions.rows.length === 0) return { present: true, sessions: [] };

      const ids = sessions.rows.map((row) => row.id);
      const messages = await db.execute<{
        id: string;
        session_id: string;
        role: string;
        content: string;
        created_at: string | Date;
      }>(sql`
        select id, session_id, role, content, created_at
        from chat_messages
        where session_id = any(${ids}::uuid[])
        order by created_at asc
      `);

      return {
        present: true,
        sessions: sessions.rows.map((session) => ({
          sessionId: session.id,
          mode: session.mode,
          startedAt: toDate(session.started_at),
          lastMessageAt: session.last_message_at === null ? null : toDate(session.last_message_at),
          messages: messages.rows
            .filter((message) => message.session_id === session.id)
            .map((message) => ({
              id: message.id,
              role: message.role === 'user' ? ('student' as const) : ('foxy' as const),
              text: message.content,
              createdAt: toDate(message.created_at),
            })),
        })),
      };
    },
  };
}
