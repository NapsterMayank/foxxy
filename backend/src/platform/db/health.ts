import { sql } from 'drizzle-orm';
import {
  evaluateMigrationState,
  readMigrationManifest,
  type MigrationManifest,
} from './migration-manifest';
import type { DbPools, DbPoolStats } from './pools';

/**
 * The readiness probe for the database — 04-RESILIENCE-PLAN.md §8.
 *
 * Lives in `platform/db` rather than in `app/health.ts` because `src/app/**`
 * is forbidden from importing the database client (plan §7, rule 4). The
 * health route receives this as a plain function and never learns what a pool
 * is, which is the boundary working as intended rather than an inconvenience.
 *
 * ===========================================================================
 * IT REPORTS A CLASSIFICATION, NEVER A VENDOR ERROR — D-229.
 *
 * This interface used to carry `error: string | undefined`, populated from
 * `cause.message` and rendered verbatim into the body of BOTH `/health/ready`
 * and `/health/deps`, which are reachable by anything that can reach the
 * service. The comment beside it said "log-safe; never the connection string,
 * which carries the password" — and that was true and beside the point,
 * because a node-postgres connection failure reads:
 *
 *     connect ECONNREFUSED 10.0.3.14:5432
 *     password authentication failed for user "foxxy_app"
 *     no pg_hba.conf entry for host "10.0.1.7", user "foxxy_app"
 *
 * Host, port, username, and the private address of the application itself, to
 * an unauthenticated caller, at the exact moment the database is down and
 * somebody is looking for a way in. The comment at the old line 107
 * ACKNOWLEDGED the risk and the code did not act on it, which is the same
 * shape as every other defect in this codebase: the guard was written as prose.
 *
 * The classification is a closed union. It answers the only question an
 * operator can act on from a probe — is it unreachable, is it slow, or is the
 * schema incomplete — and it cannot grow a host name because it is not a
 * string.
 */

/**
 * Why the database is not ready. A closed set, so nothing vendor-shaped can
 * reach a response body through it.
 */
export type DatabaseFailure =
  /** No connection: refused, DNS, auth, pg_hba. Deliberately not distinguished. */
  | 'unreachable'
  /** Connected, but the probe exceeded its deadline. */
  | 'timeout'
  /** Reachable, and the schema does not match the migrations in this build. */
  | 'schema_incomplete';

export interface DatabaseHealth {
  readonly reachable: boolean;
  /** True only when EVERY migration in this build's journal is applied. */
  readonly migrationsApplied: boolean;
  readonly latencyMs: number;
  /** A classification, never a vendor message. `null` when healthy. */
  readonly failure: DatabaseFailure | null;
  readonly pools: readonly DbPoolStats[];
}

export interface DatabaseProbe {
  check(): Promise<DatabaseHealth>;
  /**
   * What this build expects to be applied. Exposed so `createContainer` can
   * refuse to boot in production when the journal is missing from the image.
   */
  readonly manifest: MigrationManifest;
}

/**
 * Stops WAITING on a query after `ms`. It does not cancel it — Postgres kills
 * it via the pool's `statement_timeout`. This bounds the health check, which
 * is the thing a load balancer is holding open.
 */
class ProbeTimeout extends Error {}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // No interpolation of anything caller-supplied. The message never reaches
      // a response body, but it does reach a log, and a probe error is not the
      // place to start a new habit.
      reject(new ProbeTimeout(`database probe exceeded ${String(ms)}ms`));
    }, ms);
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export interface DatabaseProbeOptions {
  readonly pools: DbPools;
  readonly timeoutMs: number;
  /**
   * Where the drizzle journal lives. Read ONCE, here, not per probe.
   *
   * Injectable as a manifest rather than only as a path so a test can state the
   * expected set directly instead of writing files.
   */
  readonly migrationsDir?: string;
  readonly manifest?: MigrationManifest;
}

/**
 * `select 1`, plus the APPLIED MIGRATION SET compared against the journal.
 *
 * The migration check is the half that is easy to leave out and expensive to
 * miss: a process that connects to a database with no schema is "reachable"
 * and completely unable to serve a request. It was previously satisfied by ANY
 * row in `__drizzle_migrations`, which meant a half-applied deploy reported
 * ready — see the header of `migration-manifest.ts`.
 *
 * The probe uses the `core` pool deliberately. Probing through `auth` would
 * let a health checker consume the one pool §3.1 says must never be starved.
 */
export function createDatabaseProbe(options: DatabaseProbeOptions): DatabaseProbe {
  const { pools, timeoutMs } = options;
  const manifest =
    options.manifest ?? readMigrationManifest(options.migrationsDir ?? './drizzle/migrations');

  return {
    manifest,

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

        let applied: number[] = [];
        try {
          const result = await withDeadline(
            pools.core.db.execute(
              sql`select created_at from drizzle.__drizzle_migrations order by created_at asc`,
            ),
            timeoutMs,
          );
          // `created_at` is a bigint, which node-postgres returns as a string.
          // Coerced through Number rather than trusted, so a driver change that
          // starts returning BigInt does not silently produce a set that
          // matches nothing and fails readiness forever.
          applied = (result.rows as { created_at?: string | number }[])
            .map((row) => Number(row.created_at))
            .filter((value) => Number.isFinite(value));
        } catch {
          // The table does not exist: nothing has ever been migrated. An
          // unmigrated database is reachable and completely unable to serve a
          // request, which is exactly what readiness is for.
          applied = [];
        }

        const state = evaluateMigrationState(manifest, applied);

        return {
          reachable: true,
          migrationsApplied: state.fullyApplied,
          latencyMs: Date.now() - startedAt,
          failure: state.fullyApplied ? null : 'schema_incomplete',
          pools: poolStats,
        };
      } catch (cause) {
        return {
          reachable: false,
          migrationsApplied: false,
          latencyMs: Date.now() - startedAt,
          /**
           * A CLASSIFICATION. Never `cause.message` — see the header.
           *
           * `cause` is deliberately not inspected beyond its own type: any
           * attempt to distinguish ECONNREFUSED from an auth failure would mean
           * reading a vendor string, and the two facts an operator can act on
           * from a probe are "we could not connect" and "it took too long".
           */
          failure: cause instanceof ProbeTimeout ? 'timeout' : 'unreachable',
          pools: poolStats,
        };
      }
    },
  };
}
