import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../../src/platform/db/index';
import {
  createIdentityRepository,
  type IdentityRepository,
} from '../../src/modules/identity/identity.repository';
import { FixedClock } from '../../src/platform/clock/index';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../helpers/postgres';

/**
 * The repository access the identity module will call once it is repointed off
 * the cache (D-012). Written and tested here so the next agent inherits a
 * proven surface rather than an untested one.
 *
 * Everything runs against a REAL Postgres (§9.1). Faking it would hide the two
 * things actually worth testing: whether the partial unique index does what
 * the migration claims, and whether `FOR UPDATE` really serialises two parents
 * racing on one code.
 */

let postgres: TestPostgres;
let handle: DbHandle;
let repository: IdentityRepository;
let clock: FixedClock;

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

async function makeStudent(email: string): Promise<string> {
  const result = await postgres.client.query<{ id: string }>(
    `insert into users (email, password_hash, role) values ($1, 'x', 'student') returning id`,
    [email],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('failed to create the test student');
  return id;
}

function expiry(): Date {
  return new Date(clock.now().getTime() + FIFTEEN_MINUTES_MS);
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  /**
   * EVERY migration, discovered — the D-046/D-072 defect, found here a THIRD
   * time and fixed at the source (D-075).
   *
   * This file named `['0000_identity.sql', '0001_link_codes.sql']` and applied
   * them by hand. It was green, and it was green by luck: the repository under
   * test only touches `link_codes`, and the raw SQL that creates its test users
   * names its columns explicitly, so the missing `users.tenant_id` never came up.
   *
   * That is exactly how this defect presented the previous two times. It does
   * not fail where the list is; it fails several layers away, later, when some
   * unrelated migration adds a column that Drizzle's `.returning()` then
   * projects — and the error lands in `createUser`, nowhere near the cause.
   *
   * A hardcoded list is a second source of truth about which migrations exist,
   * and second sources of truth drift. There is now an ESLint rule that makes
   * the array form unavailable rather than merely discouraged; see
   * `eslint.config.js`, MIGRATION_LIST_PATTERNS.
   */
  await applyAllMigrations(postgres.client);
  handle = createDb({ url: postgres.url, poolMax: 5, ssl: false });
  repository = createIdentityRepository(handle);
  clock = new FixedClock('2026-06-01T09:00:00.000Z');
}, 180_000);

afterEach(async () => {
  await postgres.client.query('truncate table link_codes, users restart identity cascade');
  clock.setTo('2026-06-01T09:00:00.000Z');
});

afterAll(async () => {
  await handle.close();
  await postgres.stop();
}, 60_000);

describe('issueLinkCode', () => {
  it('issues a code for a student', async () => {
    const student = await makeStudent('a@example.test');
    const issued = await repository.issueLinkCode({
      studentUserId: student,
      code: 'AB3DEF',
      expiresAt: expiry(),
      now: clock.now(),
    });

    expect(issued.code).toBe('AB3DEF');
    expect(issued.studentUserId).toBe(student);
    expect(issued.expiresAt?.getTime()).toBe(clock.now().getTime() + FIFTEEN_MINUTES_MS);
  });

  it('retires the previous code rather than failing on the unique index', async () => {
    // A student who asks twice gets a new code, not an error. The partial
    // unique index would reject a naive second insert, so the retire-then-
    // insert has to happen — and it has to be one transaction, or a crash
    // between the two leaves the student permanently unable to get a code.
    const student = await makeStudent('b@example.test');
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'FIRST1',
      expiresAt: expiry(),
      now: clock.now(),
    });

    clock.advanceSeconds(30);
    const second = await repository.issueLinkCode({
      studentUserId: student,
      code: 'SECOND',
      expiresAt: expiry(),
      now: clock.now(),
    });

    expect(second.code).toBe('SECOND');
    const active = await repository.findActiveLinkCodeForStudent(student, clock.now());
    expect(active?.code).toBe('SECOND');
  });

  it('marks the retired code consumed rather than deleting it', async () => {
    const student = await makeStudent('c@example.test');
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'OLDONE',
      expiresAt: expiry(),
      now: clock.now(),
    });
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'NEWONE',
      expiresAt: expiry(),
      now: clock.now(),
    });

    const rows = await postgres.client.query<{ code: string; consumed_at: Date | null }>(
      `select code, consumed_at from link_codes where student_user_id = $1 order by code`,
      [student],
    );
    expect(rows.rows.map((row) => row.code)).toEqual(['NEWONE', 'OLDONE']);
    expect(rows.rows.find((row) => row.code === 'OLDONE')?.consumed_at).not.toBeNull();
  });

  it('makes the retired code unusable immediately', async () => {
    const student = await makeStudent('d@example.test');
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'STALE1',
      expiresAt: expiry(),
      now: clock.now(),
    });
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'FRESH1',
      expiresAt: expiry(),
      now: clock.now(),
    });

    expect(await repository.consumeLinkCode({ code: 'STALE1', now: clock.now() })).toBeNull();
  });

  it('writes expiry from the INJECTED clock, not the database clock', async () => {
    // D-019, the same defect in a different table: two clocks on either side
    // of one comparison agree in production to the millisecond and diverge
    // silently under any skew.
    const student = await makeStudent('e@example.test');
    clock.setTo('2030-01-01T00:00:00.000Z');
    const issued = await repository.issueLinkCode({
      studentUserId: student,
      code: 'FUTURE',
      expiresAt: expiry(),
      now: clock.now(),
    });
    expect(issued.expiresAt?.toISOString()).toBe('2030-01-01T00:15:00.000Z');
  });
});

describe('consumeLinkCode', () => {
  it('returns the student the code belongs to', async () => {
    const student = await makeStudent('f@example.test');
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'GOODC1',
      expiresAt: expiry(),
      now: clock.now(),
    });

    const consumed = await repository.consumeLinkCode({ code: 'GOODC1', now: clock.now() });
    expect(consumed?.studentUserId).toBe(student);
  });

  it('is single use — the second attempt returns null', async () => {
    const student = await makeStudent('g@example.test');
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'ONCE01',
      expiresAt: expiry(),
      now: clock.now(),
    });

    expect(await repository.consumeLinkCode({ code: 'ONCE01', now: clock.now() })).not.toBeNull();
    expect(await repository.consumeLinkCode({ code: 'ONCE01', now: clock.now() })).toBeNull();
  });

  it('returns null for a code that does not exist', async () => {
    expect(await repository.consumeLinkCode({ code: 'NOSUCH', now: clock.now() })).toBeNull();
  });

  it('returns null for an expired code', async () => {
    const student = await makeStudent('h@example.test');
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'EXPIR1',
      expiresAt: expiry(),
      now: clock.now(),
    });

    clock.advanceMs(FIFTEEN_MINUTES_MS + 1);
    expect(await repository.consumeLinkCode({ code: 'EXPIR1', now: clock.now() })).toBeNull();
  });

  it('treats expiry at exactly `now` as expired', async () => {
    // The same boundary convention as domain/token.ts#isExpired. Two different
    // answers to "is this expired at exactly T" in one codebase is a bug
    // waiting for a leap second.
    const student = await makeStudent('i@example.test');
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'EDGE01',
      expiresAt: expiry(),
      now: clock.now(),
    });

    clock.advanceMs(FIFTEEN_MINUTES_MS);
    expect(await repository.consumeLinkCode({ code: 'EDGE01', now: clock.now() })).toBeNull();
  });

  it('accepts a code one millisecond before it expires', async () => {
    const student = await makeStudent('j@example.test');
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'EDGE02',
      expiresAt: expiry(),
      now: clock.now(),
    });

    clock.advanceMs(FIFTEEN_MINUTES_MS - 1);
    expect(await repository.consumeLinkCode({ code: 'EDGE02', now: clock.now() })).not.toBeNull();
  });

  it('lets exactly one of two concurrent submissions win', async () => {
    // `FOR UPDATE` serialises them. Without the lock both could read
    // "unconsumed" before either wrote, and one code would link two parents.
    const student = await makeStudent('k@example.test');
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'RACE01',
      expiresAt: expiry(),
      now: clock.now(),
    });

    const results = await Promise.all([
      repository.consumeLinkCode({ code: 'RACE01', now: clock.now() }),
      repository.consumeLinkCode({ code: 'RACE01', now: clock.now() }),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it('frees the student to be issued another code', async () => {
    const student = await makeStudent('l@example.test');
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'USED01',
      expiresAt: expiry(),
      now: clock.now(),
    });
    await repository.consumeLinkCode({ code: 'USED01', now: clock.now() });

    await expect(
      repository.issueLinkCode({
        studentUserId: student,
        code: 'NEXT01',
        expiresAt: expiry(),
        now: clock.now(),
      }),
    ).resolves.toMatchObject({ code: 'NEXT01' });
  });
});

describe('findActiveLinkCodeForStudent', () => {
  it('returns the live code', async () => {
    const student = await makeStudent('m@example.test');
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'LIVE01',
      expiresAt: expiry(),
      now: clock.now(),
    });
    expect((await repository.findActiveLinkCodeForStudent(student, clock.now()))?.code).toBe(
      'LIVE01',
    );
  });

  it('returns null when the student has none', async () => {
    const student = await makeStudent('n@example.test');
    expect(await repository.findActiveLinkCodeForStudent(student, clock.now())).toBeNull();
  });

  it('does not return an expired code', async () => {
    const student = await makeStudent('o@example.test');
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'GONE01',
      expiresAt: expiry(),
      now: clock.now(),
    });
    clock.advanceMs(FIFTEEN_MINUTES_MS + 1);
    expect(await repository.findActiveLinkCodeForStudent(student, clock.now())).toBeNull();
  });

  it('does not return a consumed code', async () => {
    const student = await makeStudent('p@example.test');
    await repository.issueLinkCode({
      studentUserId: student,
      code: 'SPENT1',
      expiresAt: expiry(),
      now: clock.now(),
    });
    await repository.consumeLinkCode({ code: 'SPENT1', now: clock.now() });
    expect(await repository.findActiveLinkCodeForStudent(student, clock.now())).toBeNull();
  });
});
