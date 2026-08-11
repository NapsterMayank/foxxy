import { createAccessGuard, type StudentScope } from '@/platform/authz/index';
import type { Clock } from '@/platform/clock/index';
import { NotFoundError } from '@/platform/errors/index';
import type { Logger } from '@/platform/logger/index';
import type { TransactionToken } from '@/platform/tx/index';
import type { LanguageCode } from '@/shared/constants/curriculum';
import type {
  OnboardingRequest,
  UpdateProfileRequest,
} from '@/shared/contracts/learner.contract';
import { assertAttemptIncrement, clampMastery } from './domain/mastery';
import type { LearnerRepository } from './learner.repository';
import type {
  ChapterMasteryRecord,
  LearnerActor,
  LinkStatusReader,
  OnboardingResult,
  StudentProfileRecord,
  TenantReader,
} from './learner.types';

/**
 * The learner use-cases — 01-BACKEND-IMPLEMENTATION-PLAN.md §8.2.
 *
 * This layer ORCHESTRATES: it authorises, loads, calls domain functions and
 * persists. It performs no calculation of its own — the clamp and the
 * numeric-column conversions live in `domain/mastery.ts` and are unit-tested
 * with no database.
 *
 * ===========================================================================
 * EVERY METHOD THAT TOUCHES STUDENT DATA CALLS `assertCanAccess` FIRST.
 *
 * Not "every method that seems to need it". All six, including the ones whose
 * only caller today passes `actor.userId` as the target and could therefore
 * never fail the check. Those are exactly the methods that become dangerous
 * later, when a parent screen or an admin tool starts passing a different id
 * and the guard that "was not needed" is still absent.
 *
 * The check is also the ONLY place the student/parent distinction is made. It
 * is deny-by-default and it emits a contentless 403 (§7, rules 1 and 2), so a
 * refusal reveals nothing — not even whether the student exists. That property
 * is asserted directly in the service tests: the deny path is checked to carry
 * no student data at all, not merely to have the right status code.
 * ===========================================================================
 *
 * The clock is injected. There is no `new Date()` in this file and there must
 * never be one.
 */

export interface LearnerServiceDeps {
  readonly repository: LearnerRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Read at query time so a revocation is effective immediately (§7 rule 3). */
  readonly readLinkStatus: LinkStatusReader;
  /**
   * The TENANT of the student being reached - D-073.
   *
   * Read per decision and from the DATA, never copied off the actor. See the
   * long note on `TenantReader`.
   */
  readonly readTenantOfStudent: TenantReader;
}

export interface UpdateMasteryInput {
  readonly studentUserId: string;
  readonly chapterId: string;
  /** May be outside 0..1; it is clamped by the domain before it is written. */
  readonly masteryScore: number;
  /**
   * THE MASTERY THE CALLER COMPUTED `masteryScore` FROM — D-241. REQUIRED.
   *
   * `null` means "the caller saw no row for this chapter". The write applies
   * only if the stored value still equals this one, which is what makes the
   * caller's read and this write atomic with respect to each other even though
   * they happen on different connections.
   *
   * DELIBERATELY NOT OPTIONAL. An optional field with a permissive default is
   * how this defect comes back: every existing call site keeps compiling, the
   * compare-and-set degrades to an unconditional overwrite, and the lost update
   * returns silently. A required field makes a new caller state what it read.
   */
  readonly expectedPreviousScore: number | null;
  readonly attemptIncrement?: number;
  /** `true` when this update follows an actual practice attempt. */
  readonly practised?: boolean;
  /**
   * AN OPEN TRANSACTION, OPENED BY SOMEBODY ELSE — D-056.
   *
   * §8.6 requires a quiz submission to write responses, the session and its
   * score, the XP ledger entry AND mastery in ONE transaction: a partial write
   * means a student's XP disagrees with their history permanently, with no
   * retry that can repair it. `chapter_mastery` belongs to this module, so
   * `practice` cannot write it directly — and if this method opened its own
   * transaction, `practice` could not enlist it either.
   *
   * So the caller's transaction is passed in. D-056's phrasing: "the service
   * layer opens the transaction; repositories never do."
   *
   * OPAQUE ON PURPOSE. `TransactionToken` has no methods and nothing can be
   * queried through it; only a `*.repository.ts` can unwrap it into an
   * executor. This file can therefore carry a transaction and still cannot run
   * a statement, which is exactly what §7.4's boundary wanted.
   *
   * Absent for every ordinary caller, which is most of them — the write then
   * runs on this module's own pool as before.
   */
  readonly executor?: TransactionToken;
}

export interface LearnerService {
  createProfile(actor: LearnerActor, input: OnboardingRequest): Promise<OnboardingResult>;
  getProfile(actor: LearnerActor, studentUserId: string): Promise<StudentProfileRecord>;
  updateProfile(
    actor: LearnerActor,
    studentUserId: string,
    input: UpdateProfileRequest,
  ): Promise<StudentProfileRecord>;
  getSubjects(actor: LearnerActor, studentUserId: string): Promise<string[]>;
  getMastery(actor: LearnerActor, studentUserId: string): Promise<ChapterMasteryRecord[]>;
  /**
   * `null` when the compare-and-set was refused — the stored mastery is no
   * longer the value `input.masteryScore` was computed from. See
   * `UpdateMasteryInput.expectedPreviousScore`.
   */
  updateMastery(actor: LearnerActor, input: UpdateMasteryInput): Promise<ChapterMasteryRecord | null>;
}

/** The default onboarding values, applied when the request omits them. */
const DEFAULT_BOARD = 'CBSE';
const DEFAULT_LANGUAGE: LanguageCode = 'en';

/**
 * The message for "no profile".
 *
 * ONE message for every cause, exactly as identity uses one message for every
 * login failure. "This student has not onboarded" and "there is no such user"
 * must be indistinguishable, or a 404 becomes a way to enumerate accounts —
 * and reaching this point already means the caller passed the access check, so
 * there is no case where the extra detail helps a legitimate user.
 */
const PROFILE_NOT_FOUND = 'Profile not found.';

export function createLearnerService(deps: LearnerServiceDeps): LearnerService {
  const { repository, clock, logger } = deps;

  /**
   * Authorises one operation against one student's data.
   *
   * The link status is fetched HERE, immediately before the decision, and
   * handed to a guard built for that single call. `createAccessGuard` takes a
   * synchronous reader by design (D-001), and this is what "read at query
   * time" means in practice: no cached status, no status on the session, so a
   * revoked parent is refused on their very next request.
   *
   * A STUDENT ACTOR SKIPS THE READ ENTIRELY. Link status is meaningless for
   * them — the guard's student branch compares ids and nothing else — and
   * issuing the query anyway would put a database round trip on the hot path
   * of every single profile read in the product.
   */
  async function authorise(
    actor: LearnerActor,
    action: 'read' | 'write',
    studentUserId: string,
    scope: StudentScope,
  ): Promise<string> {
    const status =
      actor.role === 'parent' ? await deps.readLinkStatus(actor.userId, studentUserId) : null;

    /**
     * THE RESOURCE'S TENANT, RESOLVED FROM THE DATA - D-073.
     *
     * A student reaching their OWN data is short-circuited: the target is the
     * actor, so the two tenants are the same value by definition and a query
     * would put a round trip on the hot path of every profile read in the
     * product. Every other case is a real lookup.
     *
     * An unknown student resolves to the empty string, which `assertCanAccess`
     * treats as "no tenant" and DENIES. Routed through the guard rather than
     * thrown here so that "no such student" and "a student in another tenant"
     * produce byte-identical output - which they only do if both take the same
     * path.
     */
    const tenantId =
      studentUserId === actor.userId
        ? actor.tenantId
        : ((await deps.readTenantOfStudent(studentUserId)) ?? '');

    const guard = createAccessGuard({ readLinkStatus: () => status });
    guard.assertCanAccess(actor, action, {
      kind: 'student-data',
      studentUserId,
      scope,
      tenantId,
    });

    /**
     * RETURNED so that every WRITE stamps the tenant the check just passed on.
     *
     * The alternative - each write reaching for `actor.tenantId` independently -
     * would work today and would be a different value from the one authorised
     * the moment any rule allows an actor to write to a student in another
     * tenant. Returning it makes "the row is filed under the tenant that was
     * checked" true by construction rather than by coincidence.
     */
    return tenantId;
  }

  async function requireProfile(userId: string): Promise<StudentProfileRecord> {
    const profile = await repository.findProfile(userId);
    if (profile === null) {
      throw new NotFoundError(PROFILE_NOT_FOUND, {
        message: 'Learner profile not found for an authorised caller',
      });
    }
    return profile;
  }

  return {
    /**
     * §8.2 — onboarding. Creates the profile and its subjects.
     *
     * A STUDENT CREATES THEIR OWN PROFILE AND NOBODY ELSE'S. The target is
     * `actor.userId`, taken from the validated session rather than from the
     * body, so there is no field a caller could send to onboard someone else.
     * The `write` check then refuses a parent outright: the guard's rule is
     * that a parent observes and never acts on a child's behalf.
     *
     * Idempotence lives in the repository, in one transaction — see the long
     * note there on why it is `DO NOTHING` and never `DO UPDATE`.
     */
    async createProfile(actor: LearnerActor, input: OnboardingRequest): Promise<OnboardingResult> {
      const tenantId = await authorise(actor, 'write', actor.userId, 'profile');

      const result = await repository.createProfile({
        userId: actor.userId,
        tenantId,
        displayName: input.displayName,
        grade: input.grade,
        board: input.board ?? DEFAULT_BOARD,
        preferredLanguage: input.preferredLanguage ?? DEFAULT_LANGUAGE,
        // Duplicates removed before the insert: the composite primary key
        // would reject a payload listing the same subject twice, and a 409 on
        // a UI that let the user tap a chip twice is a defect report we would
        // rather not receive.
        subjects: [...new Set(input.subjects)],
        now: clock.now(),
      });

      // Deliberately logged at `info` WITHOUT the display name or any subject:
      // §11 forbids personal data in a log line, and "a student onboarded" is
      // the operationally useful half anyway.
      logger.info(
        { created: result.created, subjectCount: result.subjects.length },
        'learner.onboarding',
      );

      return result;
    },

    async getProfile(actor: LearnerActor, studentUserId: string): Promise<StudentProfileRecord> {
      await authorise(actor, 'read', studentUserId, 'profile');
      return requireProfile(studentUserId);
    },

    /**
     * §8.2 — a PATCH on an existing profile.
     *
     * `write`, so a parent is refused even for their own approved child. It is
     * the student's profile and their grade; a parent who believes it is wrong
     * asks the student to change it.
     */
    async updateProfile(
      actor: LearnerActor,
      studentUserId: string,
      input: UpdateProfileRequest,
    ): Promise<StudentProfileRecord> {
      await authorise(actor, 'write', studentUserId, 'profile');

      const updated = await repository.updateProfile({
        userId: studentUserId,
        displayName: input.displayName,
        grade: input.grade,
        preferredLanguage: input.preferredLanguage,
        now: clock.now(),
      });

      if (updated === null) {
        throw new NotFoundError(PROFILE_NOT_FOUND, {
          message: 'Profile update matched no row',
        });
      }
      return updated;
    },

    async getSubjects(actor: LearnerActor, studentUserId: string): Promise<string[]> {
      await authorise(actor, 'read', studentUserId, 'profile');
      return repository.findSubjects(studentUserId);
    },

    async getMastery(
      actor: LearnerActor,
      studentUserId: string,
    ): Promise<ChapterMasteryRecord[]> {
      // Scope `mastery` rather than `profile`: the authz table treats them as
      // separate kinds of student data, and collapsing them here would make a
      // future rule that distinguishes them impossible to express.
      await authorise(actor, 'read', studentUserId, 'mastery');
      return repository.findMastery(studentUserId);
    },

    /**
     * §8.2 — writes mastery for one chapter.
     *
     * NOT REACHABLE OVER HTTP, and that is deliberate: §8.2 lists no endpoint
     * for it. Mastery is DERIVED from practice, so the only legitimate caller
     * is the practice module submitting a session inside its own transaction.
     * A route that let a client post its own mastery would let a student
     * declare themselves expert, and would make every parent report meaningless.
     *
     * The clamp is applied here, through the domain function, before anything
     * touches the database. The CHECK constraint remains as the backstop that
     * turns a clamping bug into a loud failure rather than a mastery of 1.4 in
     * a parent report.
     */
    async updateMastery(
      actor: LearnerActor,
      input: UpdateMasteryInput,
    ): Promise<ChapterMasteryRecord | null> {
      const tenantId = await authorise(actor, 'write', input.studentUserId, 'mastery');

      const now = clock.now();
      return repository.upsertMastery({
        studentUserId: input.studentUserId,
        tenantId,
        chapterId: input.chapterId,
        masteryScore: clampMastery(input.masteryScore),
        // D-241 — the value the caller's `masteryScore` was computed from,
        // clamped identically so the comparison is against the same
        // three-decimal form the column holds rather than against a raw read.
        expectedPreviousScore:
          input.expectedPreviousScore === null ? null : clampMastery(input.expectedPreviousScore),
        // D-243 — REFUSED here rather than left to `attempts >= 0`, which only
        // fires when the result would go below zero and therefore permits a
        // decrement on any student who has practised more than once.
        attemptIncrement: assertAttemptIncrement(input.attemptIncrement ?? 1),
        // `null` leaves the existing timestamp untouched. A mastery correction
        // that is not an attempt must not claim the student practised today —
        // the streak and the "last practised" line on the parent digest both
        // read this column.
        practisedAt: (input.practised ?? true) ? now : null,
        now,
        // D-056: runs inside the caller's transaction when there is one, and on
        // this module's own pool when there is not. Spread rather than passed
        // as `undefined` so `exactOptionalPropertyTypes` stays honest about the
        // difference between "absent" and "explicitly nothing".
        ...(input.executor === undefined ? {} : { executor: input.executor }),
      });
    },
  };
}
