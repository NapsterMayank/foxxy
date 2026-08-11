import { and, eq, or, sql } from 'drizzle-orm';
import type { DbExecutor, DbHandle } from '@/platform/db/index';
import { schema } from '@/platform/db/index';
import { ConflictError } from '@/platform/errors/index';
import type { LinkStatusValue, Role } from '@/shared/contracts/identity.contract';
import type { LinkRecord, LinkedChildRecord, SessionRecord, UserRecord } from './identity.types';

/**
 * ALL database access for the identity module — §7, rule 4.
 *
 * Enforced by ESLint: `@/platform/db` and `drizzle-orm` are importable only
 * from a `*.repository.ts` file. Without that rule someone eventually writes a
 * query that skips the authorization check.
 *
 * Two consequences of the rule that shape this file:
 *
 *  - Every multi-statement operation that must be atomic is exposed as ONE
 *    repository method that opens the transaction internally. The service
 *    cannot call `withTransaction` itself, and that is the point: transaction
 *    boundaries are visible in one file rather than scattered through
 *    use-cases.
 *  - No business rules live here. The repository builds queries and maps rows.
 *    Anything that decides something belongs in `domain/` or the service.
 */

const {
  users,
  sessions,
  emailVerificationTokens,
  passwordResetTokens,
  parentChildLinks,
  linkCodes,
} = schema;

/**
 * The database handle, re-exported under a module-local name.
 *
 * `index.ts` needs this type to declare its dependencies, but the ESLint
 * boundary rule bans `@/platform/db` outside a `*.repository.ts` file — and it
 * bans type imports too, which is right: a type import is how a repository's
 * responsibilities start leaking into files that should not have them. Naming
 * it here keeps the one legitimate use legal without adding an exception to
 * the rule.
 */
export type IdentityDbHandle = DbHandle;

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  tenantId: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    // The column carries a CHECK constraint limiting it to these two values,
    // so the database is the guarantee behind this narrowing.
    role: row.role as Role,
    // NOT NULL since migration 0008 (D-073), so this is never null in a row
    // that exists. It is carried on the record rather than looked up later
    // because the ACTOR's tenant is one half of every authorisation decision,
    // and a second query for it is a second chance to forget.
    tenantId: row.tenantId,
    emailVerifiedAt: row.emailVerifiedAt,
    createdAt: row.createdAt,
  };
}

interface LinkRow {
  id: string;
  parentUserId: string;
  studentUserId: string;
  status: string;
  approvedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

function toLinkRecord(row: LinkRow): LinkRecord {
  return {
    id: row.id,
    parentUserId: row.parentUserId,
    studentUserId: row.studentUserId,
    status: row.status as LinkStatusValue,
    approvedAt: row.approvedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export interface CreateUserInput {
  readonly email: string;
  readonly passwordHash: string;
  readonly role: Role;
  /**
   * REQUIRED, and never taken from the request body (D-073).
   *
   * Signup is the one insert path with no authenticated actor to inherit a
   * tenant from, so the value comes from configuration — the tenant this
   * deployment serves — and is threaded through the service explicitly. It is
   * NOT left to the column default: a default cannot distinguish "not supplied"
   * from "supplied and equal to the default", so leaning on it would mean the
   * day a second tenant exists, every signup silently lands in the first.
   */
  readonly tenantId: string;
}

export interface CreateTokenInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  /**
   * Supplied by the caller from the INJECTED CLOCK, never left to the column
   * default.
   *
   * `last_used_at` defaults to the database's `now()`. Sliding renewal
   * compares it against the application's clock, so allowing the default would
   * have two different clocks on either side of one comparison. In production
   * they agree to within milliseconds and nothing is ever noticed; under a
   * `FixedClock` they disagree by months and renewal silently stops happening.
   * A test caught this. Nothing in production would have.
   */
  readonly lastUsedAt: Date;
  /**
   * ALSO from the injected clock, and for a second, sharper reason — D-219.
   *
   * `created_at` is now the anchor of the ABSOLUTE session lifetime: every
   * validation asks whether `created_at + 30 days` has passed. Left to the
   * column default it would carry the DATABASE's `now()` while the comparison
   * used the application's, which is the exact two-clocks bug the note on
   * `lastUsedAt` above describes — except that here the failure is a session
   * that never expires rather than one that never renews, and no test could
   * observe it under a `FixedClock` because the anchor would always sit in the
   * future.
   */
  readonly createdAt: Date;
  readonly ipHash: string | null;
  readonly userAgent: string | null;
}

export interface IssueLinkCodeInput {
  readonly studentUserId: string;
  /** Generated by the caller — randomness lives at the module edge, not here. */
  readonly code: string;
  readonly expiresAt: Date;
  /** From the INJECTED clock. Never the database's `now()` — see D-019. */
  readonly now: Date;
}

export interface IssuedLinkCode {
  readonly id: string;
  readonly studentUserId: string;
  readonly code: string;
  readonly expiresAt: Date;
}

export interface ConsumedLinkCode {
  readonly id: string;
  readonly studentUserId: string;
  readonly code: string;
}

export interface SessionWithUser {
  readonly session: SessionRecord;
  readonly userId: string;
  readonly role: Role;
  /** The actor's tenant, joined from `users`. Half of every authz decision. */
  readonly tenantId: string;
}

export interface IdentityRepository {
  createUser(input: CreateUserInput): Promise<UserRecord>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  /**
   * The tenant a user belongs to, or null when there is no such user.
   *
   * THE RESOURCE SIDE of the tenant comparison, for the cases where the target
   * is somebody other than the caller — a parent reading a child. It reads
   * `users`, which is the authoritative copy, rather than a denormalised copy on
   * a student row that may not exist yet.
   *
   * A missing user returns null, which `assertCanAccess` turns into a deny. That
   * is deliberate: "no such account" and "an account in another tenant" must be
   * indistinguishable, or this becomes an enumeration oracle.
   */
  findUserTenant(userId: string): Promise<string | null>;

  createEmailVerificationToken(input: CreateTokenInput): Promise<void>;
  consumeEmailVerificationToken(tokenHash: string, now: Date): Promise<string | null>;

  createPasswordResetToken(input: CreateTokenInput): Promise<void>;
  resetPasswordWithToken(input: {
    tokenHash: string;
    newPasswordHash: string;
    now: Date;
  }): Promise<string | null>;

  createSession(input: CreateSessionInput): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionWithUser | null>;
  renewSession(sessionId: string, lastUsedAt: Date, expiresAt: Date): Promise<void>;
  deleteSessionByTokenHash(tokenHash: string): Promise<void>;
  deleteAllSessionsForUser(userId: string): Promise<number>;

  /**
   * Issues a link code for a student, replacing any code they already hold.
   * Resolves D-012 — codes are durable rows, not cache entries.
   */
  issueLinkCode(input: IssueLinkCodeInput): Promise<IssuedLinkCode>;
  /**
   * Consumes a code and returns whose it was, or null when it is unknown,
   * already spent, or expired.
   */
  consumeLinkCode(input: { code: string; now: Date }): Promise<ConsumedLinkCode | null>;
  /** The student's live code, if they have one. Read-only; for "show it again". */
  findActiveLinkCodeForStudent(
    studentUserId: string,
    now: Date,
  ): Promise<IssuedLinkCode | null>;

  /**
   * The deprecated `codeExpiresAt` parameter is GONE (open item 4).
   *
   * `parent_child_links.code_expires_at` was dropped in migration 0001 —
   * expiry belongs to the code, and the code has its own table. The parameter
   * survived one release as an ignored argument so the service kept compiling;
   * the service no longer passes it, so it is removed rather than left as a
   * lie that type-checks.
   */
  upsertPendingLink(input: {
    parentUserId: string;
    studentUserId: string;
    linkCode: string;
    /** From the authenticated parent. The service refuses a cross-tenant pair. */
    tenantId: string;
  }): Promise<LinkRecord>;
  findLinkById(id: string): Promise<LinkRecord | null>;
  findLinkStatus(parentUserId: string, studentUserId: string): Promise<LinkStatusValue | null>;
  approveLink(id: string, studentUserId: string, now: Date): Promise<LinkRecord | null>;
  revokeLink(id: string, actorUserId: string, now: Date): Promise<LinkRecord | null>;
  listApprovedChildren(parentUserId: string): Promise<LinkedChildRecord[]>;
}

export function createIdentityRepository(handle: DbHandle): IdentityRepository {
  const db = handle.db;

  /**
   * Retire the outstanding code and insert the new one, in ONE transaction.
   *
   * Split out of the method purely so the unique-violation translation can wrap
   * it without an extra level of indentation. The transaction boundary is the
   * point: a crash between the two statements would leave the student with no
   * active code and a row that blocks every future insert — permanently,
   * silently, and only for that one student.
   */
  function issueLinkCodeInTransaction(input: IssueLinkCodeInput): Promise<IssuedLinkCode> {
    return handle.withTransaction(async (tx: DbExecutor) => {
      await tx
        .update(linkCodes)
        .set({ consumedAt: input.now })
        .where(
          and(eq(linkCodes.studentUserId, input.studentUserId), sql`${linkCodes.consumedAt} is null`),
        );

      const rows = await tx
        .insert(linkCodes)
        .values({
          studentUserId: input.studentUserId,
          code: input.code,
          expiresAt: input.expiresAt,
        })
        .returning({
          id: linkCodes.id,
          studentUserId: linkCodes.studentUserId,
          code: linkCodes.code,
          expiresAt: linkCodes.expiresAt,
        });

      const row = rows[0];
      if (row === undefined) {
        throw new ConflictError('Could not issue a link code.', {
          message: 'insert into link_codes returned no row',
        });
      }
      return row;
    });
  }

  return {
    /**
     * §6.2, step 5 — the race.
     *
     * Two simultaneous signups with the same address both pass an existence
     * check. There is no pre-check here at all: the UNIQUE constraint is the
     * real protection, and the violation is translated into a typed
     * ConflictError for the service to handle.
     */
    async createUser(input: CreateUserInput): Promise<UserRecord> {
      try {
        const rows = await db
          .insert(users)
          .values({
            email: input.email,
            passwordHash: input.passwordHash,
            role: input.role,
            // EXPLICIT, never left to the column default — see CreateUserInput.
            tenantId: input.tenantId,
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new ConflictError('Could not create the account.', {
            message: 'insert into users returned no row',
          });
        }
        return toUserRecord(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError('Could not create the account.', {
            message: 'users_email_unique violated',
            cause: error,
          });
        }
        throw error;
      }
    },

    async findUserByEmail(email: string): Promise<UserRecord | null> {
      // `email` is citext, so this comparison is case-insensitive in the
      // database as well as normalised in the application.
      const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
      const row = rows[0];
      return row === undefined ? null : toUserRecord(row);
    },

    async findUserById(id: string): Promise<UserRecord | null> {
      const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
      const row = rows[0];
      return row === undefined ? null : toUserRecord(row);
    },

    async findUserTenant(userId: string): Promise<string | null> {
      const rows = await db
        .select({ tenantId: users.tenantId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0]?.tenantId ?? null;
    },

    async createEmailVerificationToken(input: CreateTokenInput): Promise<void> {
      await db.insert(emailVerificationTokens).values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      });
    },

    /**
     * §6.3 — single use, consumed in the SAME transaction that sets
     * `email_verified_at`.
     *
     * `FOR UPDATE` on the token row serialises two concurrent redemptions of
     * the same link, so the second one sees `consumed_at` already set and the
     * conditional UPDATE matches nothing. Without the lock both could read
     * "unconsumed" before either wrote.
     *
     * Returns the user id on success, or null when the token is unknown,
     * already consumed, or expired — three cases the caller must not be able to
     * tell apart.
     */
    consumeEmailVerificationToken(tokenHash: string, now: Date): Promise<string | null> {
      return handle.withTransaction(async (tx: DbExecutor) => {
        const locked = await tx
          .select({
            id: emailVerificationTokens.id,
            userId: emailVerificationTokens.userId,
            expiresAt: emailVerificationTokens.expiresAt,
            consumedAt: emailVerificationTokens.consumedAt,
          })
          .from(emailVerificationTokens)
          .where(eq(emailVerificationTokens.tokenHash, tokenHash))
          .limit(1)
          .for('update');

        const row = locked[0];
        if (row === undefined) return null;
        if (row.consumedAt !== null) return null;
        // Boundary convention matches domain/token.ts#isExpired: expiry at
        // exactly `now` counts as expired.
        if (row.expiresAt.getTime() <= now.getTime()) return null;

        await tx
          .update(emailVerificationTokens)
          .set({ consumedAt: now })
          .where(eq(emailVerificationTokens.id, row.id));

        await tx
          .update(users)
          .set({ emailVerifiedAt: now })
          .where(and(eq(users.id, row.userId), sql`${users.emailVerifiedAt} is null`));

        return row.userId;
      });
    },

    async createPasswordResetToken(input: CreateTokenInput): Promise<void> {
      await db.insert(passwordResetTokens).values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      });
    },

    /**
     * §6.7 — verify, hash, update, DELETE EVERY SESSION, consume. One
     * transaction.
     *
     * The session deletion is the part that matters. If the reset was
     * triggered by a compromise, leaving old sessions alive defeats the whole
     * exercise — the attacker simply keeps using the session they already
     * have. Doing it in a separate statement outside the transaction leaves a
     * window where the password is new and the attacker's session is not yet
     * gone.
     *
     * Every outstanding reset token for the user is consumed too, not just the
     * one presented: after a successful reset, a token mailed earlier must not
     * still work.
     */
    resetPasswordWithToken(input: {
      tokenHash: string;
      newPasswordHash: string;
      now: Date;
    }): Promise<string | null> {
      return handle.withTransaction(async (tx: DbExecutor) => {
        const locked = await tx
          .select({
            id: passwordResetTokens.id,
            userId: passwordResetTokens.userId,
            expiresAt: passwordResetTokens.expiresAt,
            consumedAt: passwordResetTokens.consumedAt,
          })
          .from(passwordResetTokens)
          .where(eq(passwordResetTokens.tokenHash, input.tokenHash))
          .limit(1)
          .for('update');

        const row = locked[0];
        if (row === undefined) return null;
        if (row.consumedAt !== null) return null;
        if (row.expiresAt.getTime() <= input.now.getTime()) return null;

        await tx
          .update(users)
          .set({ passwordHash: input.newPasswordHash })
          .where(eq(users.id, row.userId));

        await tx.delete(sessions).where(eq(sessions.userId, row.userId));

        await tx
          .update(passwordResetTokens)
          .set({ consumedAt: input.now })
          .where(
            and(
              eq(passwordResetTokens.userId, row.userId),
              sql`${passwordResetTokens.consumedAt} is null`,
            ),
          );

        return row.userId;
      });
    },

    async createSession(input: CreateSessionInput): Promise<void> {
      await db.insert(sessions).values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        lastUsedAt: input.lastUsedAt,
        createdAt: input.createdAt,
        ipHash: input.ipHash,
        userAgent: input.userAgent,
      });
    },

    /**
     * The session lookup on every authenticated request. One indexed read
     * against `sessions_token_hash_unique`, joined to the user for the role.
     *
     * The user's email, password hash and everything else are deliberately NOT
     * selected — only what `{ userId, role }` needs (§6.5, step 5).
     */
    async findSessionByTokenHash(tokenHash: string): Promise<SessionWithUser | null> {
      const rows = await db
        .select({
          id: sessions.id,
          userId: sessions.userId,
          expiresAt: sessions.expiresAt,
          lastUsedAt: sessions.lastUsedAt,
          // THE ABSOLUTE-LIFETIME ANCHOR (D-219). `expires_at` slides forward
          // on every renewal; this does not, and it is the only column that can
          // answer "how old is this credential".
          createdAt: sessions.createdAt,
          role: users.role,
          // Joined here rather than fetched on demand: every authenticated
          // request needs the actor's tenant, and this join already exists.
          tenantId: users.tenantId,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1);

      const row = rows[0];
      if (row === undefined) return null;

      return {
        session: {
          id: row.id,
          userId: row.userId,
          expiresAt: row.expiresAt,
          lastUsedAt: row.lastUsedAt,
          createdAt: row.createdAt,
        },
        userId: row.userId,
        role: row.role as Role,
        tenantId: row.tenantId,
      };
    },

    async renewSession(sessionId: string, lastUsedAt: Date, expiresAt: Date): Promise<void> {
      await db.update(sessions).set({ lastUsedAt, expiresAt }).where(eq(sessions.id, sessionId));
    },

    async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    },

    /** §6.6 — "sign out everywhere". Returns how many were removed. */
    async deleteAllSessionsForUser(userId: string): Promise<number> {
      const removed = await db
        .delete(sessions)
        .where(eq(sessions.userId, userId))
        .returning({ id: sessions.id });
      return removed.length;
    },

    /**
     * §6.8, step 1 — the student issues a code. Resolves D-012.
     *
     * "One active code per student" is a PARTIAL UNIQUE INDEX on
     * `student_user_id WHERE consumed_at IS NULL`, so the rule is the
     * database's, not this function's. What this function must therefore do is
     * retire the previous code before inserting the new one, and do both in
     * ONE transaction — otherwise a crash between the two statements leaves
     * the student with no code and no way to get one, permanently, because
     * every subsequent insert violates the index.
     *
     * Retiring means `consumed_at = now`, never `DELETE`. The row is the audit
     * record of a code that was issued, and the partial index ignores it once
     * it is marked spent.
     */
    async issueLinkCode(input: IssueLinkCodeInput): Promise<IssuedLinkCode> {
      try {
        return await issueLinkCodeInTransaction(input);
      } catch (error) {
        // TWO ISSUE REQUESTS RACING, or the astronomically unlikely code
        // collision. The retire-then-insert above is one transaction, so the
        // loser's insert waits on the partial unique index and then fails with
        // 23505 — the index IS the "one active code per student" rule (D-021),
        // and this is what that rule looks like when it fires.
        //
        // Translated rather than left raw: a bare pg error reaches the client
        // as a 500, which says "we are broken" about a request whose honest
        // answer is "you already asked; try again".
        if (isUniqueViolation(error)) {
          throw new ConflictError('Could not issue a link code. Please try again.', {
            message: 'link_codes unique index violated — concurrent issue for one student',
            cause: error,
          });
        }
        throw error;
      }
    },

    /**
     * §6.8, step 3 — the parent submits the code.
     *
     * `FOR UPDATE` and the conditional consume are the same pattern as email
     * verification, for the same reason: two parents racing on one code must
     * not both win. The lock serialises them, and the second finds
     * `consumed_at` already set.
     *
     * Unknown, spent and expired all return null. The caller must not be able
     * to tell them apart — "that code exists but has expired" tells a brute
     * forcer that they have found a real code, which is most of the work.
     */
    consumeLinkCode(input: { code: string; now: Date }): Promise<ConsumedLinkCode | null> {
      return handle.withTransaction(async (tx: DbExecutor) => {
        const locked = await tx
          .select({
            id: linkCodes.id,
            studentUserId: linkCodes.studentUserId,
            code: linkCodes.code,
            expiresAt: linkCodes.expiresAt,
            consumedAt: linkCodes.consumedAt,
          })
          .from(linkCodes)
          .where(eq(linkCodes.code, input.code))
          .limit(1)
          .for('update');

        const row = locked[0];
        if (row === undefined) return null;
        if (row.consumedAt !== null) return null;
        // Same boundary convention as domain/token.ts#isExpired: expiry at
        // exactly `now` counts as expired.
        if (row.expiresAt.getTime() <= input.now.getTime()) return null;

        await tx
          .update(linkCodes)
          .set({ consumedAt: input.now })
          .where(eq(linkCodes.id, row.id));

        return { id: row.id, studentUserId: row.studentUserId, code: row.code };
      });
    },

    /** Read-only. An expired-but-unconsumed row is not an active code. */
    async findActiveLinkCodeForStudent(
      studentUserId: string,
      now: Date,
    ): Promise<IssuedLinkCode | null> {
      const rows = await db
        .select({
          id: linkCodes.id,
          studentUserId: linkCodes.studentUserId,
          code: linkCodes.code,
          expiresAt: linkCodes.expiresAt,
        })
        .from(linkCodes)
        .where(
          and(
            eq(linkCodes.studentUserId, studentUserId),
            sql`${linkCodes.consumedAt} is null`,
            sql`${linkCodes.expiresAt} > ${now}`,
          ),
        )
        .limit(1);

      return rows[0] ?? null;
    },

    /**
     * §6.8, step 4 — create the link with status `pending`.
     *
     * A row may already exist for this pair, because the table carries a
     * UNIQUE on (parent_user_id, student_user_id). The `ON CONFLICT` behaviour
     * encodes one rule and one rule only, which is worth stating precisely:
     *
     *   - `revoked` -> back to `pending`. A revocation is not a permanent ban;
     *     the pair may link again, and the STUDENT must approve again.
     *   - `pending` -> stays `pending`, code and expiry refreshed. Submitting
     *     twice is idempotent, not an error.
     *   - `approved` -> LEFT ALONE. Re-submitting a code must never re-open or
     *     disturb a live, consented link.
     *
     * The `where` clause is what protects the approved case; without it the
     * upsert would silently reset a consented link to pending.
     */
    async upsertPendingLink(input: {
      parentUserId: string;
      studentUserId: string;
      linkCode: string;
      tenantId: string;
    }): Promise<LinkRecord> {
      const rows = await db
        .insert(parentChildLinks)
        .values({
          parentUserId: input.parentUserId,
          studentUserId: input.studentUserId,
          status: 'pending',
          linkCode: input.linkCode,
          // The service has already refused a parent and student in different
          // tenants, so this one value is correct for both parties.
          tenantId: input.tenantId,
        })
        .onConflictDoUpdate({
          target: [parentChildLinks.parentUserId, parentChildLinks.studentUserId],
          set: {
            status: 'pending',
            linkCode: input.linkCode,
            approvedAt: null,
            revokedAt: null,
          },
          where: sql`${parentChildLinks.status} <> 'approved'`,
        })
        .returning();

      const row = rows[0];
      if (row !== undefined) return toLinkRecord(row);

      // The conflict target matched but the `where` suppressed the update:
      // the pair is already approved. Return the live row untouched.
      const existing = await db
        .select()
        .from(parentChildLinks)
        .where(
          and(
            eq(parentChildLinks.parentUserId, input.parentUserId),
            eq(parentChildLinks.studentUserId, input.studentUserId),
          ),
        )
        .limit(1);

      const current = existing[0];
      if (current === undefined) {
        throw new ConflictError('Could not create the link.', {
          message: 'upsertPendingLink matched a conflict but no row could be read back',
        });
      }
      return toLinkRecord(current);
    },

    async findLinkById(id: string): Promise<LinkRecord | null> {
      const rows = await db
        .select()
        .from(parentChildLinks)
        .where(eq(parentChildLinks.id, id))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toLinkRecord(row);
    },

    /**
     * §6.8, step 7 and §7, rule 3 — status is read AT QUERY TIME.
     *
     * Never cached in the session, never resolved at login. Revocation has to
     * be immediate, and it only is if every read comes back here.
     */
    async findLinkStatus(
      parentUserId: string,
      studentUserId: string,
    ): Promise<LinkStatusValue | null> {
      const rows = await db
        .select({ status: parentChildLinks.status })
        .from(parentChildLinks)
        .where(
          and(
            eq(parentChildLinks.parentUserId, parentUserId),
            eq(parentChildLinks.studentUserId, studentUserId),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : (row.status as LinkStatusValue);
    },

    /**
     * §6.8, steps 5 and 6 — THE STUDENT approves.
     *
     * `student_user_id` is part of the WHERE clause, not checked beforehand,
     * so the write itself is the authorization: there is no window between a
     * check and an update, and no path where a different user's approval could
     * land. `status = 'pending'` in the same clause makes approval single-shot.
     */
    async approveLink(id: string, studentUserId: string, now: Date): Promise<LinkRecord | null> {
      const rows = await db
        .update(parentChildLinks)
        .set({ status: 'approved', approvedAt: now, revokedAt: null })
        .where(
          and(
            eq(parentChildLinks.id, id),
            eq(parentChildLinks.studentUserId, studentUserId),
            eq(parentChildLinks.status, 'pending'),
          ),
        )
        .returning();
      const row = rows[0];
      return row === undefined ? null : toLinkRecord(row);
    },

    /**
     * §6.8, step 7 — EITHER party may revoke, and it is immediate.
     *
     * The `or` on the two id columns is the "either party" rule expressed as a
     * predicate on the write. A revoked row stays revoked; re-revoking matches
     * nothing and the service reports the current state.
     *
     * The link code is cleared at the same time: a revoked link must not leave
     * a usable code behind.
     */
    async revokeLink(id: string, actorUserId: string, now: Date): Promise<LinkRecord | null> {
      const rows = await db
        .update(parentChildLinks)
        .set({ status: 'revoked', revokedAt: now, linkCode: null })
        .where(
          and(
            eq(parentChildLinks.id, id),
            or(
              eq(parentChildLinks.parentUserId, actorUserId),
              eq(parentChildLinks.studentUserId, actorUserId),
            ),
            sql`${parentChildLinks.status} <> 'revoked'`,
          ),
        )
        .returning();
      const row = rows[0];
      return row === undefined ? null : toLinkRecord(row);
    },

    /** Approved links only. A pending or revoked link is not a child. */
    async listApprovedChildren(parentUserId: string): Promise<LinkedChildRecord[]> {
      const rows = await db
        .select({
          linkId: parentChildLinks.id,
          studentUserId: parentChildLinks.studentUserId,
          approvedAt: parentChildLinks.approvedAt,
        })
        .from(parentChildLinks)
        .where(
          and(
            eq(parentChildLinks.parentUserId, parentUserId),
            eq(parentChildLinks.status, 'approved'),
          ),
        )
        .orderBy(parentChildLinks.approvedAt);

      return rows.map((row) => ({
        linkId: row.linkId,
        studentUserId: row.studentUserId,
        approvedAt: row.approvedAt,
      }));
    },
  };
}
