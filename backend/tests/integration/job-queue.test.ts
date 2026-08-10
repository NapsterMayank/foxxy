import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@/platform/clock/index';
import { createDb, type DbHandle } from '@/platform/db/index';
import { JOB_BACKOFF_POLICY, createPostgresJobQueue, type JobQueue } from '@/platform/jobs/index';
import { backoffMs } from '@/platform/retry/index';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../helpers/postgres';

/**
 * The job queue, against a REAL Postgres — 04-RESILIENCE-PLAN.md §3.2.
 *
 * A real database, non-negotiably (plan §9.1). The two properties that matter
 * most here — `FOR UPDATE SKIP LOCKED` claiming and a UNIQUE index deduplicating
 * concurrent enqueues — are properties OF POSTGRES. A fake queue would pass
 * every one of these tests while proving nothing at all about the SQL, which is
 * the only place either property lives.
 *
 * Every deadline is evaluated against an injected `FixedClock` that is passed
 * INTO the queue methods. There is no `now()` anywhere in the queue's SQL, and
 * nothing in this file sleeps.
 */

let postgres: TestPostgres;
let handle: DbHandle;
let queue: JobQueue;
let clock: FixedClock;

const KIND = 'test.job';
const OTHER_KIND = 'test.other';

beforeAll(async () => {
  postgres = await startTestPostgres();
  await applyAllMigrations(postgres.client);
  handle = createDb({ url: postgres.url, poolMax: 8, ssl: false });
}, 180_000);

afterAll(async () => {
  await handle.close();
  await postgres.stop();
}, 60_000);

beforeEach(async () => {
  await postgres.client.query('truncate table jobs');
  clock = new FixedClock('2026-08-09T09:00:00.000Z');
  // `random` fixed at 0, so the jittered backoff collapses to its LOWER BOUND
  // and the delay sequence is exactly assertable. Equal jitter means that bound
  // is half the exponential delay — asserting the exact value is what makes
  // "with backoff" a measurement rather than a hope.
  queue = createPostgresJobQueue({ db: handle, random: () => 0 });
});

async function statusOf(id: string): Promise<{ status: string; run_at: Date; attempts: number }> {
  const result = await postgres.client.query<{ status: string; run_at: Date; attempts: number }>(
    'select status, run_at, attempts from jobs where id = $1',
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no job ${id}`);
  return row;
}

describe('a job runs exactly once under concurrent workers', () => {
  it('gives one job to exactly one of ten workers claiming simultaneously', async () => {
    // THE test for §3.2's multi-consumer safety. Without `FOR UPDATE`, ten
    // workers read the same `pending` row and all ten update it — the classic
    // lost-update race, which here means one email sent ten times. Without
    // `SKIP LOCKED` they serialise behind the first, and ten workers process
    // exactly as fast as one.
    const { id } = await queue.enqueue({ kind: KIND, idempotencyKey: 'only-one' });

    const claims = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        queue.claim(`worker-${String(index)}`, [KIND], clock.now()),
      ),
    );

    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.id).toBe(id);

    // And it is genuinely locked, not merely un-returned.
    const locked = await postgres.client.query<{ status: string; locked_by: string }>(
      'select status, locked_by from jobs where id = $1',
      [id],
    );
    expect(locked.rows[0]?.status).toBe('running');
    expect(locked.rows[0]?.locked_by).toMatch(/^worker-\d$/);
  });

  it('spreads five jobs across five concurrent workers with no duplicates', async () => {
    // The other half of `SKIP LOCKED`: concurrent workers must not block each
    // other. If they serialised, this would still pass with the same five ids —
    // so the assertion that matters is that every worker got one.
    for (let i = 0; i < 5; i += 1) {
      await queue.enqueue({ kind: KIND, idempotencyKey: `job-${String(i)}` });
    }

    const claims = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        queue.claim(`worker-${String(index)}`, [KIND], clock.now()),
      ),
    );

    const ids = claims.map((claim) => claim?.id).filter((id): id is string => id !== undefined);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('deduplicates two concurrent enqueues of the same work into ONE row', async () => {
    // The other half of "exactly once": the enqueue side. Two API instances
    // reacting to the same event, or one retried request, must not produce two
    // jobs. `(kind, idempotency_key)` is UNIQUE, so Postgres decides — not a
    // check-then-insert that both callers can pass.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        queue.enqueue({ kind: KIND, idempotencyKey: 'digest:parent-1:2026-W32' }),
      ),
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);

    const count = await postgres.client.query<{ count: string }>('select count(*)::text from jobs');
    expect(count.rows[0]?.count).toBe('1');
  });

  it('does not reset a backing-off job when the same work is enqueued again', async () => {
    // ON CONFLICT DO NOTHING, never DO UPDATE. A duplicated cron tick must not
    // drag a job that has already failed three times back to the front of the
    // queue — the backoff would then never take effect and the failing job
    // would hammer the dependency it is backing off from.
    const { id } = await queue.enqueue({ kind: KIND, idempotencyKey: 'k' });
    await queue.claim('w', [KIND], clock.now());
    await queue.fail(id, 'provider down', clock.now());
    const backedOff = await statusOf(id);

    await queue.enqueue({ kind: KIND, idempotencyKey: 'k' });

    const after = await statusOf(id);
    expect(after.run_at.getTime()).toBe(backedOff.run_at.getTime());
    expect(after.attempts).toBe(1);
    expect(after.status).toBe('failed');
  });

  it('lets the SAME key be reused under a DIFFERENT kind', async () => {
    // The uniqueness is per kind. "parent-1, week 32" is one digest and one
    // reminder, not one job.
    const first = await queue.enqueue({ kind: KIND, idempotencyKey: 'shared' });
    const second = await queue.enqueue({ kind: OTHER_KIND, idempotencyKey: 'shared' });
    expect(first.id).not.toBe(second.id);
    expect(second.created).toBe(true);
  });
});

describe('a failed job retries with backoff', () => {
  it('pushes run_at forward by the exponential, jittered delay', async () => {
    // §4: "retries use exponential backoff with jitter. Synchronised retries
    // are a self-inflicted denial of service." A queue is where a herd is most
    // likely, because everything that failed against one dependency failed at
    // the same instant.
    //
    // With `random` fixed at 0 the equal-jitter delay is its lower bound —
    // half the exponential — so the sequence is exact rather than a range.
    const { id } = await queue.enqueue({ kind: KIND, idempotencyKey: 'retrying' });

    const observed: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claimed = await queue.claim('w', [KIND], clock.now());
      expect(claimed).not.toBeNull();
      const outcome = await queue.fail(id, 'provider down', clock.now());
      expect(outcome).toBe('retry');

      const row = await statusOf(id);
      observed.push(row.run_at.getTime() - clock.now().getTime());

      // Move past the backoff so the next claim succeeds. No sleeping.
      clock.advanceMs(observed[attempt] ?? 0);
    }

    const expected = [0, 1, 2].map((attempt) =>
      Math.round(backoffMs(attempt, JOB_BACKOFF_POLICY) * (1 - JOB_BACKOFF_POLICY.jitterRatio)),
    );
    // 15 s, 30 s, 60 s — half of 30 s, 60 s, 120 s. Far enough apart for a blip
    // to have passed, because nobody is waiting on a background job.
    expect(observed).toEqual(expected);
    expect(expected[0]).toBe(15_000);
  });

  it('refuses to hand the job back before its backoff has elapsed', async () => {
    // The backoff has to be enforced by the CLAIM, not merely recorded. A
    // `run_at` nobody checks is a comment.
    const { id } = await queue.enqueue({ kind: KIND, idempotencyKey: 'waiting' });
    await queue.claim('w', [KIND], clock.now());
    await queue.fail(id, 'boom', clock.now());

    expect(await queue.claim('w', [KIND], clock.now())).toBeNull();

    clock.advanceMs(15_000);
    const reclaimed = await queue.claim('w', [KIND], clock.now());
    expect(reclaimed?.id).toBe(id);
    // Claimed twice now, and `attempts` counts CLAIMS.
    expect(reclaimed?.attempts).toBe(2);
  });

  it('becomes DEAD at maxAttempts and the row is KEPT', async () => {
    // A `dead` row is the record that work gave up. Deleting it would make a
    // job that failed indistinguishable from one that was never enqueued, which
    // is the silent failure the status exists to prevent.
    const { id } = await queue.enqueue({
      kind: KIND,
      idempotencyKey: 'doomed',
      maxAttempts: 2,
    });

    await queue.claim('w', [KIND], clock.now());
    expect(await queue.fail(id, 'nope', clock.now())).toBe('retry');
    clock.advanceMs(60_000);
    await queue.claim('w', [KIND], clock.now());
    expect(await queue.fail(id, 'nope again', clock.now())).toBe('dead');

    const row = await statusOf(id);
    expect(row.status).toBe('dead');
    // Terminal: never claimed again, however long anyone waits.
    clock.advanceMs(86_400_000);
    expect(await queue.claim('w', [KIND], clock.now())).toBeNull();
  });

  it('stores the failure MESSAGE and nothing larger', async () => {
    // `last_error` is read during incidents. A stack trace or a payload dump
    // here is how PII accumulates in the one column everybody greps.
    const { id } = await queue.enqueue({ kind: KIND, idempotencyKey: 'msg' });
    await queue.claim('w', [KIND], clock.now());
    await queue.fail(id, 'x'.repeat(5_000), clock.now());

    const row = await postgres.client.query<{ last_error: string }>(
      'select last_error from jobs where id = $1',
      [id],
    );
    expect(row.rows[0]?.last_error).toHaveLength(1_000);
  });
});

describe('the stuck-job reaper', () => {
  it('returns a job whose worker died to the queue', async () => {
    // THE at-least-once edge. A worker killed mid-job leaves the row `running`
    // forever; without a reaper that job never runs again and nothing says so.
    const { id } = await queue.enqueue({ kind: KIND, idempotencyKey: 'stranded' });
    await queue.claim('dead-worker', [KIND], clock.now());

    // Not yet stale.
    expect(await queue.reapStuck(120_000, clock.now())).toBe(0);

    clock.advanceMs(120_001);
    expect(await queue.reapStuck(120_000, clock.now())).toBe(1);

    const row = await statusOf(id);
    // PENDING, not FAILED. A reaped job did not fail — nobody knows whether it
    // ran at all — so it is retried immediately rather than being put through
    // a backoff it did not earn.
    expect(row.status).toBe('pending');
    expect(await queue.claim('live-worker', [KIND], clock.now())).not.toBeNull();
  });

  it('kills a job that has repeatedly taken its worker down with it', async () => {
    // `attempts` advances on CLAIM, not on failure, precisely so that a poison
    // job which kills its worker still reaches `dead` instead of looping until
    // somebody notices.
    const { id } = await queue.enqueue({
      kind: KIND,
      idempotencyKey: 'poison',
      maxAttempts: 1,
    });
    await queue.claim('doomed-worker', [KIND], clock.now());
    clock.advanceMs(120_001);

    await queue.reapStuck(120_000, clock.now());
    expect((await statusOf(id)).status).toBe('dead');
  });

  it('leaves a healthy in-flight job alone', async () => {
    const { id } = await queue.enqueue({ kind: KIND, idempotencyKey: 'busy' });
    await queue.claim('w', [KIND], clock.now());
    clock.advanceMs(60_000);

    expect(await queue.reapStuck(120_000, clock.now())).toBe(0);
    expect((await statusOf(id)).status).toBe('running');
  });
});

describe('claiming', () => {
  it('claims only the kinds the worker can actually run', async () => {
    // A worker that claimed an unknown kind would fail it repeatedly until it
    // was dead — deleting work it simply was not deployed to do.
    await queue.enqueue({ kind: OTHER_KIND, idempotencyKey: 'not-mine' });
    expect(await queue.claim('w', [KIND], clock.now())).toBeNull();
    expect(await queue.claim('w', [OTHER_KIND], clock.now())).not.toBeNull();
  });

  it('returns null for a worker that knows no kinds at all', async () => {
    await queue.enqueue({ kind: KIND, idempotencyKey: 'x' });
    expect(await queue.claim('w', [], clock.now())).toBeNull();
  });

  it('claims the oldest claimable job first', async () => {
    const later = await queue.enqueue({
      kind: KIND,
      idempotencyKey: 'later',
      runAt: new Date('2026-08-09T10:00:00.000Z'),
    });
    const sooner = await queue.enqueue({
      kind: KIND,
      idempotencyKey: 'sooner',
      runAt: new Date('2026-08-09T08:00:00.000Z'),
    });

    const first = await queue.claim('w', [KIND], new Date('2026-08-09T11:00:00.000Z'));
    expect(first?.id).toBe(sooner.id);
    const second = await queue.claim('w', [KIND], new Date('2026-08-09T11:00:00.000Z'));
    expect(second?.id).toBe(later.id);
  });

  it('does not claim a job scheduled for the future', async () => {
    await queue.enqueue({
      kind: KIND,
      idempotencyKey: 'tomorrow',
      runAt: new Date('2026-08-10T09:00:00.000Z'),
    });
    expect(await queue.claim('w', [KIND], clock.now())).toBeNull();
  });
});

describe('countByStatus', () => {
  it('reports every status, including the ones with no rows', async () => {
    // A missing key and a zero are different things to a dashboard, and only
    // one of them renders.
    const { id } = await queue.enqueue({ kind: KIND, idempotencyKey: 'a' });
    await queue.enqueue({ kind: KIND, idempotencyKey: 'b' });
    await queue.claim('w', [KIND], clock.now());
    await queue.succeed(id, clock.now());

    expect(await queue.countByStatus()).toEqual({
      pending: 1,
      running: 0,
      succeeded: 1,
      failed: 0,
      dead: 0,
    });
  });
});
