import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@/platform/clock/index';
import { createDb, type DbHandle } from '@/platform/db/index';
import { FakeLogger } from '@/platform/logger/index';
import { sweepExpiredSessions } from '@/worker/jobs/expired-session-sweeper';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../helpers/postgres';

/**
 * The expired-session sweeper — the worker's first real job.
 *
 * `PROGRESS.md` §7 listed it under "deliberately deferred, with the unblocking
 * condition: the worker process". The worker exists, so it is no longer
 * deferred.
 *
 * THE ASSERTION THAT MATTERS IS THE NEGATIVE ONE. A sweeper that deletes too
 * little is a slow-growing table. A sweeper that deletes too much LOGS EVERY
 * USER OUT — silently, with no error, and with no way to tell afterwards which
 * sessions were valid. So every test here has a live session sitting beside the
 * expired one, and checks that it survived.
 */

let postgres: TestPostgres;
let handle: DbHandle;
let clock: FixedClock;
let logger: FakeLogger;

const NOW = '2026-08-09T09:00:00.000Z';

beforeAll(async () => {
  postgres = await startTestPostgres();
  await applyAllMigrations(postgres.client);
  handle = createDb({ url: postgres.url, poolMax: 4, ssl: false });
}, 180_000);

afterAll(async () => {
  await handle.close();
  await postgres.stop();
}, 60_000);

beforeEach(async () => {
  await postgres.client.query('truncate table users cascade');
  clock = new FixedClock(NOW);
  logger = new FakeLogger();
});

async function makeUser(email: string): Promise<string> {
  const result = await postgres.client.query<{ id: string }>(
    `insert into users (email, password_hash, role) values ($1, 'x', 'student') returning id`,
    [email],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('no user id');
  return id;
}

/** One session with an explicit expiry. `tokenHash` doubles as its label. */
async function makeSession(userId: string, tokenHash: string, expiresAt: string): Promise<void> {
  await postgres.client.query(
    `insert into sessions (user_id, token_hash, expires_at) values ($1, $2, $3::timestamptz)`,
    [userId, tokenHash, expiresAt],
  );
}

async function survivingTokens(): Promise<string[]> {
  const result = await postgres.client.query<{ token_hash: string }>(
    'select token_hash from sessions order by token_hash',
  );
  return result.rows.map((row) => row.token_hash);
}

describe('the sweeper deletes only genuinely expired sessions', () => {
  it('removes the expired one and leaves the live one', async () => {
    const userId = await makeUser('sweep1@example.test');
    await makeSession(userId, 'expired-yesterday', '2026-08-08T09:00:00.000Z');
    await makeSession(userId, 'live-until-next-month', '2026-09-08T09:00:00.000Z');

    const deleted = await sweepExpiredSessions({ db: handle, clock, logger });

    expect(deleted).toBe(1);
    expect(await survivingTokens()).toEqual(['live-until-next-month']);
  });

  it('does NOT delete a session expiring at this exact instant', async () => {
    // `<`, not `<=`. `validateSession` uses the same boundary (`isExpired`), and
    // two components disagreeing by one instant on what "expired" means is the
    // kind of defect that reproduces once a month at a boundary nobody can hit
    // deliberately.
    const userId = await makeUser('sweep2@example.test');
    await makeSession(userId, 'expires-exactly-now', NOW);
    await makeSession(userId, 'expired-one-ms-ago', '2026-08-09T08:59:59.999Z');

    const deleted = await sweepExpiredSessions({ db: handle, clock, logger });

    expect(deleted).toBe(1);
    expect(await survivingTokens()).toEqual(['expires-exactly-now']);
  });

  it('sweeps nothing at all when every session is live', async () => {
    // The empty case, because a bug in the predicate would show up here as an
    // enormous number rather than as an error.
    const userId = await makeUser('sweep3@example.test');
    await makeSession(userId, 'a', '2026-08-10T09:00:00.000Z');
    await makeSession(userId, 'b', '2026-09-01T09:00:00.000Z');

    expect(await sweepExpiredSessions({ db: handle, clock, logger })).toBe(0);
    expect(await survivingTokens()).toEqual(['a', 'b']);
  });

  it('respects the INJECTED clock, not the database clock', async () => {
    // D-019, and the exact bug this codebase already shipped once: `last_used_at`
    // was written from the database clock while renewal compared the injected
    // one, which fails silently under any skew.
    //
    // Here it is directly observable — the session below has genuinely expired
    // by wall-clock time and must survive, because the sweeper's clock says it
    // has not.
    const userId = await makeUser('sweep4@example.test');
    await makeSession(userId, 'expired-in-real-life', '2026-01-01T00:00:00.000Z');

    const pastClock = new FixedClock('2025-12-01T00:00:00.000Z');
    expect(await sweepExpiredSessions({ db: handle, clock: pastClock, logger })).toBe(0);
    expect(await survivingTokens()).toEqual(['expired-in-real-life']);

    // And with the clock moved forward, the same row goes.
    expect(await sweepExpiredSessions({ db: handle, clock, logger })).toBe(1);
    expect(await survivingTokens()).toEqual([]);
  });

  it('touches sessions belonging to every user, not only one', async () => {
    const first = await makeUser('sweep5a@example.test');
    const second = await makeUser('sweep5b@example.test');
    await makeSession(first, 'first-expired', '2026-01-01T00:00:00.000Z');
    await makeSession(second, 'second-expired', '2026-01-01T00:00:00.000Z');
    await makeSession(second, 'second-live', '2026-12-01T00:00:00.000Z');

    expect(await sweepExpiredSessions({ db: handle, clock, logger })).toBe(2);
    expect(await survivingTokens()).toEqual(['second-live']);
  });
});

describe('the sweeper is idempotent', () => {
  it('deletes nothing on a second run', async () => {
    // Required of EVERY handler: at-least-once delivery means a worker can
    // complete the work and die before recording that it did. Running twice has
    // to be harmless, and for this job it is free — but "free" is worth
    // asserting rather than assuming.
    const userId = await makeUser('sweep6@example.test');
    await makeSession(userId, 'gone', '2026-01-01T00:00:00.000Z');
    await makeSession(userId, 'stays', '2026-12-01T00:00:00.000Z');

    expect(await sweepExpiredSessions({ db: handle, clock, logger })).toBe(1);
    expect(await sweepExpiredSessions({ db: handle, clock, logger })).toBe(0);
    expect(await survivingTokens()).toEqual(['stays']);
  });
});

describe('the sweeper batches, and logs counts only', () => {
  it('clears a backlog larger than one batch', async () => {
    // The first sweep after this ships could match a very large number of rows.
    // One unbounded DELETE would take row locks on all of them in a single
    // transaction — on the `worker` pool, but against the table LOGIN reads. The
    // pool bulkhead protects the connection count; it does not protect a table
    // from a lock taken on it.
    //
    // 1,050 rows is one full batch of 1,000 plus a remainder, which is what
    // proves the loop continues rather than stopping after the first pass.
    const userId = await makeUser('sweep7@example.test');
    const values: string[] = [];
    for (let i = 0; i < 1_050; i += 1) {
      values.push(`('${userId}', 'bulk-${String(i)}', '2026-01-01T00:00:00.000Z')`);
    }
    await postgres.client.query(
      `insert into sessions (user_id, token_hash, expires_at) values ${values.join(',')}`,
    );
    await makeSession(userId, 'survivor', '2026-12-01T00:00:00.000Z');

    expect(await sweepExpiredSessions({ db: handle, clock, logger })).toBe(1_050);
    expect(await survivingTokens()).toEqual(['survivor']);
  });

  it('logs a count and never an identifier', async () => {
    // This job's log line describes personal data. It must not BECOME personal
    // data: no user id, no token hash, no ip hash.
    const userId = await makeUser('sweep8@example.test');
    await makeSession(userId, 'secret-token-hash', '2026-01-01T00:00:00.000Z');

    await sweepExpiredSessions({ db: handle, clock, logger });

    const line = logger.lines.find((entry) => entry.obj.event === 'sweeper.completed');
    expect(line?.obj.deleted).toBe(1);
    const serialised = JSON.stringify(logger.lines);
    expect(serialised).not.toContain('secret-token-hash');
    expect(serialised).not.toContain(userId);
  });
});
