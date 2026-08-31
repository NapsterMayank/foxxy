import { sql } from 'drizzle-orm';
import type { DbHandle } from '@/platform/db/index';
import { readWorkerLiveness, type WorkerLiveness } from '@/platform/jobs/index';

/**
 * =============================================================================
 * admin — THE READER. IT NEVER WRITES, AND THAT IS ENFORCED RATHER THAN MEANT.
 *
 * There is no `insert`, no `update` and no `delete` in this file, and a lint
 * rule fails the build if one appears. That constraint is not fastidiousness:
 * it is one of the three things standing in for `assertCanAccess`, which the
 * admin routes deliberately bypass because an operations surface reads across
 * every tenant by definition. The other two are the `requireAdmin` gate and the
 * audit row per read. Remove any one and the design stops being defensible —
 * see the header of `shared/http/require-admin.ts`.
 *
 * -----------------------------------------------------------------------------
 * IT OWNS NO TABLES. Every table read here belongs to another module, and this
 * file is a rebuildable read model over them: if a shape changes underneath, a
 * query here breaks loudly and no data is corrupted, because nothing here can
 * corrupt data. A WRITE would have to go to the owning module, and that is not
 * a rule this file is trusted to remember — it is a rule it cannot break.
 *
 * -----------------------------------------------------------------------------
 * RAW SQL RATHER THAN THE DRIZZLE SCHEMA OBJECTS, on purpose.
 *
 * These are cross-module aggregate reads — counts over nine tables, a group-by
 * across the job queue, a window sum over `metrics_events`. Expressing them
 * through eight modules' table declarations would make this file import eight
 * modules' internals, which is exactly the dependency fan-in that made the
 * "call every module's service" approach unworkable in the first place.
 * =============================================================================
 */

/**
 * The handle this module reads through.
 *
 * Re-exported so `index.ts` can name it without importing `platform/db` —
 * which the database rule forbids outside a repository, and rightly: the alias
 * is the module's public statement about what it needs, and the import is the
 * capability. Only this file gets the capability.
 */
export type AdminDbHandle = DbHandle;

export interface AdminOverviewCounts {
  readonly users: number;
  readonly students: number;
  readonly parents: number;
  readonly practiceSessions: number;
  readonly chatSessions: number;
  readonly questions: number;
  readonly chapters: number;
  readonly ragChunksActive: number;
  readonly activeSubscriptions: number;
}

export interface JobStatusCount {
  readonly status: string;
  readonly kind: string;
  readonly count: number;
}

export interface DeadLetter {
  readonly id: string;
  readonly kind: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly updatedAt: Date;
}

export interface MetricSummary {
  readonly name: string;
  readonly kind: string;
  readonly total: number;
  readonly occurrences: number;
  readonly lastRecordedAt: Date;
}

export interface AdminRepository {
  overviewCounts(): Promise<AdminOverviewCounts>;
  jobCounts(): Promise<readonly JobStatusCount[]>;
  deadLetters(limit: number): Promise<readonly DeadLetter[]>;
  oldestPendingSeconds(): Promise<number | null>;
  workers(now: Date, staleAfterMs: number): Promise<readonly WorkerLiveness[]>;
  recentMetrics(windowMinutes: number): Promise<readonly MetricSummary[]>;
  databaseNow(): Promise<Date>;
}

/**
 * Nine scalar subqueries, one row. `count(*)` is `bigint` — wire text.
 *
 * The index signature is what `db.execute<T>` constrains on; the named fields
 * are what makes `row.users` legal instead of `row['users']`. Both, because the
 * driver's generic wants the former and the linter wants the latter.
 */
interface OverviewRow extends Record<string, string> {
  readonly users: string;
  readonly students: string;
  readonly parents: string;
  readonly practice_sessions: string;
  readonly chat_sessions: string;
  readonly questions: string;
  readonly chapters: string;
  readonly rag_chunks_active: string;
  readonly active_subscriptions: string;
}

/** The driver hands back `Date` or wire text for a `timestamptz` (D-305). */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Postgres `count(*)` is `bigint`, which arrives as a string. */
function toCount(value: string | number | null): number {
  return value === null ? 0 : Number(value);
}

export function createAdminRepository(db: AdminDbHandle): AdminRepository {
  return {
    /**
     * ONE ROUND TRIP FOR NINE COUNTS.
     *
     * Nine separate `select count(*)` would be nine round trips on a screen an
     * operator refreshes while watching an incident — which is the moment the
     * database has least to spare. A single statement of scalar subqueries
     * plans each one independently and returns one row.
     *
     * These are EXACT counts, not `pg_stat_user_tables` estimates. The estimate
     * is what a previous session was bitten by: it reported 0 rows for tables
     * holding thousands, and an overview that under-reports is worse than one
     * that is slightly slow.
     */
    async overviewCounts(): Promise<AdminOverviewCounts> {
      const result = await db.db.execute<OverviewRow>(sql`
        select
          (select count(*) from users)                          as users,
          (select count(*) from students)                       as students,
          (select count(*) from users where role = 'parent')    as parents,
          (select count(*) from practice_sessions)              as practice_sessions,
          (select count(*) from chat_sessions)                  as chat_sessions,
          (select count(*) from questions where is_active)      as questions,
          (select count(*) from chapters where is_active)       as chapters,
          -- ACTIVE chunks. The content-coverage screen counts ALL of them, and
          -- the two numbers differed by 283 with nothing on either screen saying
          -- why. Both are correct; only one was labelled. The field is now named
          -- for what it counts.
          (select count(*) from rag_chunks where is_active)     as rag_chunks_active,
          (select count(*) from subscriptions
            where status in ('active', 'past_due'))             as active_subscriptions
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error('admin.overviewCounts: no row');

      return {
        users: toCount(row.users),
        students: toCount(row.students),
        parents: toCount(row.parents),
        practiceSessions: toCount(row.practice_sessions),
        chatSessions: toCount(row.chat_sessions),
        questions: toCount(row.questions),
        chapters: toCount(row.chapters),
        ragChunksActive: toCount(row.rag_chunks_active),
        activeSubscriptions: toCount(row.active_subscriptions),
      };
    },

    async jobCounts(): Promise<readonly JobStatusCount[]> {
      const result = await db.db.execute<{ status: string; kind: string; count: string }>(sql`
        select status, kind, count(*) as count
          from jobs
         group by status, kind
         order by status, kind
      `);
      return result.rows.map((row) => ({
        status: row.status,
        kind: row.kind,
        count: toCount(row.count),
      }));
    },

    /**
     * A dead job is kept rather than deleted — `jobs`' own comment says why:
     * "a job that gave up silently is a job nobody investigates." This is the
     * screen that stops it being silent.
     */
    async deadLetters(limit: number): Promise<readonly DeadLetter[]> {
      const result = await db.db.execute<{
        id: string;
        kind: string;
        attempts: number;
        last_error: string | null;
        updated_at: Date | string;
      }>(sql`
        select id, kind, attempts, last_error, updated_at
          from jobs
         where status = 'dead'
         order by updated_at desc
         limit ${limit}
      `);
      return result.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        attempts: row.attempts,
        lastError: row.last_error,
        updatedAt: toDate(row.updated_at),
      }));
    },

    /**
     * THE AGE OF THE OLDEST CLAIMABLE JOB — the number that says whether the
     * worker is keeping up, which no count of pending jobs can tell you.
     *
     * `run_at <= now()` and not simply `status = 'pending'`: a job scheduled for
     * next Tuesday is pending and is not a backlog, and counting it would make
     * every scheduled digest look like an incident.
     */
    async oldestPendingSeconds(): Promise<number | null> {
      const result = await db.db.execute<{ seconds: string | null }>(sql`
        select extract(epoch from (now() - min(run_at))) as seconds
          from jobs
         where status in ('pending', 'failed')
           and run_at <= now()
      `);
      const raw = result.rows[0]?.seconds;
      return raw === null || raw === undefined ? null : Number(raw);
    },

    /**
     * DELEGATED, NOT RE-QUERIED. `worker-liveness-single-implementation.test.ts`
     * exists because this query was once written twice and the two copies
     * disagreed about what "live" meant. There is one implementation and this
     * calls it.
     */
    async workers(now: Date, staleAfterMs: number): Promise<readonly WorkerLiveness[]> {
      return await readWorkerLiveness(db, now, staleAfterMs);
    },

    async recentMetrics(windowMinutes: number): Promise<readonly MetricSummary[]> {
      const result = await db.db.execute<{
        name: string;
        kind: string;
        total: string;
        occurrences: string;
        last_recorded_at: Date | string;
      }>(sql`
        select name,
               min(kind)            as kind,
               coalesce(sum(value), 0) as total,
               count(*)             as occurrences,
               max(recorded_at)     as last_recorded_at
          from metrics_events
         where recorded_at >= now() - make_interval(mins => ${windowMinutes})
         group by name
         order by max(recorded_at) desc
      `);
      return result.rows.map((row) => ({
        name: row.name,
        kind: row.kind,
        total: Number(row.total),
        occurrences: toCount(row.occurrences),
        lastRecordedAt: toDate(row.last_recorded_at),
      }));
    },

    /**
     * The database's clock, not the process's. Every age on the monitoring
     * screens is a subtraction, and doing it against the API host's clock makes
     * the answer depend on how far the two have drifted apart.
     */
    async databaseNow(): Promise<Date> {
      const result = await db.db.execute<{ now: Date | string }>(sql`select now() as now`);
      const row = result.rows[0];
      if (row === undefined) throw new Error('admin.databaseNow: no row');
      return toDate(row.now);
    },
  };
}
