import { sql } from 'drizzle-orm';
import type { DbPools, DbPoolStats } from './pools';

/**
 * The readiness probe for the database — 04-RESILIENCE-PLAN.md §8.
 *
 * Lives in `platform/db` rather than in `app/health.ts` because `src/app/**`
 * is forbidden from importing the database client (plan §7, rule 4). The
 * health route receives this as a plain function and never learns what a pool
 * is, which is the boundary working as intended rather than an inconvenience.
 */

export interface DatabaseHealth {
  readonly reachable: boolean;
  readonly migrationsApplied: boolean;
  readonly latencyMs: number;
  /** Log-safe. Never the connection string, which carries the password. */
  readonly error: string | undefined;
  readonly pools: readonly DbPoolStats[];
}

export interface DatabaseProbe {
  check(): Promise<DatabaseHealth>;
}

/**
 * Stops WAITING on a query after `ms`. It does not cancel it — Postgres kills
 * it via the pool's `statement_timeout`. This bounds the health check, which
 * is the thing a load balancer is holding open.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`database probe exceeded ${String(ms)}ms`));
    }, ms);
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * `select 1` plus a migration count.
 *
 * The migration check is the half that is easy to leave out and expensive to
 * miss: a process that connects to a database with no schema is "reachable"
 * and completely unable to serve a request. Rolling a deploy in front of an
 * unmigrated database is how a green readiness check routes traffic into
 * 500s.
 *
 * The probe uses the `core` pool deliberately. Probing through `auth` would
 * let a health checker consume the one pool §3.1 says must never be starved.
 */
export function createDatabaseProbe(pools: DbPools, timeoutMs: number): DatabaseProbe {
  return {
    async check(): Promise<DatabaseHealth> {
      const startedAt = Date.now();
      const poolStats = pools.stats();

      try {
        // SEQUENTIAL, not concurrent, and that is a correctness point rather
        // than a style one. Running both up front and awaiting the second only
        // on the first's success leaves the second promise rejecting with
        // nobody listening — an unhandled rejection, on every readiness probe,
        // for as long as the database is down. Which is precisely when the
        // process can least afford the noise. A test caught this.
        //
        // Sequencing also means a probe costs one connection, not two.
        //
        // The per-call deadline is layered on top of the pool's own
        // connection-level `statement_timeout`: a readiness check that hangs
        // for ten seconds has already failed, and a load balancer waiting on
        // it is worse than a fast 503.
        await withDeadline(pools.core.db.execute(sql`select 1 as ok`), timeoutMs);

        let migrationsApplied = false;
        try {
          const result = await withDeadline(
            pools.core.db.execute(
              sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
            ),
            timeoutMs,
          );
          const rows = result.rows as { count?: number }[];
          migrationsApplied = (rows[0]?.count ?? 0) > 0;
        } catch {
          // The table does not exist: nothing has ever been migrated. An
          // unmigrated database is reachable and completely unable to serve a
          // request, which is exactly what readiness is for.
          migrationsApplied = false;
        }

        return {
          reachable: true,
          migrationsApplied,
          latencyMs: Date.now() - startedAt,
          error: undefined,
          pools: poolStats,
        };
      } catch (cause) {
        return {
          reachable: false,
          migrationsApplied: false,
          latencyMs: Date.now() - startedAt,
          // `error.message` only. A pg connection error can carry the host,
          // the port and the user; the connection string carries the password.
          error: cause instanceof Error ? cause.message : 'unknown database error',
          pools: poolStats,
        };
      }
    },
  };
}
