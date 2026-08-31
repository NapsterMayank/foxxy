/**
 * GENERATED — DO NOT EDIT.
 *
 * Source of truth: backend/src/shared/. Regenerate with
 * `npm run contracts:sync` from `admin/`. `contracts-drift.test.ts`
 * fails when this file and its backend original disagree.
 */

/**
 * The role vocabulary — the full set the database will ever hold, and the much
 * smaller set a person may sign themselves up as.
 *
 * 05-ROADMAP.md §8 lists "role enum, `schools`/`classes` stub, `audit_log`" as
 * a Phase 0 hook at 3 days now against roughly 8 days plus a live-data
 * migration later. Widening a CHECK constraint on `users.role` is free while
 * the table is small and is a locking DDL change on a live table afterwards.
 *
 * ===========================================================================
 * THE TWO LISTS ARE NOT THE SAME LIST, AND THAT IS THE POINT.
 *
 * `PLATFORM_ROLES` is what the COLUMN accepts. It is wide today so that adding
 * a teacher in Phase 1 or a content author in Phase 4 is an INSERT rather than
 * a migration.
 *
 * `SIGNUP_ROLES` is what a SELF-SERVICE SIGNUP accepts, and it is exactly
 * `student` and `parent`. Every other role is granted by somebody — a school
 * administrator, an internal operator — and never claimed. A public endpoint
 * that accepted `role: 'super_admin'` would be a privilege-escalation hole
 * opened by a dropdown.
 *
 * The separation is enforced by `roleSchema` in the identity contract, which
 * is built from `SIGNUP_ROLES`, NOT from `PLATFORM_ROLES`. Widening the column
 * therefore cannot widen signup by accident: they are different constants, and
 * a test asserts that signup rejects every role outside `SIGNUP_ROLES`.
 *
 * WHY THAT TEST EXISTS RATHER THAN JUST THE TYPE. The contract is Zod; the
 * column is a CHECK. The day somebody "tidies up" by pointing `roleSchema` at
 * `PLATFORM_ROLES` — which reads like an obvious simplification — nothing fails
 * to compile and nothing fails to insert. Only the test notices.
 */

/**
 * Every role `users.role` will accept. The order is roughly the order the
 * roadmap introduces them, not a privilege ordering — there is no ordering
 * here, and any code that infers one is wrong.
 */
export const PLATFORM_ROLES = [
  // Phase 0 — live today.
  'student',
  'parent',
  // Phase 1 — teacher experience.
  'teacher',
  // Phase 4 — school leadership, internal roles, content workflow.
  'principal',
  'content_author',
  'academic_reviewer',
  'implementation_manager',
  'support_agent',
  'school_success',
  'super_admin',
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/**
 * The roles a person may create for themselves. TWO, and it stays two until a
 * deliberate product decision says otherwise.
 */
export const SIGNUP_ROLES = ['student', 'parent'] as const;

export type SignupRole = (typeof SIGNUP_ROLES)[number];

export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === 'string' && (PLATFORM_ROLES as readonly string[]).includes(value);
}

export function isSignupRole(value: unknown): value is SignupRole {
  return typeof value === 'string' && (SIGNUP_ROLES as readonly string[]).includes(value);
}
