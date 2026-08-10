import { sql } from 'drizzle-orm';
import type { Clock } from '@/platform/clock/index';
import type { DbHandle } from '@/platform/db/index';
import type { JobHandler } from '@/platform/jobs/index';
import type { Logger } from '@/platform/logger/index';

/**
 * The expired-session sweeper — the worker's first and, for now, only real job.
 *
 * ===========================================================================
 * IT HAS BEEN WAITING FOR THIS PROCESS TO EXIST.
 *
 * `PROGRESS.md` §7, "deliberately deferred, with the unblocking condition":
 * "Expired-session sweeper | the worker process". The worker now exists, so it
 * is no longer deferred. The weekly digest and the retention scheduler stay
 * deferred, because they arrive with `parent` and `practice` respectively —
 * there is nothing to digest and nothing to retain yet.
 *
 * ===========================================================================
 * WHY EXPIRED SESSIONS NEED SWEEPING AT ALL, given that they are already
 * refused.
 *
 * `validateSession` checks `expires_at` against the injected clock and reaps
 * the row it just found — so an expired session NEVER authenticates, sweeper or
 * no sweeper. THIS JOB IS NOT A SECURITY CONTROL and must not be mistaken for
 * one.
 *
 * What it is: hygiene with two concrete payoffs.
 *
 *  1. Rows only get reaped when somebody presents that exact token. A session
 *     abandoned on a lost phone is never presented again, so it never gets
 *     reaped — every one of those rows is permanent. At a 30-day TTL and any
 *     real user base, `sessions` becomes the largest table in the database and
 *     it is on the `auth` pool's hot path, which is the one §3.1 says "must
 *     never be starved".
 *
 *  2. Data minimisation. A session row carries `ip_hash` and `user_agent`.
 *     Keeping those forever for a session that ended months ago is retaining
 *     personal data with no purpose, on a platform serving minors.
 *
 * ===========================================================================
 * IDEMPOTENT, WHICH IS REQUIRED OF EVERY HANDLER AND FREE FOR THIS ONE.
 *
 * `delete ... where expires_at < now` run twice deletes the same set the first
 * time and nothing the second. There is no counter to double, no message to
 * send twice. That is not luck — it is the property `platform/jobs` demands of
 * every handler, and it is worth noticing that the natural formulation already
 * has it.
 *
 * ===========================================================================
 * BATCHED, AND THE BATCH IS THE ONLY SUBTLE THING HERE.
 *
 * The first sweep after this ships could match a very large number of rows. One
 * unbounded DELETE would take row locks on all of them inside a single
 * transaction, hold them for the duration, and generate one enormous WAL
 * record — on the `worker` pool, but against the same table LOGIN reads. §3.1's
 * pool bulkhead protects the connection count; it does not protect a table from
 * a lock taken on it.
 *
 * So the delete is chunked, with each batch its own transaction. Between
 * batches the locks are released and login proceeds. The trade is that the
 * sweep is not atomic — a crash halfway leaves half the expired rows deleted,
 * which is exactly as harmless as it sounds and is fixed by the next run.
 */

export const EXPIRED_SESSION_SWEEPER = 'identity.sweep_expired_sessions';

/**
 * Rows per statement. Small enough that no single DELETE holds locks for long;
 * large enough that a backlog clears in a sane number of round trips.
 */
const BATCH_SIZE = 1_000;

/**
 * A safety stop, not a capacity limit.
 *
 * Without it, a bug that made the predicate match live rows would delete the
 * entire table in one job run — every user logged out at once, with no
 * intervening moment for anybody to notice. With it, the worst single run is
 * bounded, the job logs that it hit the ceiling, and the rest waits for the
 * next run.
 */
const MAX_BATCHES_PER_RUN = 100;

export interface SweeperDeps {
  /** §3.1 — the `worker` pool. Background work never competes with login. */
  readonly db: DbHandle;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Deletes every session whose `expires_at` is STRICTLY IN THE PAST.
 *
 * Strictly: `<`, not `<=`. A session expiring at exactly this instant is not
 * yet expired, and `validateSession` uses the same boundary (`isExpired`).
 * Two components disagreeing by one instant on what "expired" means is the
 * kind of defect that reproduces once a month at a boundary nobody can hit on
 * purpose.
 *
 * Exported separately from the handler so it can be tested directly with a
 * `FixedClock`, without a queue.
 */
export async function sweepExpiredSessions(deps: SweeperDeps): Promise<number> {
  const { db, clock, logger } = deps;
  // ONE `now` for the whole run, taken once. Re-reading the clock per batch
  // would let the cutoff drift forward mid-sweep, so a session that expired
  // during the run would be deleted by a later batch but not an earlier one —
  // making the job's result depend on how long it took.
  const now = clock.now();

  let deleted = 0;
  let batches = 0;

  for (; batches < MAX_BATCHES_PER_RUN; batches += 1) {
    // The subquery + LIMIT is what bounds the batch. `delete ... limit` is not
    // valid Postgres, so the ids are selected first and deleted by primary key.
    // `sessions_expires_at_idx` (migration 0000) is what makes the select cheap.
    const result = await db.db.execute(sql`
      delete from sessions
      where id in (
        select id from sessions
        where expires_at < ${now.toISOString()}::timestamptz
        limit ${BATCH_SIZE}
      )
    `);
    const removed = result.rowCount ?? 0;
    deleted += removed;
    if (removed < BATCH_SIZE) break;
  }

  if (batches >= MAX_BATCHES_PER_RUN) {
    // Hitting the ceiling is either a genuine first-run backlog or a bug in the
    // predicate. Both deserve a line somebody reads.
    logger.warn(
      { event: 'sweeper.batch_ceiling', deleted, maxBatches: MAX_BATCHES_PER_RUN },
      'expired-session sweep hit its batch ceiling; the remainder waits for the next run',
    );
  }

  // Counts only. Never a user id, never a token hash, never an ip hash — this
  // line describes personal data and must not become personal data.
  logger.info({ event: 'sweeper.completed', deleted }, 'expired sessions swept');
  return deleted;
}

/** The registered handler. Thin: the work is testable without a queue. */
export function createExpiredSessionSweeper(deps: SweeperDeps): JobHandler {
  return async (): Promise<void> => {
    await sweepExpiredSessions(deps);
  };
}
