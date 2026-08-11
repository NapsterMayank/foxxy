import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@/platform/clock/index';
import { createDb, type DbHandle } from '@/platform/db/index';
import {
  JOB_BACKOFF_POLICY,
  createPostgresJobQueue,
  type ClaimedJob,
  type JobQueue,
} from '@/platform/jobs/index';
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

/**
 * Claims and INSISTS on getting something — D-233.
 *
 * `succeed` and `fail` take the `ClaimedJob` rather than an id now, because the
 * lease is what fences the write. Most tests here previously discarded the claim
 * result; this keeps them one line long while making the lease impossible to
 * skip.
 */
async function claimOne(worker = 'w', kind: string = KIND): Promise<ClaimedJob> {
  const claimed = await queue.claim(worker, [kind], clock.now());
  if (claimed === null) throw new Error(`nothing claimable for ${worker}`);
  return claimed;
}

/** The lease columns, for the reaper-race tests. */
async function lockOf(id: string): Promise<{ status: string; locked_by: string | null }> {
  const result = await postgres.client.query<{ status: string; locked_by: string | null }>(
    'select status, locked_by from jobs where id = $1',
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no job ${id}`);
  return row;
}

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
    await queue.fail(await claimOne(), 'provider down', clock.now());
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
      const claimed = await claimOne();
      const outcome = await queue.fail(claimed, 'provider down', clock.now());
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
    await queue.fail(await claimOne(), 'boom', clock.now());

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

    expect(await queue.fail(await claimOne(), 'nope', clock.now())).toBe('retry');
    clock.advanceMs(60_000);
    expect(await queue.fail(await claimOne(), 'nope again', clock.now())).toBe('dead');

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
    await queue.fail(await claimOne(), 'x'.repeat(5_000), clock.now());

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

  /**
   * =========================================================================
   * D-267 — EVERY TIMESTAMP ON A CLAIMED JOB IS A REAL `Date`.
   *
   * `ClaimedJob` declares `runAt`, `createdAt` and `lockedAt` as `Date`, and
   * for two of the three that was a promise the queue was not keeping.
   * `db.execute` runs raw SQL through node-postgres and what comes back for a
   * `timestamptz` is decided by the driver's type parsers, not by the
   * annotation in `JobRow`. D-233 typed `locked_at` honestly and left the
   * other two as `Date` on the grounds that "nothing ever calls a method on
   * them" — an explanation of why it had not blown up yet, not a guarantee.
   *
   * `lockedAt` was found exactly this way: the first run of this suite threw
   * `job.lockedAt.toISOString is not a function`. The first caller to write
   * `job.runAt.getTime()` — a scheduler, a lateness metric, a log line — would
   * have got the same `TypeError` in a worker, past a compiler that had
   * already signed off on it.
   *
   * ONLY AN INTEGRATION TEST CAN ASSERT THIS. A unit test with a fake row
   * supplies whatever type it declares and proves nothing about the driver.
   * This runs against real Postgres through the real `db.execute`, so it
   * observes what node-postgres actually returns — and `instanceof Date` is a
   * runtime check, which is the only kind that can catch the compiler lying.
   * =========================================================================
   */
  it('hands out real Date objects for runAt, createdAt AND lockedAt', async () => {
    await queue.enqueue({
      kind: KIND,
      idempotencyKey: 'timestamps',
      runAt: new Date('2026-08-09T08:00:00.000Z'),
    });

    const job = await queue.claim('w', [KIND], new Date('2026-08-09T11:00:00.000Z'));
    if (job === null) throw new Error('expected to claim the job');

    expect(job.runAt).toBeInstanceOf(Date);
    expect(job.createdAt).toBeInstanceOf(Date);
    expect(job.lockedAt).toBeInstanceOf(Date);

    // Not merely `instanceof` — a `new Date(undefined)` is also a Date, and an
    // Invalid Date would satisfy the checks above while carrying no time.
    expect(Number.isNaN(job.runAt.getTime())).toBe(false);
    expect(Number.isNaN(job.createdAt.getTime())).toBe(false);
    expect(Number.isNaN(job.lockedAt.getTime())).toBe(false);

    // The value survived the round trip, so the normalisation converts rather
    // than merely producing something Date-shaped.
    expect(job.runAt.toISOString()).toBe('2026-08-09T08:00:00.000Z');

    // The method call the type system has been promising all along. This is the
    // line that would have thrown.
    expect(() => job.createdAt.toISOString()).not.toThrow();
  });
});

describe('countByStatus', () => {
  it('reports every status, including the ones with no rows', async () => {
    // A missing key and a zero are different things to a dashboard, and only
    // one of them renders.
    await queue.enqueue({ kind: KIND, idempotencyKey: 'a' });
    await queue.enqueue({ kind: KIND, idempotencyKey: 'b' });
    await queue.succeed(await claimOne(), clock.now());

    expect(await queue.countByStatus()).toEqual({
      pending: 1,
      running: 0,
      succeeded: 1,
      failed: 0,
      dead: 0,
    });
  });
});

/**
 * =============================================================================
 * THE REAPER RACE — D-233. The defect this file did not previously reach.
 *
 * `succeed` and `fail` used to update BY JOB ID ALONE, and `fail` additionally
 * did a SELECT and then an UPDATE despite a comment directly above it promising
 * a single statement with a `CASE` precisely because "a read-modify-write here
 * races with the reaper".
 *
 * The race is not exotic. A handler that legitimately outruns the 120-second
 * lock timeout — a large digest, a slow provider — is reclaimed by
 * `reapStuck`, a second worker claims the row, and now two workers are running
 * the same job. Both finish. Unfenced, whichever finishes LAST wins, so:
 *
 *   - a stale `succeed` overwrites the new owner's `running`, whose later
 *     `fail` then marks a genuinely successful job `failed` and schedules a
 *     third run; or
 *   - a stale `fail` overwrites a genuine `succeeded`.
 *
 * At-least-once execution is an accepted, documented property of this queue.
 * A FINAL STATE THAT IS WRONG is not, and handler idempotency cannot fix it,
 * because the damage is in the queue's own bookkeeping.
 *
 * Every step below moves the injected clock. Nothing sleeps.
 * =============================================================================
 */
describe('a completion is fenced by the lease the caller still holds', () => {
  /** Drives a job to the exact state the race needs: claimed, reaped, reclaimed. */
  async function reclaimedUnderneath(): Promise<{
    readonly stale: ClaimedJob;
    readonly fresh: ClaimedJob;
  }> {
    await queue.enqueue({ kind: KIND, idempotencyKey: 'slow-handler' });

    // Worker A claims it and starts a handler that will take too long.
    const stale = await claimOne('worker-a');

    // Past the lock timeout, so the reaper returns the row to the queue. This
    // is the runner's own `DEFAULT_LOCK_TIMEOUT_MS`.
    clock.advanceMs(120_001);
    expect(await queue.reapStuck(120_000, clock.now())).toBe(1);

    // Worker B claims it. Worker A is still running.
    const fresh = await claimOne('worker-b');
    expect(fresh.id).toBe(stale.id);
    expect(fresh.lockedBy).toBe('worker-b');

    return { stale, fresh };
  }

  it('refuses a stale succeed, leaving the new owner running', async () => {
    const { stale, fresh } = await reclaimedUnderneath();

    // Worker A finishes and reports success on a job it no longer owns.
    expect(await queue.succeed(stale, clock.now())).toBe(false);

    // The row still belongs to worker B, untouched.
    const row = await lockOf(fresh.id);
    expect(row.status).toBe('running');
    expect(row.locked_by).toBe('worker-b');
  });

  it('refuses a stale fail, so a succeeded job cannot be flipped back', async () => {
    // The direction that corrupts rather than merely confuses: without the
    // fence this `fail` lands on top of worker B's `succeeded` and the job is
    // scheduled to run for a third time, having already worked twice.
    const { stale, fresh } = await reclaimedUnderneath();

    expect(await queue.succeed(fresh, clock.now())).toBe(true);
    expect(await queue.fail(stale, 'timed out', clock.now())).toBe('lease_lost');

    const row = await statusOf(fresh.id);
    expect(row.status).toBe('succeeded');
    // Never rescheduled: a third run was exactly what the unfenced write caused.
    clock.advanceMs(86_400_000);
    expect(await queue.claim('w', [KIND], clock.now())).toBeNull();
  });

  it('lets the CURRENT owner complete normally — the fence is not a blanket refusal', async () => {
    // A fence that rejected everything would also pass the two tests above, and
    // would break the queue entirely. This is the control.
    const { fresh } = await reclaimedUnderneath();

    expect(await queue.succeed(fresh, clock.now())).toBe(true);
    expect((await statusOf(fresh.id)).status).toBe('succeeded');
  });

  it('refuses a second completion from the SAME worker', async () => {
    // `succeed` nulls the lock columns, so the lease is spent. A retried call —
    // from a runner that crashed between the database write and its own
    // bookkeeping — must not re-stamp a row that may have been claimed again.
    await queue.enqueue({ kind: KIND, idempotencyKey: 'double-report' });
    const claimed = await claimOne();

    expect(await queue.succeed(claimed, clock.now())).toBe(true);
    expect(await queue.succeed(claimed, clock.now())).toBe(false);
  });

  it('decides dead-versus-failed from the row, in ONE statement', async () => {
    // The `CASE` the old comment promised and the old code did not deliver.
    // Proved by the outcome tracking `max_attempts` as the DATABASE holds it:
    // the row is lowered to a single permitted attempt after the claim, so a
    // decision read from the pre-claim record would say 'retry' and a decision
    // taken in SQL says 'dead'.
    const { id } = await queue.enqueue({
      kind: KIND,
      idempotencyKey: 'case-in-sql',
      maxAttempts: 5,
    });
    const claimed = await claimOne();
    expect(claimed.maxAttempts).toBe(5);

    await postgres.client.query('update jobs set max_attempts = 1 where id = $1', [id]);

    expect(await queue.fail(claimed, 'exhausted', clock.now())).toBe('dead');
    expect((await statusOf(id)).status).toBe('dead');
  });
});
