/**
 * WHERE THE SIGNALS COME FROM.
 *
 * `alert-rules.ts` is pure and knows nothing about Postgres, HTTP or the
 * filesystem. This file is the impure half: it produces a `Signals` map and
 * nothing else, so every rule can be tested without any of it.
 *
 * =============================================================================
 * FOUR SOURCES, AND WHY NONE OF THEM IS "THE APPLICATION".
 *
 *   metrics_events   the durable sink §5 asks for. Aggregated over a window.
 *   Postgres itself  pg_stat_activity for connection saturation, and
 *                    worker_heartbeats for worker liveness (§3.2 — the worker
 *                    has no HTTP surface, so its liveness IS a row).
 *   HTTP             /health/ready, because "is the API taking traffic" cannot
 *                    be answered from inside the API's own database.
 *   filesystem       the age of the newest base backup on the backup volume.
 *
 * The evaluator deliberately does not import the application. If it did, a
 * defect in the application would take the thing that reports defects with it.
 *
 * =============================================================================
 * A SIGNAL THAT CANNOT BE MEASURED IS OMITTED, NEVER ZEROED.
 *
 * Every collector below is individually failure-isolated: one that throws
 * contributes NO KEY to the map rather than a zero. `evaluate()` skips absent
 * signals, so a collector failure suppresses only its own rules — and the
 * failure is reported, at `error`, as its own event.
 *
 * Zeroing would be catastrophic in the ordinary way: "the database is
 * unreachable, so I counted zero breaker transitions" reads as good news
 * produced by the exact fault it is meant to detect.
 */

import { sql } from 'drizzle-orm';
import type { DbHandle } from '../../src/platform/db/index';
import type { Logger } from '../../src/platform/logger/index';
import { SIGNALS } from './alert-rules';

export interface SignalCollectionOptions {
  readonly db: DbHandle;
  readonly logger: Logger;
  /** How far back the counting rules look. Must exceed the loop interval. */
  readonly windowMinutes: number;
  /** `/health/ready` of the API being watched. */
  readonly readinessUrl: string;
  /** Where full-backup.sh publishes base backups. Omitted = not measured. */
  readonly backupDir?: string | undefined;
  /** Injected so the collection has no wall-clock dependency in tests. */
  readonly now: Date;
}

export interface CollectedSignals {
  readonly signals: Record<string, number>;
  /** Signals that could not be measured this cycle, with the reason. */
  readonly failures: readonly { readonly signal: string; readonly reason: string }[];
}

/** Every signal this collector is CAPABLE of producing, measured or not. */
export function producibleSignals(options: { readonly backupDir?: string | undefined }): string[] {
  const names: string[] = [
    SIGNALS.BREAKER_OPENED,
    SIGNALS.RATE_LIMIT_FALLBACK,
    SIGNALS.JOB_DEAD_LETTERED,
    SIGNALS.DEPENDENCY_ERRORS,
    SIGNALS.NOTIFY_FAILED,
    SIGNALS.READINESS_FAILING,
    SIGNALS.DB_POOL_SATURATION,
    SIGNALS.WORKER_HEARTBEAT_AGE_SECONDS,
  ];
  // Only claimed when a directory was actually configured. Claiming it
  // unconditionally would let `assertRulesAreSatisfiable` pass while the backup
  // rule silently never fires — the orphan-rule failure, one level up.
  if (options.backupDir !== undefined && options.backupDir.length > 0) {
    names.push(SIGNALS.BACKUP_AGE_HOURS);
  }
  return names;
}

/** Metric names as emitted by `platform/metrics`. Duplicated here on purpose:
 *  see the note in collectMetricCounts. */
const METRIC = {
  BREAKER_TRANSITION: 'platform.breaker.transition',
  BREAKER_REJECTED: 'platform.breaker.rejected',
  CONCURRENCY_REJECTED: 'platform.concurrency.rejected',
  PORT_TIMEOUT: 'platform.port.timeout',
  JOB_DEAD: 'platform.job.dead',
  NOTIFY_FAILED: 'platform.notify.failed',
  RATE_LIMIT_FALLBACK: 'identity.rate_limit.in_process_fallback',
} as const;

interface MetricCountRow {
  readonly name: string;
  readonly to_state: string | null;
  readonly total: string | number;
}

/**
 * ONE query for every counting signal.
 *
 * Not one query per rule: this runs every 60 seconds forever, and the index on
 * `(name, recorded_at desc)` serves a single grouped scan far better than seven
 * separate ones. Cheap observability stays switched on; expensive observability
 * gets switched off during the incident it was bought for.
 */
async function collectMetricCounts(
  db: DbHandle,
  windowMinutes: number,
): Promise<Record<string, number>> {
  const names = Object.values(METRIC);

  const result = await db.db.execute(sql`
    select
      name,
      tags ->> 'to' as to_state,
      coalesce(sum(value), 0) as total
    from metrics_events
    where recorded_at >= now() - make_interval(mins => ${windowMinutes})
      and name = any(${sql.raw(`array[${names.map((name) => `'${name}'`).join(',')}]`)})
    group by name, tags ->> 'to'
  `);

  const rows = result.rows as unknown as MetricCountRow[];
  const total = (name: string, toState?: string): number =>
    rows
      .filter((row) => row.name === name && (toState === undefined || row.to_state === toState))
      .reduce((sum, row) => sum + Number(row.total), 0);

  return {
    // Transitions INTO open only. Counting every transition would count the
    // recovery (open -> half-open -> closed) as three more incidents.
    [SIGNALS.BREAKER_OPENED]: total(METRIC.BREAKER_TRANSITION, 'open'),
    [SIGNALS.RATE_LIMIT_FALLBACK]: total(METRIC.RATE_LIMIT_FALLBACK),
    [SIGNALS.JOB_DEAD_LETTERED]: total(METRIC.JOB_DEAD),
    [SIGNALS.NOTIFY_FAILED]: total(METRIC.NOTIFY_FAILED),
    [SIGNALS.DEPENDENCY_ERRORS]:
      total(METRIC.PORT_TIMEOUT) +
      total(METRIC.BREAKER_REJECTED) +
      total(METRIC.CONCURRENCY_REJECTED),
  };
}

interface SaturationRow {
  readonly used: string | number;
  readonly capacity: string | number;
}

/** §2 F4 — the most under-estimated failure in the model. */
async function collectPoolSaturation(db: DbHandle): Promise<number> {
  const result = await db.db.execute(sql`
    select
      (select count(*) from pg_stat_activity where datname = current_database()) as used,
      current_setting('max_connections')::int as capacity
  `);
  const row = (result.rows as unknown as SaturationRow[])[0];
  if (row === undefined) throw new Error('pg_stat_activity returned no row');
  const capacity = Number(row.capacity);
  if (capacity <= 0) throw new Error('max_connections is not a positive number');
  return Number(row.used) / capacity;
}

interface HeartbeatRow {
  readonly age_seconds: string | number | null;
}

/**
 * §3.2 — the worker's liveness is a ROW, because it has no HTTP surface.
 *
 * NO ROWS AT ALL is reported as a very large age rather than as "cannot
 * measure". A worker that has never started and a worker that died are the same
 * outage from a user's point of view, and treating the first as unmeasurable
 * would mean the alert never fires on the deployment where the worker was
 * simply forgotten.
 */
async function collectWorkerHeartbeatAge(db: DbHandle): Promise<number> {
  const result = await db.db.execute(sql`
    select extract(epoch from (now() - max(last_beat_at))) as age_seconds
    from worker_heartbeats
  `);
  const row = (result.rows as unknown as HeartbeatRow[])[0];
  const age = row?.age_seconds;
  if (age === null || age === undefined) return Number.MAX_SAFE_INTEGER;
  return Number(age);
}

/**
 * §8 — "should it receive traffic?"
 *
 * A non-200, a timeout and a connection refusal are ALL "failing". They are not
 * distinguished here because the answer is the same in every case: the load
 * balancer has stopped routing, or is about to.
 *
 * The 5-second budget is deliberately shorter than the loop interval, so a
 * wedged API cannot stall the evaluator that is trying to report it.
 */
async function collectReadiness(readinessUrl: string): Promise<number> {
  try {
    const response = await fetch(readinessUrl, { signal: AbortSignal.timeout(5_000) });
    return response.ok ? 0 : 1;
  } catch {
    return 1;
  }
}

interface BackupAgeSource {
  newestBackupMs(directory: string): Promise<number | undefined>;
}

/**
 * §7. Injected so the rule is testable without a filesystem, and so the
 * container that runs the evaluator needs only a READ-ONLY mount of the backup
 * volume.
 */
export function createFsBackupAgeSource(
  readdir: (path: string) => Promise<string[]>,
  stat: (path: string) => Promise<{ mtimeMs: number }>,
): BackupAgeSource {
  return {
    async newestBackupMs(directory: string): Promise<number | undefined> {
      const entries = await readdir(directory);
      // `.partial` is an interrupted backup. Counting it would make a crashed
      // backup look like a successful one — the precise inversion of what this
      // signal is for.
      const complete = entries.filter((entry) => !entry.endsWith('.partial'));
      if (complete.length === 0) return undefined;
      const times = await Promise.all(
        complete.map(async (entry) => (await stat(`${directory}/${entry}`)).mtimeMs),
      );
      return Math.max(...times);
    },
  };
}

export async function collectSignals(
  options: SignalCollectionOptions,
  backupAgeSource?: BackupAgeSource,
): Promise<CollectedSignals> {
  const { db, logger, windowMinutes, readinessUrl, backupDir, now } = options;

  const signals: Record<string, number> = {};
  const failures: { signal: string; reason: string }[] = [];

  const attempt = async (
    label: string,
    collect: () => Promise<Record<string, number>>,
  ): Promise<void> => {
    try {
      Object.assign(signals, await collect());
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown collection failure';
      failures.push({ signal: label, reason });
      // `error`, not `warn`. An unmeasurable signal is a BLIND SPOT, and a blind
      // spot in the alerting system is itself an incident — every rule on that
      // signal is now silently disabled.
      logger.error({ event: 'alerts.collector_failed', collector: label, err: reason }, 'a signal could not be measured; its rules are disabled this cycle');
    }
  };

  // Isolated one from another on purpose: a database outage must not prevent
  // the READINESS signal from being collected, and readiness is exactly the
  // signal that matters during a database outage.
  await attempt('metrics', () => collectMetricCounts(db, windowMinutes));
  await attempt('db_pool_saturation', async () => ({
    [SIGNALS.DB_POOL_SATURATION]: await collectPoolSaturation(db),
  }));
  await attempt('worker_heartbeat', async () => ({
    [SIGNALS.WORKER_HEARTBEAT_AGE_SECONDS]: await collectWorkerHeartbeatAge(db),
  }));
  await attempt('readiness', async () => ({
    [SIGNALS.READINESS_FAILING]: await collectReadiness(readinessUrl),
  }));

  if (backupDir !== undefined && backupDir.length > 0 && backupAgeSource !== undefined) {
    await attempt('backup_age', async () => {
      const newest = await backupAgeSource.newestBackupMs(backupDir);
      // No backup at all is an infinite age, not an unmeasurable one. "There has
      // never been a backup" must page, and it is the state a new deployment is
      // in until the first nightly run.
      const ageHours =
        newest === undefined ? Number.MAX_SAFE_INTEGER : (now.getTime() - newest) / 3_600_000;
      return { [SIGNALS.BACKUP_AGE_HOURS]: ageHours };
    });
  }

  return { signals, failures };
}
