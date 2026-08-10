import { asc, eq, sql } from 'drizzle-orm';
import type { DbExecutor, DbHandle } from '@/platform/db/index';
import { schema, unwrapExecutor } from '@/platform/db/index';
import type { TransactionToken } from '@/platform/tx/index';
import type { Grade, LanguageCode } from '@/shared/constants/curriculum';
import { fromMasteryColumn, toMasteryColumn } from './domain/mastery';
import type { ChapterMasteryRecord, OnboardingResult, StudentProfileRecord } from './learner.types';

/**
 * ALL database access for the learner module — §7, rule 4.
 *
 * Enforced by ESLint: `@/platform/db` and `drizzle-orm` are importable only
 * from a `*.repository.ts` file. Without that rule someone eventually writes a
 * query that skips the authorization check.
 *
 * As in identity, every operation that must be ATOMIC is exposed as ONE
 * repository method that opens its own transaction. The service cannot call
 * `withTransaction`, which keeps every transaction boundary in the module
 * visible in this single file.
 */

const { students, studentSubjects, chapterMastery } = schema;

/**
 * The database handle, re-exported under a module-local name.
 *
 * `index.ts` has to declare this as a dependency, and the ESLint boundary bans
 * `@/platform/db` outside a `*.repository.ts` — including type imports, which
 * is right: a type import is how a repository's responsibilities start leaking
 * into files that should not have them.
 */
export type LearnerDbHandle = DbHandle;

interface StudentRow {
  userId: string;
  displayName: string;
  grade: string;
  board: string;
  preferredLanguage: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Maps a row to a record.
 *
 * `grade` and `preferredLanguage` are narrowed by assertion because the COLUMN
 * carries a CHECK constraint limiting it to exactly these values — the
 * database is the guarantee standing behind the narrowing, not this line. The
 * same pattern, for the same reason, as `toUserRecord` in identity.
 */
function toProfileRecord(row: StudentRow): StudentProfileRecord {
  return {
    userId: row.userId,
    displayName: row.displayName,
    grade: row.grade as Grade,
    board: row.board,
    preferredLanguage: row.preferredLanguage as LanguageCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface MasteryRow {
  chapterId: string;
  masteryScore: string;
  attempts: number;
  lastPractisedAt: Date | null;
  updatedAt: Date;
}

function toMasteryRecord(row: MasteryRow): ChapterMasteryRecord {
  return {
    chapterId: row.chapterId,
    // `numeric` arrives as a STRING from node-postgres. Converting in exactly
    // one place is what stops a stray `Number(...)` appearing in three query
    // methods with one of them forgetting.
    masteryScore: fromMasteryColumn(row.masteryScore),
    attempts: row.attempts,
    lastPractisedAt: row.lastPractisedAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateProfileInput {
  readonly userId: string;
  /**
   * From the AUTHENTICATED ACTOR, via the tenant the access check passed on -
   * never from client input, and never left to the column default (D-073).
   *
   * A default cannot distinguish "not supplied" from "supplied and equal to the
   * default", so it can never be the thing that enforces this. Were it, the day
   * a second tenant exists every profile would silently be filed under the
   * first.
   */
  readonly tenantId: string;
  readonly displayName: string;
  readonly grade: Grade;
  readonly board: string;
  readonly preferredLanguage: LanguageCode;
  readonly subjects: readonly string[];
  /** From the INJECTED clock, never `defaultNow()`. See `updatedAt` below. */
  readonly now: Date;
}

export interface UpdateProfileInput {
  readonly userId: string;
  readonly displayName?: string | undefined;
  readonly grade?: Grade | undefined;
  readonly preferredLanguage?: LanguageCode | undefined;
  readonly now: Date;
}

export interface UpsertMasteryInput {
  readonly studentUserId: string;
  /** The tenant the access check passed on. See `CreateProfileInput`. */
  readonly tenantId: string;
  readonly chapterId: string;
  /** Already clamped by `domain/mastery.ts`. */
  readonly masteryScore: number;
  readonly attemptIncrement: number;
  readonly practisedAt: Date | null;
  readonly now: Date;
  /**
   * The caller's OPEN TRANSACTION, when there is one — D-056.
   *
   * This is the one repository method in the module that accepts an executor,
   * because it is the one another module has to be able to enlist: `practice`
   * writes its responses, its session, its XP ledger row and this mastery row
   * in a single transaction, and a partial write there is unrepairable.
   *
   * Absent for every ordinary caller, in which case the write runs on this
   * module's own pool exactly as before.
   */
  readonly executor?: TransactionToken;
}

export interface LearnerRepository {
  /**
   * Creates the profile and its subjects, IDEMPOTENTLY, in one transaction.
   *
   * Returns `created: false` when a profile already existed, having changed
   * nothing about it.
   */
  createProfile(input: CreateProfileInput): Promise<OnboardingResult>;
  findProfile(userId: string): Promise<StudentProfileRecord | null>;
  updateProfile(input: UpdateProfileInput): Promise<StudentProfileRecord | null>;
  findSubjects(studentUserId: string): Promise<string[]>;
  findMastery(studentUserId: string): Promise<ChapterMasteryRecord[]>;
  upsertMastery(input: UpsertMasteryInput): Promise<ChapterMasteryRecord>;
}

export function createLearnerRepository(handle: LearnerDbHandle): LearnerRepository {
  const { db } = handle;

  async function selectProfile(
    executor: DbExecutor,
    userId: string,
  ): Promise<StudentProfileRecord | null> {
    const rows = await executor.select().from(students).where(eq(students.userId, userId)).limit(1);
    const row = rows[0];
    return row === undefined ? null : toProfileRecord(row);
  }

  async function selectSubjects(executor: DbExecutor, studentUserId: string): Promise<string[]> {
    const rows = await executor
      .select({ subjectCode: studentSubjects.subjectCode })
      .from(studentSubjects)
      .where(eq(studentSubjects.studentUserId, studentUserId))
      .orderBy(asc(studentSubjects.subjectCode));
    return rows.map((row) => row.subjectCode);
  }

  return {
    /**
     * ONBOARDING, AND WHY IT IS ONE TRANSACTION AND TWO `ON CONFLICT`s.
     *
     * §8.2 requires onboarding to be idempotent. This is the screen straight
     * after email verification, on Indian mobile networks: a retried POST is
     * the normal case, not the exception — the user taps twice, the connection
     * drops after the write but before the response, the app resumes cold.
     *
     * `DO NOTHING`, NEVER `DO UPDATE`. The difference is the whole requirement.
     * An upsert here would re-write `display_name`, `grade` and `board` from
     * whatever the retry happened to carry — so a student who onboarded in
     * grade 8 last term and whose app replays a stale cached request is
     * silently moved back to grade 8, and every chapter they see changes. The
     * correct answer to "this profile already exists" is to leave it alone and
     * say so, which is what `created: false` is for. Deliberately changing a
     * grade is `updateProfile`, an explicit PATCH.
     *
     * ONE TRANSACTION because the profile and its subjects are one fact. A
     * crash between them leaves a student with a profile and no subjects —
     * which every downstream screen reads as "this student studies nothing"
     * rather than as a partial write, and which no retry fixes, because the
     * retry sees the profile already exists and does nothing.
     *
     * The subject insert is `ON CONFLICT DO NOTHING` on the composite primary
     * key, so a retry that adds one new subject adds exactly that one. Existing
     * subjects are never removed here: onboarding ADDS, and taking a subject
     * away is a separate, deliberate act.
     */
    async createProfile(input: CreateProfileInput): Promise<OnboardingResult> {
      return handle.withTransaction(async (tx) => {
        const inserted = await tx
          .insert(students)
          .values({
            userId: input.userId,
            displayName: input.displayName,
            grade: input.grade,
            board: input.board,
            preferredLanguage: input.preferredLanguage,
            tenantId: input.tenantId,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoNothing({ target: students.userId })
          .returning();

        const created = inserted.length > 0;

        await tx
          .insert(studentSubjects)
          .values(
            input.subjects.map((subjectCode) => ({
              studentUserId: input.userId,
              subjectCode,
              // Denormalised from the same source as the profile above, in the
              // same transaction, so the copy cannot disagree with its source.
              tenantId: input.tenantId,
              createdAt: input.now,
            })),
          )
          .onConflictDoNothing();

        const profileRow = inserted[0];
        const profile =
          profileRow === undefined
            ? await selectProfile(tx, input.userId)
            : toProfileRecord(profileRow);

        if (profile === null) {
          // Unreachable in practice: either the insert returned a row, or a
          // row already existed for that key. Asserted rather than
          // non-null-asserted so that a future schema change which broke the
          // assumption fails here, named, instead of downstream as a null.
          throw new Error('createProfile: profile missing immediately after upsert');
        }

        return { profile, subjects: await selectSubjects(tx, input.userId), created };
      });
    },

    findProfile(userId: string): Promise<StudentProfileRecord | null> {
      return selectProfile(db, userId);
    },

    /**
     * Applies a PATCH.
     *
     * Undefined fields are omitted from the SET list rather than written as
     * null — a PATCH that mentions only `displayName` must not blank a grade.
     * Returns `null` when no row matched, so the service can distinguish
     * "not found" from "updated" without a second query.
     */
    async updateProfile(input: UpdateProfileInput): Promise<StudentProfileRecord | null> {
      const changes: Record<string, unknown> = { updatedAt: input.now };
      if (input.displayName !== undefined) changes.displayName = input.displayName;
      if (input.grade !== undefined) changes.grade = input.grade;
      if (input.preferredLanguage !== undefined) {
        changes.preferredLanguage = input.preferredLanguage;
      }

      const rows = await db
        .update(students)
        .set(changes)
        .where(eq(students.userId, input.userId))
        .returning();

      const row = rows[0];
      return row === undefined ? null : toProfileRecord(row);
    },

    findSubjects(studentUserId: string): Promise<string[]> {
      return selectSubjects(db, studentUserId);
    },

    async findMastery(studentUserId: string): Promise<ChapterMasteryRecord[]> {
      // Ordered by the composite primary key's leading column, which is how
      // this table is read on every progress screen. No separate index on
      // `student_user_id` exists, and none is needed — see the note on
      // `chapter_mastery` in the schema (D-042).
      const rows = await db
        .select()
        .from(chapterMastery)
        .where(eq(chapterMastery.studentUserId, studentUserId))
        .orderBy(asc(chapterMastery.chapterId));
      return rows.map(toMasteryRecord);
    },

    /**
     * Writes mastery for one chapter.
     *
     * `attempts` is incremented IN SQL (`attempts + $n`) rather than read,
     * incremented in TypeScript and written back. Read-modify-write on a
     * counter is a lost update the moment two submissions from the same
     * student overlap — which is exactly what a double-tap on "submit" over a
     * flaky connection produces.
     *
     * `mastery_score` is written outright rather than accumulated, because it
     * is a computed level and not a tally: the caller has already decided what
     * the new value is, from the whole of the student's history.
     */
    async upsertMastery(input: UpsertMasteryInput): Promise<ChapterMasteryRecord> {
      const score = toMasteryColumn(input.masteryScore);

      const rows = await (unwrapExecutor(input.executor) ?? db)
        .insert(chapterMastery)
        .values({
          studentUserId: input.studentUserId,
          chapterId: input.chapterId,
          masteryScore: score,
          attempts: input.attemptIncrement,
          lastPractisedAt: input.practisedAt,
          tenantId: input.tenantId,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [chapterMastery.studentUserId, chapterMastery.chapterId],
          set: {
            masteryScore: score,
            attempts: sql`${chapterMastery.attempts} + ${input.attemptIncrement}`,
            // `null` means "not an attempt": keep whatever timestamp is
            // already there rather than overwriting it with a null.
            lastPractisedAt: input.practisedAt ?? sql`${chapterMastery.lastPractisedAt}`,
            updatedAt: input.now,
          },
        })
        .returning();

      const row = rows[0];
      if (row === undefined) {
        throw new Error('upsertMastery: no row returned');
      }
      return toMasteryRecord(row);
    },
  };
}
