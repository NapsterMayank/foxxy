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
// D-333 — the ONE per-worker liveness read. This file used to carry a second
// copy of it. See `collectWorkerHeartbeatAge`.
import { readWorkerLiveness } from '../../src/platform/jobs/index';
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
    SIGNALS.NOTIFY_UNDELIVERABLE,
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
  /**
   * The fast-failure counter — the one that makes an ordinary outage visible.
   *
   * The three above are all emitted by the GUARD refusing or abandoning a call.
   * A dependency that REJECTS — connection refused, DNS failure, provider 500 —
   * emits none of them and, until this existed, produced no row at all. An audit
   * drove the real wiring with a dead embedding provider and a dead payments
   * host and read `metrics_events` back empty both times.
   *
   * Disjoint from the other three by construction (`createPortFailureBridge`
   * declines to emit for a timeout or either rejection), which is what makes the
   * four safe to add together below.
   */
  PORT_CALL_FAILED: 'platform.port.call_failed',
  JOB_DEAD: 'platform.job.dead',
  NOTIFY_FAILED: 'platform.notify.failed',
  /** D-146 — per NOTIFICATION, not per channel. See `SIGNALS.NOTIFY_UNDELIVERABLE`. */
  NOTIFY_UNDELIVERABLE: 'platform.notify.undeliverable',
  /**
   * THE RATE-LIMIT FALLBACK IS EMITTED UNDER MORE THAN ONE NAME, AND ONLY ONE OF
   * THEM WAS BEING COLLECTED.
   *
   * `platform/rate-limit` takes the metric name from its constructor, so each
   * limiter namespaces its own. `identity` was here; `app`'s authenticated
   * throttle — built in `src/app/server.ts` — was not. Under a cache outage the
   * audit observed six activations of the app one and zero of them reached the
   * `rate_limit_fallback` page, because the collector was not looking at that
   * name. D-034's whole point is that a silent security downgrade is found out;
   * collecting one of the two limiters that can degrade is finding out half the
   * time.
   *
   * `billing.webhook_rate_limit.in_process_fallback` is deliberately NOT summed
   * in. It is a webhook throttle, not an authentication control, and folding it
   * into a page whose body says "authentication rate limits are weaker" would
   * make the alert text false on every billing occurrence. It needs its own rule
   * if it needs one — see the report accompanying this change.
   */
  RATE_LIMIT_FALLBACK_IDENTITY: 'identity.rate_limit.in_process_fallback',
  RATE_LIMIT_FALLBACK_APP: 'app.authenticated_rate_limit.in_process_fallback',
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
    // BOTH limiters. See the METRIC comment — collecting only `identity` meant
    // the app-level authenticated throttle degraded silently.
    [SIGNALS.RATE_LIMIT_FALLBACK]:
      total(METRIC.RATE_LIMIT_FALLBACK_IDENTITY) + total(METRIC.RATE_LIMIT_FALLBACK_APP),
    [SIGNALS.JOB_DEAD_LETTERED]: total(METRIC.JOB_DEAD),
    [SIGNALS.NOTIFY_FAILED]: total(METRIC.NOTIFY_FAILED),
    [SIGNALS.NOTIFY_UNDELIVERABLE]: total(METRIC.NOTIFY_UNDELIVERABLE),
    // FOUR summands, not three. The fourth is the one that moves during an
    // ordinary outage: a dependency that fails fast emits none of the other
    // three. They are disjoint by construction, so this is a sum and not a
    // double count.
    [SIGNALS.DEPENDENCY_ERRORS]:
      total(METRIC.PORT_TIMEOUT) +
      total(METRIC.BREAKER_REJECTED) +
      total(METRIC.CONCURRENCY_REJECTED) +
      total(METRIC.PORT_CALL_FAILED),
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

/**
 * §3.2 — the worker's liveness is a ROW, because it has no HTTP surface.
 *
 * =============================================================================
 * PER WORKER, OLDEST LIVE ONE, `status <> 'stopped'`. All three words matter,
 * and the previous query had none of them.
 *
 * It was:
 *
 *     select extract(epoch from (now() - max(last_beat_at))) from worker_heartbeats
 *
 * `max()` across every row, with no status filter. Two things follow, and both
 * were reproduced against a real database rather than argued:
 *
 *  1. TWO ROWS, ONE 3600s STALE (`status='running'`) AND ONE FRESH → the
 *     evaluator reported an age of **0.01s** and did not page. `max()` takes the
 *     NEWEST beat, so one healthy replica hides any number of dead ones. That is
 *     precisely the failure `heartbeat.ts` designed per-process rows to expose:
 *     its header says a single shared row "would make two healthy workers
 *     indistinguishable from one healthy worker and one that died an hour ago",
 *     and then the reader aggregated the rows back into exactly that.
 *
 *  2. ONE CLEANLY STOPPED WORKER AND NOTHING ELSE RUNNING → age ~0s, and
 *     `count(*) where status <> 'stopped'` = **0**. Every job in the product is
 *     stopped — digests, retention nudges, the session sweeper — and the page
 *     stays quiet, because a `stopped` row keeps its `last_beat_at` fresh
 *     forever. The alert was reading a tombstone as a pulse.
 *
 * So: filter the tombstones out, then take `min(last_beat_at)` — the OLDEST live
 * worker — because the question the page answers is "is ANY worker dead", not
 * "is the fleet dead". `max()` answers the second and nobody asked it.
 *
 * =============================================================================
 * ZERO LIVE WORKERS IS THE LOUDEST CASE, NOT THE QUIETEST.
 *
 * With no live rows there is no age to compute, and the old code's shape would
 * make that "unmeasurable". It is reported as an effectively infinite age
 * instead, for the same reason `collectSignals` treats a missing backup as
 * infinite rather than absent: a worker that has never started, a worker that
 * died, and a worker that was cleanly stopped and never replaced are the same
 * outage from a user's point of view. Treating the never-started case as
 * unmeasurable means the alert never fires on the deployment where the worker
 * was simply forgotten — the one deployment where it is needed most.
 *
 * =============================================================================
 * =============================================================================
 * IT NOW READS THROUGH `readWorkerLiveness` — D-333. ONE QUERY, NOT TWO COPIES.
 *
 * The previous version carried a SECOND copy of the same per-worker,
 * `status <> 'stopped'` query, with a comment saying `platform/jobs` already had
 * one and could not be reused because it threw. It threw for a known reason —
 * it declared `last_beat_at` as `Date` and the driver hands back wire text for a
 * `timestamptz` (D-305) — and that has been repaired, leaving a correct function
 * with ZERO CALLERS beside a duplicate of it that had all the callers.
 *
 * Two copies of a liveness query is exactly the setup that produced the defects
 * above: the reader and the writer disagreeing about what a row means, with
 * nothing to force them back into agreement. Now there is one implementation,
 * and the integration test that drives it against a real database
 * (`worker-shutdown.test.ts`) covers this collector's row decoding too.
 *
 * =============================================================================
 * THE DATABASE'S CLOCK, NOT THE EVALUATOR'S — and this is why `now` is READ
 * rather than taken from `options.now`.
 *
 * `readWorkerLiveness` takes the reference instant from its caller, which is
 * what makes it testable. But the age this signal reports must be measured
 * against the same clock the row was timestamped by. Handing it the evaluator
 * container's wall clock would turn a few seconds of NTP skew between two
 * containers into a "worker heartbeat stale" page, or — worse in the other
 * direction — into an age permanently below the threshold on a fleet whose
 * workers are all dead. The old query got this right implicitly by doing the
 * subtraction inside Postgres; doing it in TypeScript makes the choice of clock
 * explicit, so it is read from the database in the same connection.
 *
 * `staleAfterMs` is the shipped `worker_heartbeat_stale` threshold, so the
 * `stale` flag on each row means what the page means. This function consumes
 * only `lastBeatAt` — the comparison belongs to `evaluate()`, which owns the
 * threshold — but passing a number that disagreed with the rule would leave a
 * misleading boolean lying around for the next reader.
 */
const WORKER_HEARTBEAT_STALE_AFTER_MS = 300_000;

async function collectWorkerHeartbeatAge(db: DbHandle): Promise<number> {
  const clockResult = await db.db.execute<{ now: Date | string }>(sql`select now() as now`);
  const clockRow = clockResult.rows[0];
  if (clockRow === undefined) throw new Error('select now() returned no row');
  // D-305's lesson, applied at this boundary too: `db.execute` returns WIRE TEXT
  // for a `timestamptz` unless a type parser says otherwise, so a bare
  // `.getTime()` here would be the same TypeError in a different file.
  const now = clockRow.now instanceof Date ? clockRow.now : new Date(clockRow.now);

  const workers = await readWorkerLiveness(db, now, WORKER_HEARTBEAT_STALE_AFTER_MS);

  // Zero live rows is the LOUDEST case, not the quietest — see above. A worker
  // that never started, one that died, and one that was cleanly stopped and
  // never replaced are the same outage to a user.
  if (workers.length === 0) return Number.MAX_SAFE_INTEGER;

  // The OLDEST live worker, because the question the page answers is "is ANY
  // worker dead", not "is the fleet dead". `readWorkerLiveness` orders by
  // `last_beat_at desc`, but the minimum is taken explicitly rather than by
  // indexing the last element: an ordering this depends on must not be a
  // property some future caller of that function is free to change.
  const oldestBeatMs = workers.reduce(
    (oldest, worker) => Math.min(oldest, worker.lastBeatAt.getTime()),
    Number.POSITIVE_INFINITY,
  );

  return (now.getTime() - oldestBeatMs) / 1_000;
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
