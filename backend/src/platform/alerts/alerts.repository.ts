import { sql } from 'drizzle-orm';
// `@/` and not `../db/index`: widening the sanctioned-repository glob to
// `src/platform/**` also brings the module-escape rule with it, and that rule
// wants the alias. Its message says "from inside a module", which this is not —
// the alias is correct either way, so the rule is obeyed rather than argued with.
import type { DbHandle } from '@/platform/db/index';
import { SIGNALS } from './alert-rules';

/**
 * platform/alerts — THE ONLY FILE HERE THAT TOUCHES THE DATABASE.
 *
 * ===========================================================================
 * WHY IT EXISTS AS A SEPARATE FILE AT ALL.
 *
 * These queries used to live inline in `alert-sources.ts`, which was legal
 * while that file sat under `scripts/` — the "database access lives in a
 * *.repository.ts file" rule is scoped to `src/**`. Lifting alerting into
 * `src/platform/` so the API could run a dry run brought it inside the rule,
 * and the rule refused it. Correctly.
 *
 * THE EXEMPTION THAT WAS NOT TAKEN. `eslint.config.js` carries a D-181 block
 * naming the three directories that violate this rule and cannot comply yet,
 * and that block ends with the sentence "Deleting these three directories from
 * this list is the follow-up; adding a fourth is not." Adding `platform/alerts`
 * to it would have been a one-line change and exactly the thing that comment
 * exists to prevent. So the SQL moved into a file named for what it is instead,
 * and the sanctioned-repository glob widened from `src/modules/**` to include
 * `src/platform/**` — which leaves the boundary meaning precisely what it says:
 * SQL lives in a `.repository.ts`, everywhere, with no exceptions.
 *
 * ---------------------------------------------------------------------------
 * NOTHING ELSE ABOUT THE COLLECTION MOVED. The window arithmetic, the disjoint
 * sums, the metric-name duplication and every comment explaining them stayed in
 * `alert-sources.ts`, because they are collection policy rather than storage.
 * What is here is the three reads and nothing else.
 * ===========================================================================
 */

/**
 * `now()` AS POSTGRES SEES IT.
 *
 * The heartbeat age is a subtraction, and doing it against the process clock
 * would make the answer depend on how far the API host has drifted from the
 * database host. One connection, one clock.
 *
 * D-305's lesson applies at this boundary: `db.execute` hands back WIRE TEXT
 * for a `timestamptz` unless a type parser says otherwise, so the caller must
 * not assume a `Date` — hence the union, converted at the one place that knows.
 */
export async function readDatabaseNow(db: DbHandle): Promise<Date> {
  const result = await db.db.execute<{ now: Date | string }>(sql`select now() as now`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('select now() returned no row');
  return row.now instanceof Date ? row.now : new Date(row.now);
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
export async function collectMetricCounts(
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
export async function collectPoolSaturation(db: DbHandle): Promise<number> {
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

