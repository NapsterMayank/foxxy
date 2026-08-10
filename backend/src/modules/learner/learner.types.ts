import type { Actor, LinkStatus } from '@/platform/authz/index';
import type { Grade, LanguageCode } from '@/shared/constants/curriculum';

/**
 * Internal types for the learner module. Nothing here is public except where
 * `index.ts` re-exports it deliberately.
 */

/** The authenticated caller: `{ userId, role }`, never a user row. */
export type LearnerActor = Actor;

/** A student profile as the service moves it around. */
export interface StudentProfileRecord {
  readonly userId: string;
  /** A STRING, "6".."12". Never a number — see `gradeSchema` in the contract. */
  readonly grade: Grade;
  readonly displayName: string;
  readonly board: string;
  readonly preferredLanguage: LanguageCode;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ChapterMasteryRecord {
  readonly chapterId: string;
  /** 0..1, already converted out of the `numeric` column's string form. */
  readonly masteryScore: number;
  readonly attempts: number;
  readonly lastPractisedAt: Date | null;
  readonly updatedAt: Date;
}

/** What onboarding did, so a caller can tell a fresh setup from a repeat. */
export interface OnboardingResult {
  readonly profile: StudentProfileRecord;
  readonly subjects: readonly string[];
  /** `false` when the profile already existed and nothing was changed. */
  readonly created: boolean;
}

/**
 * Reads the CURRENT link status between a parent and a student.
 *
 * INJECTED, not imported from `identity`, for two reasons that both matter.
 *
 * The first is the one §7 rule 3 states: status must be read AT QUERY TIME,
 * never taken from the session, so that a revocation takes effect on the very
 * next request rather than at the next login.
 *
 * The second is architectural. Wiring it at the composition root
 * (`app/routes.ts`) instead of importing `@/modules/identity` from inside this
 * module keeps the cross-module dependency graph greppable in ONE file. A
 * module that reaches for another module's index "just for this one lookup"
 * is how a modular monolith becomes a monolith.
 */
export type LinkStatusReader = (
  parentUserId: string,
  studentUserId: string,
) => Promise<LinkStatus | null>;

/**
 * Reads the TENANT a student's account belongs to, or null when there is no
 * such account - D-073.
 *
 * INJECTED for the same two reasons as `LinkStatusReader` above: `users` is
 * identity's table, and every cross-module edge belongs in `app/routes.ts`
 * rather than in an import from inside this module.
 *
 * IT IS THE RESOURCE SIDE of the tenant comparison, and it must never be
 * satisfied by handing back the actor's own tenant. That would compare a value
 * with itself - a check that can never fail, wearing the shape of one that
 * sometimes does. The service short-circuits only the case where the target IS
 * the actor, where the two are the same value by definition.
 *
 * A missing account returns null, which the service turns into a DENY through
 * the guard. "No such student" and "a student in another tenant" must be
 * indistinguishable to the caller, or this becomes an enumeration oracle.
 */
export type TenantReader = (studentUserId: string) => Promise<string | null>;
