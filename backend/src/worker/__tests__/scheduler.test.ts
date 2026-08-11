import { describe, expect, it } from 'vitest';
import type { ClaimedJob, EnqueueInput, EnqueueResult, FailureOutcome, JobQueue, JobStatus } from '@/platform/jobs/index';
import { weekKey } from '@/modules/notify/domain/digest-week';
import {
  ensureRecurringJobs,
  occurrenceKey,
  utcDateKey,
  utcWeekKey,
  type RecurringJob,
} from '../scheduler';

/**
 * The recurring scheduler — 04-RESILIENCE-PLAN.md §3.2, and the reason there is
 * no cron anywhere in this codebase.
 *
 * Everything here is a pure function over an injected `now` plus one queue call,
 * so none of it needs a database and none of it may sleep (§9.5). What is under
 * test is the KEY, because the key is the entire scheduler: `(kind,
 * idempotency_key)` is UNIQUE and enqueue is `ON CONFLICT DO NOTHING`, so a
 * wrong key is a job that runs twice a day or not at all, silently.
 */

/** Records every enqueue and reports whichever `created` the test scripted. */
class RecordingQueue implements JobQueue {
  readonly enqueued: EnqueueInput[] = [];

  constructor(private readonly createdFor: (input: EnqueueInput) => boolean = () => true) {}

  enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    this.enqueued.push(input);
    return Promise.resolve({ id: `id-${String(this.enqueued.length)}`, created: this.createdFor(input) });
  }

  claim(): Promise<ClaimedJob | null> {
    return Promise.resolve(null);
  }

  succeed(): Promise<boolean> {
    return Promise.resolve(true);
  }

  fail(): Promise<FailureOutcome> {
    return Promise.resolve('retry');
  }

  release(): Promise<boolean> {
    return Promise.resolve(true);
  }

  reapStuck(): Promise<number> {
    return Promise.resolve(0);
  }

  countByStatus(): Promise<Readonly<Record<JobStatus, number>>> {
    return Promise.resolve({ pending: 0, running: 0, succeeded: 0, failed: 0, dead: 0 });
  }
}

const DAILY: RecurringJob = { kind: 'sweep.daily', cadence: 'daily' };
const WEEKLY: RecurringJob = { kind: 'digest.weekly', cadence: 'weekly' };

describe('utcDateKey', () => {
  it('is the UTC calendar date, not the local one', () => {
    // A key derived from local time changes meaning when the server's timezone
    // does, and "the sweep ran twice on the day we moved region" is a bug
    // nobody would connect to a key format.
    expect(utcDateKey(new Date('2026-08-09T23:59:59.999Z'))).toBe('2026-08-09');
    expect(utcDateKey(new Date('2026-08-10T00:00:00.000Z'))).toBe('2026-08-10');
  });
});

describe('utcWeekKey', () => {
  it('maps every day of one week to that week’s Monday', () => {
    // `getUTCDay()` returns 0 for SUNDAY, so Sunday is six days after its
    // Monday rather than one day before the next. Getting that wrong makes one
    // week eight days long and the next six — and the symptom is a digest that
    // arrives twice one week and not at all the next.
    const monday = '2026-08-03';
    const week = [
      '2026-08-03T00:00:00.000Z', // Monday
      '2026-08-04T12:00:00.000Z',
      '2026-08-05T12:00:00.000Z',
      '2026-08-06T12:00:00.000Z',
      '2026-08-07T12:00:00.000Z',
      '2026-08-08T12:00:00.000Z', // Saturday
      '2026-08-09T23:59:59.999Z', // SUNDAY — the one that breaks naive arithmetic
    ];

    expect(week.map((instant) => utcWeekKey(new Date(instant)))).toEqual(week.map(() => monday));
  });

  it('rolls over to the next Monday at the week boundary', () => {
    expect(utcWeekKey(new Date('2026-08-09T23:59:59.999Z'))).toBe('2026-08-03');
    expect(utcWeekKey(new Date('2026-08-10T00:00:00.000Z'))).toBe('2026-08-10');
  });

  it('agrees with the notify module’s week arithmetic', () => {
    // The same arithmetic exists in `modules/notify/domain/digest-week.ts`.
    // It is DUPLICATED rather than imported, deliberately — the worker's
    // scheduler must not depend on a module to express a cadence — so this is
    // the pin that stops the two drifting. A drift here means the scan is
    // keyed to one week and the digest rows to another, and every parent gets
    // either two digests or none.
    for (const instant of [
      '2026-01-01T00:00:00.000Z',
      '2026-03-01T09:30:00.000Z',
      '2026-08-09T23:59:59.999Z',
      '2026-12-31T18:00:00.000Z',
    ]) {
      const now = new Date(instant);
      expect(utcWeekKey(now)).toBe(weekKey(now));
    }
  });
});

describe('occurrenceKey', () => {
  it('keys a daily job by the UTC date and a weekly one by its Monday', () => {
    const now = new Date('2026-08-09T23:00:00.000Z'); // a Sunday
    expect(occurrenceKey(DAILY, now)).toBe('sweep.daily:2026-08-09');
    expect(occurrenceKey(WEEKLY, now)).toBe('digest.weekly:2026-08-03');
  });

  it('gives the same key for every instant within one period', () => {
    // This is the property the UNIQUE index turns into "exactly one row per
    // period, no matter how many replicas tick how often".
    const early = new Date('2026-08-09T00:00:00.000Z');
    const late = new Date('2026-08-09T23:59:59.999Z');
    expect(occurrenceKey(DAILY, early)).toBe(occurrenceKey(DAILY, late));
  });
});

describe('ensureRecurringJobs', () => {
  it('enqueues one occurrence per job, keyed by period', async () => {
    const queue = new RecordingQueue();
    const created = await ensureRecurringJobs(
      queue,
      [DAILY, WEEKLY],
      new Date('2026-08-09T06:00:00.000Z'),
    );

    expect(queue.enqueued.map((input) => input.idempotencyKey)).toEqual([
      'sweep.daily:2026-08-09',
      'digest.weekly:2026-08-03',
    ]);
    expect(created).toEqual(['sweep.daily', 'digest.weekly']);
  });

  it('reports only the kinds it actually created', async () => {
    // Ten replicas ticking every second still produce one row per period. The
    // caller logs the TRANSITION rather than logging on every tick, which is
    // only possible because `created` is honest about the conflict.
    const queue = new RecordingQueue((input) => input.kind === DAILY.kind);
    const created = await ensureRecurringJobs(
      queue,
      [DAILY, WEEKLY],
      new Date('2026-08-09T06:00:00.000Z'),
    );

    expect(created).toEqual(['sweep.daily']);
  });

  it('leaves run_at at its default so today’s occurrence is claimable now', async () => {
    // Delaying it to a specific hour is the timezone problem in the header,
    // and these jobs do not care what time they run.
    const queue = new RecordingQueue();
    await ensureRecurringJobs(queue, [DAILY], new Date('2026-08-09T06:00:00.000Z'));

    expect(queue.enqueued[0]?.runAt).toBeUndefined();
  });

  it('passes maxAttempts through only when the entry declares one', async () => {
    const queue = new RecordingQueue();
    await ensureRecurringJobs(
      queue,
      [DAILY, { kind: 'sweep.picky', cadence: 'daily', maxAttempts: 2 }],
      new Date('2026-08-09T06:00:00.000Z'),
    );

    expect(queue.enqueued[0]?.maxAttempts).toBeUndefined();
    expect(queue.enqueued[1]?.maxAttempts).toBe(2);
  });

  it('creates nothing when there is nothing scheduled', async () => {
    // The live case, not a degenerate one: `scheduledJobsFor` filters the
    // recurring list down to the kinds this process has handlers for, and an
    // empty result is what a worker with no notify module gets.
    const queue = new RecordingQueue();
    expect(await ensureRecurringJobs(queue, [], new Date())).toEqual([]);
    expect(queue.enqueued).toEqual([]);
  });
});
