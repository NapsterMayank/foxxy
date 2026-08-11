import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '@/platform/clock/index';
import { createDb, type DbHandle } from '@/platform/db/index';
import { ValidationError } from '@/platform/errors/index';
import { FakeLogger } from '@/platform/logger/fake-logger';
import { createLearnerRepository } from '../learner.repository';
import { createLearnerService, type LearnerService } from '../learner.service';
import type { LearnerActor } from '../learner.types';
import { insertChapter, insertUser, makeChapter } from '../../../../tests/fixtures/index';
import {
  applyAllMigrations,
  startTestPostgres,
  type TestPostgres,
} from '../../../../tests/helpers/postgres';

/**
 * =============================================================================
 * THE LEARNER WRITE PATH — D-243 (a negative attempt increment) and D-244 (a
 * PATCH that changes nothing writes nothing).
 *
 * -----------------------------------------------------------------------------
 * WHY THESE ARE NOT IN `learner.service.test.ts`.
 *
 * Both properties are properties OF THE DATABASE as much as of the code: one is
 * about what SQL does with `attempts + $n`, the other is about whether an
 * UPDATE statement was issued at all. Neither can be observed from a fake, and
 * both are asserted here by reading the row back out of a real Postgres.
 *
 * The file builds its own handle through `createDb` rather than going through
 * the app harness, for the same reason `practice.concurrency.test.ts` does:
 * these tests are about one module's repository, and the whole application
 * container is a great deal of machinery to stand up to observe one timestamp.
 * =============================================================================
 */

let postgres: TestPostgres;
let handle: DbHandle;
let learner: LearnerService;

const clock = new FixedClock('2026-03-02T09:00:00.000Z');
const logger = new FakeLogger();

let nextChapterNumber = 1;

beforeAll(async () => {
  postgres = await startTestPostgres();
  await applyAllMigrations(postgres.client);
  handle = createDb({ url: postgres.url, poolMax: 4, ssl: false });

  learner = createLearnerService({
    repository: createLearnerRepository(handle),
    clock,
    logger,
    readLinkStatus: () => Promise.resolve(null),
    readTenantOfStudent: () => Promise.resolve(null),
  });
}, 240_000);

afterAll(async () => {
  await handle.close();
  await postgres.stop();
}, 60_000);

/**
 * A raw query against the test database.
 *
 * Typed `Record<string, unknown>` rather than left as the driver's `any`:
 * every caller below narrows the row it wants, and an `any` here would make
 * those narrowings silently vacuous.
 */
async function sql(
  text: string,
  values: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const result = await postgres.client.query<Record<string, unknown>>(text, [...values]);
  return result.rows;
}

interface Student {
  readonly userId: string;
  readonly tenantId: string;
  readonly actor: LearnerActor;
}

async function seedStudent(): Promise<Student> {
  const email = `write-path-${String(Date.now())}-${String(Math.random()).slice(2)}@test.local`;
  const userId = await insertUser(postgres.client, email, 'student');

  const rows = await sql('select tenant_id from users where id = $1', [userId]);
  const row = rows[0] as { tenant_id: string } | undefined;
  if (row === undefined) throw new Error('seedStudent: no users row');
  const tenantId = row.tenant_id;

  await sql(
    `insert into students (user_id, display_name, grade, board, preferred_language, tenant_id)
       values ($1, 'Write Path Student', '8', 'CBSE', 'en', $2)`,
    [userId, tenantId],
  );

  return { userId, tenantId, actor: { userId, role: 'student', tenantId } };
}

async function seedChapter(): Promise<string> {
  const chapterNumber = nextChapterNumber;
  nextChapterNumber += 1;
  return insertChapter(
    postgres.client,
    makeChapter(`write-path-${String(chapterNumber)}`, { chapterNumber }),
  );
}

async function attemptsOf(userId: string, chapterId: string): Promise<number> {
  const rows = await sql(
    'select attempts from chapter_mastery where student_user_id = $1 and chapter_id = $2',
    [userId, chapterId],
  );
  const row = rows[0] as { attempts: number } | undefined;
  if (row === undefined) throw new Error('attemptsOf: no chapter_mastery row');
  return row.attempts;
}

async function updatedAtOf(userId: string): Promise<string> {
  const rows = await sql('select updated_at from students where user_id = $1', [userId]);
  const row = rows[0] as { updated_at: Date } | undefined;
  if (row === undefined) throw new Error('updatedAtOf: no students row');
  return row.updated_at.toISOString();
}

/* ========================================================================== */

describe('D-243 — a negative attempt increment is refused at the domain boundary', () => {
  /**
   * ===========================================================================
   * WHAT THIS ASSERTS, STATED HONESTLY.
   *
   * It would be neater to claim the CHECK constraint lets `7 + (-3) = 4`
   * through and that the domain guard is the only thing standing in the way.
   * That is NOT what the database does — see the measured probe in
   * `domain/mastery.ts`. `upsertMastery` carries the raw increment in its
   * INSERT's VALUES, and Postgres evaluates a CHECK when it forms that tuple,
   * so a negative increment is refused by the constraint too.
   *
   * So the assertion is about WHICH refusal happens, and it is a real
   * distinction rather than a cosmetic one:
   *
   *   - `ValidationError` — the domain boundary refused it. A 400 that names
   *     the rule, raised before any statement is issued.
   *   - anything else — the driver's constraint violation escaped the
   *     repository. A 500 naming an internal constraint, for what is plainly
   *     a bad argument.
   *
   * `toBeInstanceOf` rather than `toThrow` for exactly that reason: `toThrow`
   * alone would pass against the raw database error and this test would be
   * pinning nothing. Removing `assertAttemptIncrement` from the service turns
   * this red, which is the check that it is really wired in.
   * ===========================================================================
   */
  it('refuses -3 against 7 attempts with a ValidationError, not a raw constraint error', async () => {
    const student = await seedStudent();
    const chapterId = await seedChapter();

    await learner.updateMastery(student.actor, {
      studentUserId: student.userId,
      chapterId,
      masteryScore: 0.5,
      expectedPreviousScore: null,
      attemptIncrement: 7,
    });
    expect(await attemptsOf(student.userId, chapterId)).toBe(7);

    await expect(
      learner.updateMastery(student.actor, {
        studentUserId: student.userId,
        chapterId,
        masteryScore: 0.5,
        expectedPreviousScore: 0.5,
        attemptIncrement: -3,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // THE COUNTER DID NOT MOVE. A rejection that still wrote would be the
    // defect wearing an error message.
    expect(await attemptsOf(student.userId, chapterId)).toBe(7);
  }, 120_000);

  it('refuses a negative increment on a chapter with NO row yet — the insert path', async () => {
    const student = await seedStudent();
    const chapterId = await seedChapter();

    await expect(
      learner.updateMastery(student.actor, {
        studentUserId: student.userId,
        chapterId,
        masteryScore: 0.5,
        expectedPreviousScore: null,
        attemptIncrement: -1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const rows = await sql(
      'select 1 from chapter_mastery where student_user_id = $1 and chapter_id = $2',
      [student.userId, chapterId],
    );
    expect(rows).toHaveLength(0);
  }, 120_000);

  it('still allows zero — a correction that is not an attempt', async () => {
    const student = await seedStudent();
    const chapterId = await seedChapter();

    await learner.updateMastery(student.actor, {
      studentUserId: student.userId,
      chapterId,
      masteryScore: 0.5,
      expectedPreviousScore: null,
    });

    const corrected = await learner.updateMastery(student.actor, {
      studentUserId: student.userId,
      chapterId,
      masteryScore: 0.55,
      expectedPreviousScore: 0.5,
      attemptIncrement: 0,
      practised: false,
    });

    expect(corrected?.attempts).toBe(1);
    expect(corrected?.masteryScore).toBe(0.55);
  }, 120_000);
});

/* ========================================================================== */

describe('D-244 — a PATCH that changes nothing does not move updated_at', () => {
  /**
   * ===========================================================================
   * `updated_at` MEANS "when this profile last changed", AND IT IS READ THAT
   * WAY.
   *
   * A mobile settings screen posts its whole form on save whether or not a
   * field was touched, and a dropped connection makes the app resend it. Under
   * the old behaviour every one of those moved the timestamp, so the column
   * quietly became a record of client behaviour instead of a record of change.
   *
   * Nothing failed. That is what makes it worth a test: there is no error to
   * catch, only a number that stops meaning what it says.
   * ===========================================================================
   */
  it('leaves updated_at alone when every field re-sends its stored value', async () => {
    const student = await seedStudent();
    const before = await updatedAtOf(student.userId);

    // The clock moves, so a write WOULD be visible. Without this the test
    // could pass against a system that writes on every call.
    clock.advanceMs(60_000);

    const patched = await learner.updateProfile(student.actor, student.userId, {
      displayName: 'Write Path Student',
      grade: '8',
      preferredLanguage: 'en',
    });

    expect(patched.displayName).toBe('Write Path Student');
    expect(await updatedAtOf(student.userId)).toBe(before);
  }, 120_000);

  it('leaves updated_at alone for an EMPTY patch', async () => {
    const student = await seedStudent();
    const before = await updatedAtOf(student.userId);

    clock.advanceMs(60_000);
    await learner.updateProfile(student.actor, student.userId, {});

    expect(await updatedAtOf(student.userId)).toBe(before);
  }, 120_000);

  it('DOES move updated_at when a field genuinely changes', async () => {
    const student = await seedStudent();
    const before = await updatedAtOf(student.userId);

    clock.advanceMs(60_000);
    const patched = await learner.updateProfile(student.actor, student.userId, {
      displayName: 'A Different Name',
    });

    expect(patched.displayName).toBe('A Different Name');
    const after = await updatedAtOf(student.userId);
    expect(after).not.toBe(before);
    // From the INJECTED clock, so the no-op branch above cannot be "passing"
    // because the write silently used `defaultNow()`.
    expect(after).toBe(clock.now().toISOString());
  }, 120_000);

  it('moves updated_at when ONE of several fields changes and the rest re-send', async () => {
    const student = await seedStudent();
    clock.advanceMs(60_000);

    await learner.updateProfile(student.actor, student.userId, {
      displayName: 'Write Path Student',
      grade: '9',
      preferredLanguage: 'en',
    });

    const rows = await sql('select grade from students where user_id = $1', [student.userId]);
    expect((rows[0] as { grade: string }).grade).toBe('9');
    expect(await updatedAtOf(student.userId)).toBe(clock.now().toISOString());
  }, 120_000);

  it('still reports NOT FOUND for a patch against a student who does not exist', async () => {
    const student = await seedStudent();
    // A real student, so the access check passes, but the profile row removed —
    // which is the only way "matched nothing" can mean "no such student" rather
    // than "nothing to change".
    await sql('delete from students where user_id = $1', [student.userId]);

    await expect(
      learner.updateProfile(student.actor, student.userId, { displayName: 'Ghost' }),
    ).rejects.toThrow();
  }, 120_000);
});
