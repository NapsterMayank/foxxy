import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_RESOURCES, createPostgresAudit } from '@/platform/audit/index';
import { FixedClock } from '@/platform/clock/index';
import { createDb, type DbHandle } from '@/platform/db/index';
import { FakeLogger } from '@/platform/logger/index';
import { MemoryMetrics } from '@/platform/metrics/index';
import { PII_REDACTED } from '@/platform/pii/index';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../helpers/postgres';

/**
 * `audit_log` — 05-ROADMAP.md §8, migration 0005.
 *
 * Two properties, and both are enforced by the DATABASE rather than by this
 * codebase's good intentions, which is why they need a real Postgres to test:
 *
 *   IMMUTABILITY  a trigger raises on UPDATE and on DELETE. An audit log the
 *                 application can rewrite is a log that a bug, or a person with
 *                 a database connection, can quietly correct.
 *
 *   NO PII        every payload is scrubbed on the way in. This table records
 *                 actions taken against MINORS' accounts, it is the artefact
 *                 handed to a school or a regulator, and it is the one table
 *                 that is never deleted — which makes it the worst possible
 *                 place to keep an email address.
 */

let postgres: TestPostgres;
let handle: DbHandle;
let clock: FixedClock;
let logger: FakeLogger;
let metrics: MemoryMetrics;

const NOW = '2026-08-09T09:00:00.000Z';
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
  // TRUNCATE, not DELETE — DELETE is refused by the trigger, which is the whole
  // point. It is also why TRUNCATE is deliberately left unblocked: it needs
  // table ownership, so it is already a DBA-only operation, and it is the only
  // legal way this table can ever shrink.
  await postgres.client.query('truncate table audit_log');
  clock = new FixedClock(NOW);
  logger = new FakeLogger();
  metrics = new MemoryMetrics({ clock });
});

function buildAudit() {
  return createPostgresAudit({ db: handle, clock, logger, metrics });
}

async function rows(): Promise<
  { action: string; metadata: Record<string, unknown>; created_at: Date; actor_role: string | null }[]
> {
  const result = await postgres.client.query<{
    action: string;
    metadata: Record<string, unknown>;
    created_at: Date;
    actor_role: string | null;
  }>('select action, metadata, created_at, actor_role from audit_log order by created_at');
  return result.rows;
}

describe('audit_log is append-only, enforced by a trigger', () => {
  it('REFUSES an UPDATE', async () => {
    await buildAudit().record({
      actor: { userId: ACTOR, role: 'student' },
      action: AUDIT_ACTIONS.LOGOUT_ALL,
      resourceType: AUDIT_RESOURCES.SESSION,
    });

    await expect(
      postgres.client.query(`update audit_log set action = 'tampered'`),
    ).rejects.toThrow(/append-only/);
  });

  it('REFUSES a DELETE', async () => {
    await buildAudit().record({
      actor: { userId: ACTOR, role: 'student' },
      action: AUDIT_ACTIONS.LOGOUT_ALL,
      resourceType: AUDIT_RESOURCES.SESSION,
    });

    await expect(postgres.client.query('delete from audit_log')).rejects.toThrow(/append-only/);
    expect(await rows()).toHaveLength(1);
  });

  it('raises a distinguishable SQLSTATE, not a bare exception', async () => {
    // So a caller can tell "you may not do that here" from a constraint
    // violation. A generic error would be indistinguishable from a bad insert.
    await buildAudit().record({
      actor: { userId: ACTOR, role: 'parent' },
      action: AUDIT_ACTIONS.LINK_REVOKED,
      resourceType: AUDIT_RESOURCES.PARENT_CHILD_LINK,
    });

    try {
      await postgres.client.query('delete from audit_log');
      expect.unreachable('expected the append-only trigger to raise');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('2F004');
    }
  });

  it('survives the DELETE of the user it refers to', async () => {
    // `actor_user_id` has NO foreign key, and this is why. CASCADE would delete
    // the audit trail on account deletion — the one thing an audit log must not
    // do — and it would do so with a DELETE, which the trigger refuses, so
    // account deletion would simply FAIL. SET NULL fails identically: it is an
    // UPDATE. Any referential action turns "delete my account" into "the audit
    // trigger raised".
    const inserted = await postgres.client.query<{ id: string }>(
      `insert into users (email, password_hash, role) values ('leaving@example.test', 'x', 'student') returning id`,
    );
    const userId = inserted.rows[0]?.id ?? '';

    await buildAudit().record({
      actor: { userId, role: 'student' },
      action: AUDIT_ACTIONS.PASSWORD_RESET,
      resourceType: AUDIT_RESOURCES.USER,
      resourceId: userId,
    });

    await expect(
      postgres.client.query('delete from users where id = $1', [userId]),
    ).resolves.toBeDefined();
    expect(await rows()).toHaveLength(1);
  });
});

describe('audit metadata never contains PII', () => {
  it('REDACTS an email address and a phone number before the insert', async () => {
    // The named requirement. Both mechanisms are exercised: `parentEmail` is
    // dropped by KEY, and the address buried in `note` is redacted by VALUE —
    // which no key list could have caught.
    await buildAudit().record({
      actor: { userId: ACTOR, role: 'parent' },
      action: AUDIT_ACTIONS.LINK_APPROVED,
      resourceType: AUDIT_RESOURCES.PARENT_CHILD_LINK,
      metadata: {
        parentEmail: 'asha@example.com',
        phone: '+91 98765 43210',
        note: 'confirmed with asha@example.com by phone',
        studentUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    });

    const stored = await rows();
    expect(stored[0]?.metadata).toEqual({
      note: PII_REDACTED,
      studentUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });

    // The strongest form of the assertion: search the WHOLE table.
    const raw = await postgres.client.query<{ dump: string }>(
      'select audit_log::text as dump from audit_log',
    );
    const dump = raw.rows.map((row) => row.dump).join(' ');
    expect(dump).not.toContain('asha@example.com');
    expect(dump).not.toContain('98765');
  });

  it('is LOUD about it — a warn line and a metric, naming keys not values', async () => {
    // The scrub is a safety net, not the design. A module putting personal data
    // into an audit payload is a defect that has to be fixed where it
    // originates, and a silent scrub is a defect nobody ever hears about.
    await buildAudit().record({
      actor: { userId: ACTOR, role: 'parent' },
      action: AUDIT_ACTIONS.LINK_APPROVED,
      resourceType: AUDIT_RESOURCES.PARENT_CHILD_LINK,
      metadata: { userEmail: 'asha@example.com' },
    });

    const warning = logger.lines.find((line) => line.obj.event === 'audit.pii_scrubbed');
    expect(warning?.level).toBe('warn');
    expect(warning?.obj.keys).toEqual(['userEmail']);
    expect(metrics.totalFor('platform.pii.scrubbed')).toBe(1);

    // The KEYS are logged; moving the value from a permanent table into a log
    // is the same leak with a shorter retention period.
    expect(JSON.stringify(logger.lines)).not.toContain('asha@example.com');
  });

  it('leaves identifiers and counts untouched', async () => {
    // The opposite failure: a scrubber that ate `studentUserId` would make the
    // audit log useless, which is worse than the leak it prevents is bad.
    const metadata = {
      parentUserId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      studentUserId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sessions: 6,
      revokedByRole: 'student',
    };
    await buildAudit().record({
      actor: { userId: ACTOR, role: 'student' },
      action: AUDIT_ACTIONS.LINK_REVOKED,
      resourceType: AUDIT_RESOURCES.PARENT_CHILD_LINK,
      metadata,
    });

    const stored = await rows();
    expect(stored[0]?.metadata).toEqual(metadata);
    expect(logger.lines.some((line) => line.obj.event === 'audit.pii_scrubbed')).toBe(false);
  });
});

describe('recording never breaks the action it records', () => {
  it('does not throw when the write fails', async () => {
    // Every caller is a privileged action in progress. If auditing could fail
    // the operation, a full disk or a schema drift would BLOCK A USER FROM
    // REVOKING A PARENT'S ACCESS — the failure of the record breaking the thing
    // recorded, at the exact moment somebody urgently needs it to work.
    const brokenHandle = createDb({
      url: postgres.url.replace(/\/t_[0-9a-f]+$/, '/definitely_not_a_database'),
      poolMax: 1,
      ssl: false,
    });
    const audit = createPostgresAudit({ db: brokenHandle, clock, logger, metrics });

    await expect(
      audit.record({
        actor: { userId: ACTOR, role: 'student' },
        action: AUDIT_ACTIONS.LOGOUT_ALL,
        resourceType: AUDIT_RESOURCES.SESSION,
      }),
    ).resolves.toBeUndefined();

    // Loud on the operator's side, at `error`: a lost audit row is
    // unrecoverable and invisible to the user, so the compensating control is
    // that somebody finds out.
    const failure = logger.lines.find((line) => line.obj.event === 'audit.write_failed');
    expect(failure?.level).toBe('error');
    expect(metrics.totalFor('platform.audit.write_failed')).toBe(1);

    await brokenHandle.close();
  });
});

describe('the row itself', () => {
  it('stamps the INJECTED clock, not the database clock', async () => {
    // D-019. An audit timeline that mixes two clocks is a timeline that
    // reorders itself under skew — and reordering is exactly what makes an
    // audit trail unusable as evidence.
    await buildAudit().record({
      actor: { userId: ACTOR, role: 'student' },
      action: AUDIT_ACTIONS.LOGOUT_ALL,
      resourceType: AUDIT_RESOURCES.SESSION,
    });
    expect((await rows())[0]?.created_at.toISOString()).toBe(NOW);
  });

  it('records the role AT THE TIME, denormalised', async () => {
    // So a later role change cannot rewrite history. A join to `users.role`
    // would report today's role against yesterday's action.
    await buildAudit().record({
      actor: { userId: ACTOR, role: 'parent' },
      action: AUDIT_ACTIONS.LINK_REVOKED,
      resourceType: AUDIT_RESOURCES.PARENT_CHILD_LINK,
    });
    expect((await rows())[0]?.actor_role).toBe('parent');
  });

  it('accepts a system action with no actor', async () => {
    // The worker has no user. A NOT NULL actor would force a fake one, and a
    // fake actor in an audit log is worse than an absent one.
    await buildAudit().record({
      actor: { userId: null, role: null },
      action: 'system.retention_sweep',
      resourceType: 'session',
      metadata: { deleted: 12 },
    });
    expect(await rows()).toHaveLength(1);
  });

  it('defaults metadata to an empty OBJECT, never null or an array', async () => {
    // A CHECK enforces `jsonb_typeof(metadata) = 'object'`. A bare array or
    // scalar is still legal jsonb and would break every `metadata->>'key'` read
    // with a type error rather than a null.
    await buildAudit().record({
      actor: { userId: ACTOR, role: 'student' },
      action: AUDIT_ACTIONS.LOGOUT_ALL,
      resourceType: AUDIT_RESOURCES.SESSION,
    });
    expect((await rows())[0]?.metadata).toEqual({});

    await expect(
      postgres.client.query(
        `insert into audit_log (action, resource_type, metadata) values ('x', 'y', '[]'::jsonb)`,
      ),
    ).rejects.toThrow(/audit_log_metadata_object_check/);
  });
});
