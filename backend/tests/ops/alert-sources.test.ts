import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../../src/platform/db/index';
import { FakeLogger } from '../../src/platform/logger/index';
import { PLATFORM_METRICS } from '../../src/platform/metrics/index';
import { SIGNALS } from '../../scripts/ops/alert-rules';
import { collectSignals } from '../../scripts/ops/alert-sources';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../helpers/postgres';

/**
 * WHERE THE SIGNALS COME FROM, AGAINST A REAL POSTGRES.
 *
 * =============================================================================
 * A FAKE DATABASE WOULD PASS EVERY TEST BELOW WHILE PROVING NOTHING.
 *
 * Two of the three defects these tests pin live entirely inside SQL —
 * `max(last_beat_at)` over unfiltered rows, and a `name = any(...)` list missing
 * two entries. A hand-rolled fake returning canned rows re-implements the
 * developer's belief about what the query does, which is the belief that was
 * wrong. Plan §9.1: the database is never faked.
 *
 * Every collector is failure-isolated by design, so `readiness` pointing at a
 * dead port is expected and contributes its own signal without disturbing the
 * ones under test.
 */

let postgres: TestPostgres;
let handle: DbHandle;

const logger = new FakeLogger();
const NOW = new Date('2026-08-10T12:00:00.000Z');
/** Nothing listens here. `collectReadiness` treats a refusal as "failing", which is its job. */
const DEAD_READINESS_URL = 'http://127.0.0.1:1/health/ready';

beforeAll(async () => {
  postgres = await startTestPostgres();
  await applyAllMigrations(postgres.client);
  handle = createDb({ url: postgres.url, poolMax: 4, ssl: false });
}, 180_000);

afterAll(async () => {
  await handle.close();
  await postgres.stop();
});

beforeEach(async () => {
  await postgres.client.query('truncate table metrics_events');
  await postgres.client.query('truncate table worker_heartbeats');
});

async function collect(): Promise<Record<string, number>> {
  const { signals } = await collectSignals({
    db: handle,
    logger,
    windowMinutes: 15,
    readinessUrl: DEAD_READINESS_URL,
    backupDir: undefined,
    now: NOW,
  });
  return signals;
}

async function recordMetric(name: string, value = 1, tags: object = {}): Promise<void> {
  await postgres.client.query(
    `insert into metrics_events (name, kind, value, tags, recorded_at)
     values ($1, 'counter', $2, $3::jsonb, now())`,
    [name, value, JSON.stringify(tags)],
  );
}

async function recordHeartbeat(
  workerId: string,
  status: 'running' | 'draining' | 'stopped',
  secondsAgo: number,
): Promise<void> {
  await postgres.client.query(
    `insert into worker_heartbeats (worker_id, started_at, last_beat_at, jobs_processed, status)
     values ($1, now() - interval '1 day', now() - make_interval(secs => $2), 0, $3)`,
    [workerId, secondsAgo, status],
  );
}

/**
 * =============================================================================
 * DEFECT 2 — a dependency that fails FAST was invisible to every rule.
 *
 * `dependency.errors` summed three counters, all emitted by the guard refusing
 * or abandoning a call. A port call that REJECTS immediately — connection
 * refused, DNS failure, provider 500 — incremented none of them, and the breaker
 * says nothing until it transitions at five. An auditor drove the real wiring
 * with a dead embedding provider and a dead payments host and read
 * `metrics_events` back EMPTY both times.
 */
describe('dependency.errors sees a fast failure', () => {
  it('counts platform.port.call_failed — the shape that produced an empty table', async () => {
    // Exactly the audit's payments scenario: four checkouts fail against a
    // refused connection and the provider recovers. No timeout (it failed in
    // milliseconds), no breaker transition (four is below the threshold of
    // five), no concurrency rejection.
    for (let i = 0; i < 4; i += 1) {
      await recordMetric(PLATFORM_METRICS.PORT_CALL_FAILED, 1, { port: 'payments' });
    }

    const signals = await collect();
    expect(signals[SIGNALS.DEPENDENCY_ERRORS]).toBe(4);
  });

  it('adds the four sources rather than double counting any of them', async () => {
    await recordMetric(PLATFORM_METRICS.PORT_TIMEOUT, 3, { port: 'llm' });
    await recordMetric(PLATFORM_METRICS.BREAKER_REJECTED, 5, { port: 'llm' });
    await recordMetric(PLATFORM_METRICS.CONCURRENCY_REJECTED, 2, { port: 'llm' });
    await recordMetric(PLATFORM_METRICS.PORT_CALL_FAILED, 7, { port: 'llm' });

    const signals = await collect();
    expect(signals[SIGNALS.DEPENDENCY_ERRORS]).toBe(17);
  });

  it('is zero, not absent, when the window is quiet', async () => {
    // The distinction matters: `evaluate()` skips an ABSENT signal, so a
    // collector that omitted the key on a quiet window would also omit it during
    // an outage it failed to measure, and the two would be indistinguishable.
    const signals = await collect();
    expect(signals[SIGNALS.DEPENDENCY_ERRORS]).toBe(0);
  });
});

/**
 * =============================================================================
 * D-146 — "a notification reached nobody" reaches a rule.
 */
describe('notify.undeliverable is collected', () => {
  it('counts platform.notify.undeliverable', async () => {
    await recordMetric(PLATFORM_METRICS.NOTIFY_UNDELIVERABLE, 1, { kind: 'ops.alert.page' });
    await recordMetric(PLATFORM_METRICS.NOTIFY_UNDELIVERABLE, 1, { kind: 'parent.digest' });

    const signals = await collect();
    expect(signals[SIGNALS.NOTIFY_UNDELIVERABLE]).toBe(2);
  });

  it('is kept separate from the per-channel notify.failed counter', async () => {
    await recordMetric(PLATFORM_METRICS.NOTIFY_FAILED, 2, { channel: 'email' });
    await recordMetric(PLATFORM_METRICS.NOTIFY_UNDELIVERABLE, 1, { kind: 'parent.digest' });

    const signals = await collect();
    expect(signals[SIGNALS.NOTIFY_FAILED]).toBe(2);
    expect(signals[SIGNALS.NOTIFY_UNDELIVERABLE]).toBe(1);
  });
});

/**
 * =============================================================================
 * THE APP-LEVEL RATE-LIMIT FALLBACK, which fires and was not collected.
 *
 * D-034: "a silent fallback is a silent SECURITY DOWNGRADE — the whole point is
 * that somebody finds out." Under a cache outage the audit observed six
 * activations of `app.authenticated_rate_limit.in_process_fallback` and zero
 * pages, because the collector only looked at the `identity` name.
 */
describe('rate_limit.fallback sees both limiters', () => {
  it('counts the app-level authenticated throttle, which was not collected at all', async () => {
    await recordMetric('app.authenticated_rate_limit.in_process_fallback', 6);
    const signals = await collect();
    expect(signals[SIGNALS.RATE_LIMIT_FALLBACK]).toBe(6);
  });

  it('sums the identity limiter and the app throttle', async () => {
    await recordMetric('identity.rate_limit.in_process_fallback', 2);
    await recordMetric('app.authenticated_rate_limit.in_process_fallback', 3);
    const signals = await collect();
    expect(signals[SIGNALS.RATE_LIMIT_FALLBACK]).toBe(5);
  });

  it('does NOT fold in the billing webhook throttle, whose page text would be false', async () => {
    // The `rate_limit_fallback` body says authentication limits are weaker. A
    // billing webhook throttle degrading does not make that sentence true, so it
    // needs its own rule rather than a seat in this sum.
    await recordMetric('billing.webhook_rate_limit.in_process_fallback', 9);
    const signals = await collect();
    expect(signals[SIGNALS.RATE_LIMIT_FALLBACK]).toBe(0);
  });
});

/**
 * =============================================================================
 * DEFECT 3 — the heartbeat alert could not see a dead worker.
 *
 * The old query was `max(last_beat_at)` over every row with no status filter.
 * `heartbeat.ts` writes one row per process precisely so "a dead replica [is]
 * visible as a stale row", and the reader aggregated that back into the single
 * shared row the design was avoiding.
 */
describe('worker.heartbeat_age_seconds is evaluated per worker', () => {
  it('reports the OLDEST live worker, so one fresh replica cannot hide a corpse', async () => {
    // Reproduced from the audit: one replica dead for an hour, one healthy. The
    // old `max()` reported an age of 0.01s and did not page.
    await recordHeartbeat('host-a:1:1000', 'running', 3_600);
    await recordHeartbeat('host-b:2:2000', 'running', 1);

    const signals = await collect();
    const age = signals[SIGNALS.WORKER_HEARTBEAT_AGE_SECONDS] ?? 0;
    expect(age).toBeGreaterThanOrEqual(3_590);
    // And it is over the shipped `worker_heartbeat_stale` threshold, which is
    // the property that actually matters.
    expect(age).toBeGreaterThan(300);
  });

  it('a single healthy worker is still healthy — the fix does not page on everything', async () => {
    await recordHeartbeat('host-a:1:1000', 'running', 2);
    const signals = await collect();
    expect(signals[SIGNALS.WORKER_HEARTBEAT_AGE_SECONDS] ?? 0).toBeLessThan(300);
  });

  it('ignores a STOPPED row, which keeps a fresh timestamp forever', async () => {
    // The second audit case: one cleanly stopped worker, nothing else running.
    // Every job in the product is stopped and the old query reported ~0s.
    await recordHeartbeat('host-a:1:1000', 'stopped', 1);
    const signals = await collect();
    expect(signals[SIGNALS.WORKER_HEARTBEAT_AGE_SECONDS]).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('a stopped row does not mask a stale live one either', async () => {
    await recordHeartbeat('host-a:1:1000', 'stopped', 1);
    await recordHeartbeat('host-b:2:2000', 'running', 900);
    const signals = await collect();
    expect(signals[SIGNALS.WORKER_HEARTBEAT_AGE_SECONDS] ?? 0).toBeGreaterThan(300);
  });

  it('counts a DRAINING worker as live — it is still expected to beat', async () => {
    await recordHeartbeat('host-a:1:1000', 'draining', 4);
    const signals = await collect();
    expect(signals[SIGNALS.WORKER_HEARTBEAT_AGE_SECONDS] ?? 0).toBeLessThan(300);
  });

  it('no rows at all is an infinite age, not an unmeasurable one', async () => {
    // A worker that was never deployed and a worker that died are the same
    // outage from a user's point of view. Reporting "cannot measure" would mean
    // the alert never fires on the deployment where the worker was forgotten.
    const signals = await collect();
    expect(signals[SIGNALS.WORKER_HEARTBEAT_AGE_SECONDS]).toBe(Number.MAX_SAFE_INTEGER);
  });
});
