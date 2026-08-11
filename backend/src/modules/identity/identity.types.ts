import type { Actor, ActorRole } from '@/platform/authz/index';
import type { PlatformRole } from '@/shared/constants/roles';
import type { LinkStatusValue } from '@/shared/contracts/identity.contract';

/**
 * Internal types for the identity module. Nothing here is part of the public
 * surface except where `index.ts` re-exports it deliberately.
 */

/**
 * THE TWO ROLE LISTS ARE ONE LIST, ASSERTED RATHER THAN ASSUMED — D-293.
 *
 * `PlatformRole` is generated from `PLATFORM_ROLES`, which the `users.role`
 * CHECK constraint is also generated from; `ActorRole` is hand-written in
 * `platform/authz/can-access.ts` because that file imports nothing but its error
 * type, by rule. Two hand-kept copies of one vocabulary is exactly the drift
 * D-293 is about, so the assignment is checked HERE, at the seam where a row's
 * role becomes an actor's role, and a divergence is a compile error rather than
 * a role that silently falls through to the default deny.
 *
 * Exported so it is a used symbol rather than a local the compiler prunes. It
 * carries no runtime value and nothing imports it — the type-check IS the test.
 */
type Assert<T extends true> = T;
export type PlatformRoleFitsActorRole = Assert<PlatformRole extends ActorRole ? true : false>;

/** The subset of a user row the service is allowed to move around. */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  /**
   * EVERY role the COLUMN accepts — ten — and not the two a signup accepts.
   *
   * This describes a ROW. `Role` describes an INPUT. Conflating them is D-293:
   * the repository cast `row.role as Role` under a comment claiming the database
   * guaranteed two values, when its CHECK admits ten. See `identity.repository.ts`.
   */
  readonly role: PlatformRole;
  /** NOT NULL in the database since migration 0008 (D-073). */
  readonly tenantId: string;
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date;
  /**
   * WHEN THE SESSION WAS ISSUED — the anchor of the absolute lifetime (D-219).
   *
   * Selected on every validation, which is one more column on the hottest read
   * in the product, and worth it: without it `expires_at` is the only deadline,
   * `expires_at` slides forward on use, and a session that is used never dies.
   */
  readonly createdAt: Date;
}

/**
 * What session validation resolves to.
 *
 * `{ userId, role }` and NOTHING ELSE (§6.5, step 5). Attaching the whole user
 * row invites routes to start reading fields off it, and control over what
 * gets loaded is lost one convenient property at a time.
 */
export type SessionActor = Actor;

export interface LinkRecord {
  readonly id: string;
  readonly parentUserId: string;
  readonly studentUserId: string;
  readonly status: LinkStatusValue;
  readonly approvedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface LinkedChildRecord {
  readonly linkId: string;
  readonly studentUserId: string;
  readonly approvedAt: Date | null;
}

/**
 * Password hashing, behind an interface.
 *
 * Two reasons this is a port rather than a direct `@node-rs/argon2` call:
 *
 *  1. Argon2id at the OWASP parameters costs tens of milliseconds by design.
 *     A service test that creates twenty users would spend most of its time in
 *     the hasher, and slow tests get skipped.
 *  2. The timing-side-channel defence (§6.4, step 3) is a property of how the
 *     service USES the hasher — it must verify against a dummy hash when no
 *     user exists. That is only testable if the hasher can be observed.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  /**
   * A valid hash of a value nobody knows, used for the dummy verification on
   * a non-existent account. Must be produced with the SAME parameters as
   * `hash`, or the timing defence does not hold.
   */
  dummyHash(): Promise<string>;
}

/** Context carried from the HTTP layer into a service call. */
export interface RequestContext {
  /** The caller's IP, already hashed. Never the raw address. */
  readonly ipHash: string;
  readonly userAgent: string | null;
}

/** What a successful authentication yields. The token goes to a cookie only. */
export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface AuthenticatedResult {
  readonly user: UserRecord;
  readonly session: IssuedSession;
}
