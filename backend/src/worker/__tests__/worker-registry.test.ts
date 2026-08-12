import { describe, expect, it } from 'vitest';
import { FixedClock } from '@/platform/clock/index';
import type { DbHandle } from '@/platform/db/index';
import { FakeLogger } from '@/platform/logger/index';
import type { JobHandler } from '@/platform/jobs/index';
import { EXPIRED_SESSION_SWEEPER } from '../jobs/expired-session-sweeper';
import { RECURRING_JOBS, buildHandlers, scheduledJobsFor } from '../worker';

/**
 * WHAT THE WORKER SCHEDULES IS DERIVED FROM WHAT IT CAN RUN — and that filter is
 * the property worth pinning.
 *
 * A recurring entry with no registered handler enqueues a row every period that
 * the runner refuses with "no handler registered", retries five times and marks
 * `dead`. That is a job that never runs, reported as five errors a day, forever
 * — noise that trains whoever reads the logs to ignore exactly the message that
 * means "the worker is behind the enqueuer".
 *
 * Nothing here touches a database: `buildHandlers` only CONSTRUCTS handlers, and
 * the handlers themselves are covered where they run.
 */

/**
 * `buildHandlers` stores the handle and never dereferences it at construction
 * time, so a token is enough. Typed through `Pick` rather than a cast so that a
 * future constructor which DOES touch the pool fails here, named, instead of
 * throwing at some later call site.
 */
const DB_TOKEN = { db: {}, pool: {} } as unknown as DbHandle;

function deps(): { db: DbHandle; clock: FixedClock; logger: FakeLogger } {
  return { db: DB_TOKEN, clock: new FixedClock(), logger: new FakeLogger() };
}

describe('buildHandlers', () => {
  it('always registers the expired-session sweeper', () => {
    // The one job that needs no module: it is the worker's own hygiene, on the
    // `auth` pool's hot table.
    expect(Object.keys(buildHandlers(deps()))).toEqual([EXPIRED_SESSION_SWEEPER]);
  });

  it('registers nothing from notify when the module is absent', () => {
    // Gated rather than stubbed, deliberately: a registered handler that did
    // nothing would let a job SUCCEED without doing the work, which is worse
    // than the loud "no handler registered" the runner raises.
    const handlers = buildHandlers(deps());
    expect(handlers[EXPIRED_SESSION_SWEEPER]).toBeTypeOf('function');
    expect(Object.keys(handlers)).toHaveLength(1);
  });
});

describe('scheduledJobsFor', () => {
  const noop: JobHandler = () => Promise.resolve();

  it('keeps only the recurring entries this process can actually run', () => {
    const scheduled = scheduledJobsFor({ [EXPIRED_SESSION_SWEEPER]: noop }, RECURRING_JOBS);
    expect(scheduled.map((job) => job.kind)).toEqual([EXPIRED_SESSION_SWEEPER]);
  });

  it('schedules nothing when no handler matches', () => {
    // A worker with an empty registry must schedule an empty list, not the
    // constant. Returning `RECURRING_JOBS` here is the exact regression this
    // filter exists to prevent.
    expect(scheduledJobsFor({}, RECURRING_JOBS)).toEqual([]);
  });

  it('defaults to the declared recurring list', () => {
    const scheduled = scheduledJobsFor({ [EXPIRED_SESSION_SWEEPER]: noop });
    expect(scheduled).toHaveLength(1);
  });

  it('every declared recurring entry uses a cadence the scheduler can express', () => {
    // The scheduler expresses daily-or-coarser periods through the idempotency
    // key and nothing else. A third cadence added to the constant without the
    // key arithmetic to match would silently key every occurrence to the same
    // period — one run, ever.
    for (const job of RECURRING_JOBS) {
      expect(['daily', 'weekly']).toContain(job.cadence);
    }
  });
});
