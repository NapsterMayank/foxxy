import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../clock/index';
import type { DbHandle } from '../../db/index';
import { FakeLogger } from '../../logger/index';
import { buildWorkerId, createHeartbeat } from '../heartbeat';

/**
 * The heartbeat's two invariants, neither of which needs a database.
 *
 *   1. THE ID IS UNIQUE PER PROCESS INCARNATION. A restarted worker must get a
 *      NEW row and leave the old one behind, because that stale row is the
 *      evidence a restart happened. A shared id would make a dead replica
 *      invisible: the survivor keeps the timestamp fresh and the corpse looks
 *      like the same healthy worker.
 *
 *   2. IT NEVER THROWS. A heartbeat is an observation ABOUT the worker; letting
 *      it kill the worker would mean the monitoring takes down the thing it
 *      monitors. This one matters more since D-303: `worker.stop()` calls
 *      `heartbeat.stop()` as its LAST step, and a throw there would be a throw
 *      escaping the shutdown path — which is the defect class this whole wave
 *      is about, one level down.
 *
 * The row-decoding half (D-305) needs the real driver and lives in
 * `tests/integration/worker-shutdown.test.ts`.
 */

/** A db handle whose every write rejects — the "database is gone" case. */
function brokenDb(message: string): DbHandle {
  return {
    db: {
      insert: () => {
        throw new Error(message);
      },
    },
    pool: {},
  } as unknown as DbHandle;
}

/** A db handle that records the upsert it was asked to perform. */
function recordingDb(recorded: Record<string, unknown>[]): DbHandle {
  return {
    db: {
      insert: () => ({
        values: (row: Record<string, unknown>) => ({
          onConflictDoUpdate: (spec: { set: Record<string, unknown> }) => {
            recorded.push({ ...row, ...spec.set });
            return Promise.resolve();
          },
        }),
      }),
    },
    pool: {},
  } as unknown as DbHandle;
}

describe('buildWorkerId', () => {
  it('is hostname:pid:startedAt, so a restart never collides with its predecessor', () => {
    const startedAt = new Date('2026-08-09T09:00:00.000Z');
    expect(buildWorkerId(startedAt, 4242)).toBe(
      `${hostname()}:4242:${String(startedAt.getTime())}`,
    );
  });

  it('differs between two starts of the same pid', () => {
    // The pid alone is not enough: a container that restarts the process can
    // hand out the same pid, and the two rows would then be one row.
    const first = buildWorkerId(new Date('2026-08-09T09:00:00.000Z'), 1);
    const second = buildWorkerId(new Date('2026-08-09T09:00:01.000Z'), 1);
    expect(first).not.toBe(second);
  });
});

describe('createHeartbeat', () => {
  it('writes running on a beat and stopped on a stop', () => {
    const recorded: Record<string, unknown>[] = [];
    const heartbeat = createHeartbeat({
      db: recordingDb(recorded),
      clock: new FixedClock('2026-08-09T09:00:00.000Z'),
      logger: new FakeLogger(),
      workerId: 'worker-1',
    });

    return Promise.all([heartbeat.beat(3), heartbeat.stop(4)]).then(() => {
      expect(recorded.map((row) => row.status)).toEqual(['running', 'stopped']);
      expect(recorded[1]?.jobsProcessed).toBe(4);
    });
  });

  it('accepts an explicit draining status', async () => {
    const recorded: Record<string, unknown>[] = [];
    const heartbeat = createHeartbeat({
      db: recordingDb(recorded),
      clock: new FixedClock(),
      logger: new FakeLogger(),
      workerId: 'worker-1',
    });

    await heartbeat.beat(1, 'draining');
    expect(recorded[0]?.status).toBe('draining');
  });

  it('never throws when the write fails — it goes stale and says why', async () => {
    // The row going stale IS the signal a reader needs; what must not happen is
    // the observation taking down the thing it observes. And it is LOGGED, so
    // the staleness has an explanation beside it rather than being a mystery.
    const logger = new FakeLogger();
    const heartbeat = createHeartbeat({
      db: brokenDb('connection terminated'),
      clock: new FixedClock(),
      logger,
      workerId: 'worker-1',
    });

    await expect(heartbeat.beat(0)).resolves.toBeUndefined();
    await expect(heartbeat.stop(0)).resolves.toBeUndefined();

    const failures = logger.lines.filter(
      (line) => line.obj.event === 'worker.heartbeat_failed',
    );
    expect(failures).toHaveLength(2);
    expect(failures[0]?.obj.err).toBe('connection terminated');
    expect(failures[0]?.level).toBe('warn');
  });
});
