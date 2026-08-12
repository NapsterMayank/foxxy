import { describe, expect, it } from 'vitest';
import { FixedClock } from '@/platform/clock/index';
import { FakeLogger } from '@/platform/logger/index';
import type { JobRecord } from '@/platform/jobs/index';
import {
  NOTIFY_DELIVER_JOB,
  NOTIFY_DIGEST_DELIVER_JOB,
  NOTIFY_DIGEST_SCAN_JOB,
  type NotifyModule,
  type NotifyService,
} from '@/modules/notify/index';
import { buildNotifyHandlers } from '../notify-jobs';

/**
 * The worker's notify handlers.
 *
 * ===========================================================================
 * THE ASSERTION THIS FILE EXISTS FOR IS AN ABSENCE.
 *
 * PROGRESS.md §7 records the weekly digest as "deliberately NOT stubbed — a
 * registered handler that does nothing lets a job succeed without doing the
 * work, which is worse than the 'no handler' error the runner raises". That is
 * a decision about what is NOT registered, and an absence is exactly the kind
 * of property that gets reversed by accident: adding the two digest kinds
 * unconditionally is a one-line change that makes every test still pass and
 * turns "the digest never went out" into a green job run.
 *
 * So the gate is pinned here, in both directions.
 *
 * The handlers themselves are three lines around a service call, on purpose —
 * the work lives in `notify.service.ts` where it is tested against a real
 * database with no queue at all. What is tested here is the WIRING and the
 * payload boundary, which is the only logic these functions contain.
 */

const CLOCK = new FixedClock('2026-06-01T09:00:00.000Z');

interface Calls {
  readonly delivered: JobRecord[];
  readonly scans: number[];
  readonly digests: { parentUserId: string; weekStart: Date }[];
}

/**
 * A `NotifyModule` with only the parts these handlers touch.
 *
 * Cast once, here, rather than at each use: the handlers take the whole module
 * and reach for `service` and `hasDigestSource`, and a fake that implemented
 * the routing surface too would be testing Fastify rather than this file.
 */
function fakeModule(hasDigestSource: boolean): { module: NotifyModule; calls: Calls } {
  const calls: Calls = { delivered: [], scans: [], digests: [] };

  const service = {
    deliver(job: JobRecord) {
      calls.delivered.push(job);
      return Promise.resolve('delivered' as const);
    },
    scanWeeklyDigests() {
      calls.scans.push(calls.scans.length + 1);
      return Promise.resolve(0);
    },
    deliverWeeklyDigest(parentUserId: string, weekStart: Date) {
      calls.digests.push({ parentUserId, weekStart });
      return Promise.resolve(null);
    },
  } as unknown as NotifyService;

  return {
    calls,
    module: {
      service,
      hasDigestSource,
      registerRoutes: (): void => undefined,
    },
  };
}

function jobOf(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    kind: NOTIFY_DIGEST_DELIVER_JOB,
    idempotencyKey: 'k',
    payload: {},
    attempts: 1,
    maxAttempts: 5,
    runAt: CLOCK.now(),
    createdAt: CLOCK.now(),
    ...overrides,
  };
}

describe('the digest handlers are registered ONLY when the content seam is wired', () => {
  it('registers delivery alone when there is no DigestSource', () => {
    // Today's production posture. A stray digest job is refused by the runner
    // with "no handler registered" rather than succeeding without doing the
    // work — which is the loud failure §7 chose on purpose.
    const { module } = fakeModule(false);
    const handlers = buildNotifyHandlers(module, new FakeLogger());

    expect(Object.keys(handlers)).toEqual([NOTIFY_DELIVER_JOB]);
    expect(handlers[NOTIFY_DIGEST_SCAN_JOB]).toBeUndefined();
    expect(handlers[NOTIFY_DIGEST_DELIVER_JOB]).toBeUndefined();
  });

  it('registers all three once `parent` fills the seam', () => {
    const { module } = fakeModule(true);
    const handlers = buildNotifyHandlers(module, new FakeLogger());

    expect(Object.keys(handlers).sort()).toEqual(
      [NOTIFY_DELIVER_JOB, NOTIFY_DIGEST_DELIVER_JOB, NOTIFY_DIGEST_SCAN_JOB].sort(),
    );
  });
});

describe('the delivery handler', () => {
  it('hands the whole job to the service, attempts included', async () => {
    // `attempts` and `maxAttempts` are how the service knows an attempt is the
    // LAST one, which is the only moment it can write a dead-letter record. A
    // handler that passed only the payload would silently remove that.
    const { module, calls } = fakeModule(false);
    const handlers = buildNotifyHandlers(module, new FakeLogger());
    const job = jobOf({ kind: NOTIFY_DELIVER_JOB, attempts: 5, maxAttempts: 5 });

    await handlers[NOTIFY_DELIVER_JOB]?.(job);

    expect(calls.delivered).toEqual([job]);
  });
});

describe('the digest delivery handler validates its payload at the boundary', () => {
  it('parses a well-formed payload and calls the service once', async () => {
    const { module, calls } = fakeModule(true);
    const handlers = buildNotifyHandlers(module, new FakeLogger());

    await handlers[NOTIFY_DIGEST_DELIVER_JOB]?.(
      jobOf({ payload: { parentUserId: 'parent-1', weekStart: '2026-06-01T00:00:00.000Z' } }),
    );

    expect(calls.digests).toHaveLength(1);
    expect(calls.digests[0]?.parentUserId).toBe('parent-1');
    expect(calls.digests[0]?.weekStart.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('LOGS AND RETURNS on an unusable payload rather than retrying it', async () => {
    // `platform/jobs`' rule: a handler that knows its input is unprocessable
    // records that and RETURNS, because the job did its work and the work was to
    // determine that. Throwing would burn five attempts and a dead letter on a
    // payload no retry can fix.
    const { module, calls } = fakeModule(true);
    const logger = new FakeLogger();
    const handlers = buildNotifyHandlers(module, logger);

    await expect(
      handlers[NOTIFY_DIGEST_DELIVER_JOB]?.(jobOf({ payload: { parentUserId: 42 } })),
    ).resolves.toBeUndefined();

    expect(calls.digests).toEqual([]);
    expect(logger.lines.some((line) => line.obj.event === 'notify.digest_bad_payload')).toBe(true);
  });

  it('refuses a week start that is not a date, and says which failure it was', async () => {
    // Separately from a missing field, because the two have different causes: a
    // missing field is a producer that changed shape, an unparseable date is a
    // producer that changed FORMAT. One event name for both would make the
    // second indistinguishable in a log search.
    const { module, calls } = fakeModule(true);
    const logger = new FakeLogger();
    const handlers = buildNotifyHandlers(module, logger);

    await handlers[NOTIFY_DIGEST_DELIVER_JOB]?.(
      jobOf({ payload: { parentUserId: 'parent-1', weekStart: 'last tuesday' } }),
    );

    expect(calls.digests).toEqual([]);
    expect(logger.lines.some((line) => line.obj.event === 'notify.digest_bad_week')).toBe(true);
  });

  it('never writes a parent id into a log line', async () => {
    const { module } = fakeModule(true);
    const logger = new FakeLogger();
    const handlers = buildNotifyHandlers(module, logger);

    await handlers[NOTIFY_DIGEST_DELIVER_JOB]?.(
      jobOf({ payload: { parentUserId: 'parent-secret-1', weekStart: 'nope' } }),
    );

    expect(JSON.stringify(logger.lines)).not.toContain('parent-secret-1');
  });
});

describe('the scan handler', () => {
  it('runs the scan and nothing else', async () => {
    const { module, calls } = fakeModule(true);
    const handlers = buildNotifyHandlers(module, new FakeLogger());

    await handlers[NOTIFY_DIGEST_SCAN_JOB]?.(jobOf({ kind: NOTIFY_DIGEST_SCAN_JOB }));

    expect(calls.scans).toHaveLength(1);
    expect(calls.digests).toEqual([]);
  });
});
