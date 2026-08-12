import { hostname } from 'node:os';
import { sql } from 'drizzle-orm';
import type { Clock } from '../clock/index';
import type { DbHandle } from '../db/index';
import { schema } from '../db/index';
import type { Logger } from '../logger/index';

/**
 * The worker's liveness signal — 04-RESILIENCE-PLAN.md §8, applied to a process
 * that has no HTTP surface.
 *
 * ===========================================================================
 * WHY A ROW AND NOT AN ENDPOINT.
 *
 * §8's three endpoints work because something CALLS them. The worker listens on
 * nothing: giving it an HTTP server purely to be probed would mean a port, a
 * second shutdown path, and a liveness answer that is true whenever the HTTP
 * server is alive — which says nothing about whether the job loop is turning.
 * A worker whose loop has deadlocked would answer 200 all day.
 *
 * A heartbeat row inverts it. The worker writes; anyone reads. "Is the worker
 * alive?" becomes
 *
 *     select now() - last_beat_at from worker_heartbeats where status = 'running'
 *
 * which a probe, a dashboard, `/health/deps` and a human at 2am can all ask —
 * and which is only fresh if the LOOP ran, not merely if the process exists.
 * That is a stronger statement than any endpoint could make.
 *
 * ===========================================================================
 * ONE ROW PER PROCESS, KEYED BY HOSTNAME AND START TIME.
 *
 * A single shared row would make two healthy workers indistinguishable from one
 * healthy worker and one that died an hour ago — the survivor keeps the
 * timestamp fresh and the corpse is invisible. Per-process rows make a dead
 * replica visible as a stale row, which is the thing worth seeing.
 *
 * The start time is in the key so a restarted worker gets a NEW row and leaves
 * the old one behind. That is deliberate: it is the evidence a restart happened.
 * Reaping stale `stopped` rows is a retention job, not this file's problem.
 */

const { workerHeartbeats } = schema;

export interface HeartbeatOptions {
  readonly db: DbHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly workerId: string;
}

export interface Heartbeat {
  readonly workerId: string;
  /** Stamps the row. Never throws — see below. */
  beat(jobsProcessed: number, status?: 'running' | 'draining'): Promise<void>;
  /** Marks the worker stopped. Called from the shutdown path. */
  stop(jobsProcessed: number): Promise<void>;
}

/**
 * `hostname:pid:startedAtMs`.
 *
 * The hostname identifies the container, the pid disambiguates within it, and
 * the start time guarantees a restarted worker never collides with the row its
 * predecessor left behind — which is what makes a stale row readable as "that
 * one died" rather than as "that one is slow".
 */
export function buildWorkerId(startedAt: Date, pid: number): string {
  return `${hostname()}:${String(pid)}:${String(startedAt.getTime())}`;
}

export function createHeartbeat(options: HeartbeatOptions): Heartbeat {
  const { db, clock, logger, workerId } = options;
  const startedAt = clock.now();

  async function write(
    jobsProcessed: number,
    status: 'running' | 'draining' | 'stopped',
  ): Promise<void> {
    const now = clock.now();
    try {
      await db.db
        .insert(workerHeartbeats)
        .values({ workerId, startedAt, lastBeatAt: now, jobsProcessed, status })
        .onConflictDoUpdate({
          target: workerHeartbeats.workerId,
          set: { lastBeatAt: now, jobsProcessed, status },
        });
    } catch (error) {
      // NEVER RETHROWN. A heartbeat is an observation ABOUT the worker; letting
      // it kill the worker would mean the monitoring takes down the thing it
      // monitors. The row simply goes stale, which is exactly the signal a
      // reader needs anyway — and it is logged, so the staleness has an
      // explanation beside it rather than being a mystery.
      logger.warn(
        {
          event: 'worker.heartbeat_failed',
          err: error instanceof Error ? error.message : 'unknown heartbeat failure',
        },
        'worker heartbeat could not be written; the row will read as stale',
      );
    }
  }

  return {
    workerId,
    beat: (jobsProcessed, status = 'running') => write(jobsProcessed, status),
    stop: (jobsProcessed) => write(jobsProcessed, 'stopped'),
  };
}

/**
 * Reads liveness for anyone who wants it — `/health/deps`, an operator, a probe.
 *
 * `staleAfterMs` is the caller's judgement, not this module's: a worker running
 * a two-minute job has not beaten in two minutes and is perfectly healthy, so
 * only the caller knows what "stale" means for its own purposes.
 */
export interface WorkerLiveness {
  readonly workerId: string;
  readonly lastBeatAt: Date;
  readonly status: string;
  readonly jobsProcessed: number;
  readonly stale: boolean;
}

/**
 * The driver may hand back a `Date` or an ISO string for a `timestamptz`.
 * Normalised at the row boundary — see `readWorkerLiveness`.
 */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export async function readWorkerLiveness(
  db: DbHandle,
  now: Date,
  staleAfterMs: number,
): Promise<readonly WorkerLiveness[]> {
  const result = await db.db.execute<{
    worker_id: string;
    /**
     * ========================================================================
     * `Date | string`, NOT `Date` — D-305, and it is D-233/D-267 again.
     *
     * This was declared `Date` and then had `.getTime()` called on it eleven
     * lines below. `db.execute` runs raw SQL through node-postgres, and what
     * comes back for a `timestamptz` is WIRE TEXT unless a type parser says
     * otherwise — so this function threw `row.last_beat_at.getTime is not a
     * function` on its very first run against a real database.
     *
     * `postgres-queue.ts`, in this same directory, on this same driver, carries
     * a long comment explaining exactly this and typing all three of its
     * timestamps as the union. That entry predicted the failure precisely: "the
     * first caller to write `job.runAt.getTime()` gets a `TypeError` in a
     * worker, at runtime, with a compiler that had already signed off on it."
     * This file was simply not repaired at the same time, and the only reason
     * nobody hit it is that `readWorkerLiveness` had no callers — which is not
     * a reason it was safe, it is a reason it was untested.
     *
     * Typed as the union the driver actually returns and normalised once, so
     * the honesty stops at the boundary and `WorkerLiveness.lastBeatAt` is the
     * real `Date` it has always claimed to be.
     * ========================================================================
     */
    last_beat_at: Date | string;
    status: string;
    jobs_processed: string;
  }>(sql`
    select worker_id, last_beat_at, status, jobs_processed::text as jobs_processed
    from worker_heartbeats
    where status <> 'stopped'
    order by last_beat_at desc
  `);

  return result.rows.map((row) => {
    // D-305 — normalised, not asserted. See the field's comment above.
    const lastBeatAt = toDate(row.last_beat_at);
    return {
      workerId: row.worker_id,
      lastBeatAt,
      status: row.status,
      jobsProcessed: Number(row.jobs_processed),
      stale: now.getTime() - lastBeatAt.getTime() > staleAfterMs,
    };
  });
}
