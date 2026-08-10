import type { Actor } from '@/platform/authz/index';
import type { LinkStatusValue, Role } from '@/shared/contracts/identity.contract';

/**
 * Internal types for the identity module. Nothing here is part of the public
 * surface except where `index.ts` re-exports it deliberately.
 */

/** The subset of a user row the service is allowed to move around. */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: Role;
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
