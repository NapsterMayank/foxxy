import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { Clock } from '@/platform/clock/index';
import type { Logger } from '@/platform/logger/index';
import { createLearnerRepository, type LearnerDbHandle } from './learner.repository';
import { registerLearnerRoutes } from './learner.routes';
import { createLearnerService, type LearnerService } from './learner.service';
import type { LinkStatusReader, TenantReader } from './learner.types';

/**
 * ============================================================================
 * learner — THE PUBLIC SURFACE.
 *
 * This is the only file another module may import (00-ARCHITECTURE.md,
 * Foundation 1, enforced by ESLint `no-restricted-imports`). Everything else
 * in this directory is private.
 *
 * Owns: the student profile, the subjects they study, and their mastery per
 * chapter (plan §8.2). Calls no other module — the one thing it needs from
 * identity, the parent-child link status, arrives as an injected function so
 * that the cross-module edge lives in `app/routes.ts` and nowhere else.
 * ============================================================================
 *
 * THE TWO THINGS ABOUT THIS MODULE MOST LIKELY TO BE UNDONE BY ACCIDENT.
 *
 * 1. `gradeSchema` IN THE CONTRACT IS THE ONLY ENFORCEMENT OF "GRADE 6 AS A
 *    NUMBER IS REJECTED" (§8.2). The `grade` column is text with a CHECK, and
 *    a test proves that CHECK cannot see the caller's type: Postgres
 *    assignment-casts an integer 6 to '6' silently, so `values (6)` succeeds
 *    (D-038). Anyone who reads the CHECK, concludes the case is covered and
 *    simplifies the Zod schema to `z.string()` — or removes it — reopens the
 *    hole, and the resulting failure is an empty question list for one cohort
 *    rather than an error. The full note is in
 *    `shared/contracts/learner.contract.ts`, beside the schema.
 *
 * 2. ONBOARDING IS `ON CONFLICT DO NOTHING`, NEVER `DO UPDATE`. A retry of the
 *    first screen after email verification must not re-write the profile from
 *    a stale cached request — that silently moves a student back to last
 *    term's grade and changes every chapter they see. The note is on
 *    `createProfile` in the repository.
 */

export interface LearnerModuleDeps {
  /** §3.1: learner is ordinary request traffic and gets the `core` pool. */
  readonly db: LearnerDbHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Identity's session validator, passed in rather than imported.
   *
   * The alternative — this module importing `@/modules/identity` — would make
   * the dependency real and invisible. Injected, it stays declared in one
   * place (`app/routes.ts`), which is also the complete list of who depends on
   * whom.
   */
  readonly requireSession: preHandlerAsyncHookHandler;
  /**
   * The CURRENT parent-child link status, read per authorization decision.
   *
   * §7 rule 3: never cached on the session, so a revocation takes effect on
   * the next request rather than at the next login.
   */
  readonly readLinkStatus: LinkStatusReader;
  /**
   * The tenant a student's account belongs to - D-073.
   *
   * Injected for the same reason as `readLinkStatus`: `users` is identity's
   * table, and the cross-module edge belongs in `app/routes.ts`.
   */
  readonly readTenantOfStudent: TenantReader;
}

export interface LearnerModule {
  /** Every learner use-case. The only object other modules should hold. */
  readonly service: LearnerService;
  /** Registers the four `/me/…` endpoints under `/api/v1`. */
  registerRoutes(app: FastifyInstance): void;
}

export function createLearnerModule(deps: LearnerModuleDeps): LearnerModule {
  const service = createLearnerService({
    repository: createLearnerRepository(deps.db),
    clock: deps.clock,
    logger: deps.logger,
    readLinkStatus: deps.readLinkStatus,
    readTenantOfStudent: deps.readTenantOfStudent,
  });

  return {
    service,
    registerRoutes(app: FastifyInstance): void {
      registerLearnerRoutes(app, { service, requireSession: deps.requireSession });
    },
  };
}

/**
 * ---------------------------------------------------------------------------
 * The use-cases, as named in §8.2. Each is reached through `module.service`,
 * and each calls `assertCanAccess` before it touches anything.
 *
 *   createProfile    Onboarding. Creates the profile AND its subjects in one
 *                    transaction, idempotently. A second call changes nothing
 *                    and reports `created: false`.
 *   getProfile       One student's profile. A student may read their own; a
 *                    parent may read an APPROVED child's; nobody else may.
 *   updateProfile    A partial update, by the student only. A parent observes
 *                    and never acts on a child's behalf.
 *   getSubjects      The subjects a student studies.
 *   getMastery       Mastery per chapter, for the progress screen.
 *   updateMastery    Writes mastery for one chapter, clamped to 0..1. NO
 *                    ENDPOINT, deliberately — mastery is derived from
 *                    practice, and a route would let a student declare
 *                    themselves expert.
 * ---------------------------------------------------------------------------
 */
export type { LearnerService, UpdateMasteryInput } from './learner.service';

/** A student profile and one chapter's mastery, as other modules see them. */
export type {
  ChapterMasteryRecord,
  LinkStatusReader,
  OnboardingResult,
  StudentProfileRecord,
  TenantReader,
} from './learner.types';
