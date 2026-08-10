import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { PLATFORM_ROLES } from '../../../shared/constants/roles';
import { citext } from '../column-types';
import { DEFAULT_TENANT_ID, tenants } from './tenants';

const platformRoleList = sql.raw(PLATFORM_ROLES.map((role) => `'${role}'`).join(', '));

/**
 * identity schema — 01-BACKEND-IMPLEMENTATION-PLAN.md §4, "identity".
 *
 * One row per human. `role` is fixed at signup and never changes; a person
 * who is both a parent and a student holds two accounts.
 *
 * ===========================================================================
 * `role` ACCEPTS TEN VALUES; SIGNUP ACCEPTS TWO.
 *
 * The CHECK was `in ('student', 'parent')` and is now the whole of
 * `PLATFORM_ROLES` (migration 0005). Nothing about what a person can do
 * changed, and nothing about signup changed:
 *
 *   THE COLUMN is wide so that introducing a teacher in Phase 1 or a content
 *   author in Phase 4 is an INSERT, not a migration. Widening a CHECK on a
 *   table holding real accounts requires an ACCESS EXCLUSIVE lock and a full
 *   validation scan; widening it now, at a few dozen rows, is free.
 *
 *   SIGNUP is still exactly `student` and `parent`, enforced by `roleSchema`
 *   in the identity contract, which is built from `SIGNUP_ROLES` and not from
 *   `PLATFORM_ROLES`. A test drives every widened role at `POST /auth/signup`
 *   and asserts a 400, because the two lists being separate constants is the
 *   only thing keeping them apart — and "simplifying" the contract to point at
 *   `PLATFORM_ROLES` would compile, insert, and hand the internet a
 *   `super_admin` dropdown.
 *
 * ===========================================================================
 * `tenant_id` IS NULLABLE WITH A DEFAULT — see `schema/tenants.ts` for the full
 * reasoning. Present on `users` because the AUTHORISATION BOUNDARY needs the
 * ACTOR's tenant, and the actor is a user. Without it, `assertCanAccess` could
 * only ever check the resource's side of the comparison.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** citext + UNIQUE. Normalised (trim + lowercase) before insert as well. */
    email: citext('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    check('users_role_check', sql`${table.role} in (${platformRoleList})`),
    index('users_tenant_idx').on(table.tenantId),
  ],
);

/**
 * Opaque session tokens. The TOKEN IS NEVER STORED — only its SHA-256 hash,
 * so a database leak yields no usable session (§6.1).
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    /** Hashed, not raw — an IP address is personal data. */
    ipHash: text('ip_hash'),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    // Every request validates a session; logout-all deletes by user.
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

/** Single-use email verification tokens. Consumed in the same transaction
 *  that sets `users.email_verified_at` (§6.3). */
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('email_verification_tokens_token_hash_unique').on(table.tokenHash),
    index('email_verification_tokens_user_id_idx').on(table.userId),
  ],
);

/** Single-use password reset tokens. Same shape as verification tokens.
 *  Consuming one deletes every session for the user (§6.7). */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('password_reset_tokens_token_hash_unique').on(table.tokenHash),
    index('password_reset_tokens_user_id_idx').on(table.userId),
  ],
);

/**
 * Link codes — §4 "identity", and the resolution of decision D-012.
 *
 * A code is issued by the STUDENT, BEFORE any parent is known (§6.8, step 1).
 * `parent_child_links.parent_user_id` is NOT NULL, so the code cannot live on
 * the link row at the moment it is created. The first implementation put it in
 * `platform/cache` instead, which made "one active code per student" and the
 * 15-minute expiry free — and made a cache restart silently invalidate every
 * outstanding code. The parent types in a code their child has just read aloud
 * and is told it is invalid: an intermittent, unreproducible failure in the
 * one funnel the product cannot afford to lose.
 *
 * So the codes get a table, and the two properties the cache gave away are
 * bought back explicitly:
 *
 *  - "one active code per student" becomes a PARTIAL UNIQUE INDEX on
 *    `student_user_id WHERE consumed_at IS NULL`. That is a real constraint in
 *    the database, not an invariant the application promises to maintain —
 *    two concurrent requests cannot both succeed, and no future code path can
 *    forget the rule.
 *  - expiry becomes `expires_at`, checked at consumption time against the
 *    INJECTED clock (D-019: two clocks on either side of one comparison is a
 *    defect that only appears under skew).
 *
 * A row is never deleted. `consumed_at` marks it spent, which keeps the audit
 * trail of which code produced which link.
 */
export const linkCodes = pgTable(
  'link_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 6 chars from an unambiguous alphabet — no 0/O, no 1/I/l (§6.8). */
    code: text('code').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Globally unique: a parent submits a bare code with no student id, so the
    // code alone has to identify the student.
    uniqueIndex('link_codes_code_unique').on(table.code),
    // THE constraint. One unconsumed code per student, enforced by Postgres.
    uniqueIndex('link_codes_one_active_per_student')
      .on(table.studentUserId)
      .where(sql`consumed_at is null`),
    index('link_codes_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * The only cross-user data path in the product (§6.8).
 *
 * A link code alone grants nothing: the row starts `pending` and the STUDENT
 * approves it. Revocation is immediate because every parent read checks
 * `status` at query time.
 */
export const parentChildLinks = pgTable(
  'parent_child_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    /**
     * The tenant this link belongs to — see `schema/tenants.ts`.
     *
     * A link is the ONLY cross-user data path in the product, so it is the one
     * row where a tenant mismatch would be a genuine data leak rather than a
     * misfiled record: it is what lets one account read another's. It carries
     * its own tenant rather than inheriting the student's, so a cross-tenant
     * link is a fact visible in the row itself.
     */
    tenantId: uuid('tenant_id')
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    /**
     * WHICH code created this link. Historical record only.
     *
     * `code_expires_at` used to sit beside it and has been dropped: expiry is
     * a property of the code, the code now has its own table, and a second
     * copy of a lifetime is a second thing that can disagree with the first.
     * Live codes are read from `link_codes` and nowhere else.
     */
    linkCode: text('link_code'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('parent_child_links_parent_student_unique').on(
      table.parentUserId,
      table.studentUserId,
    ),
    check(
      'parent_child_links_status_check',
      sql`${table.status} in ('pending', 'approved', 'revoked')`,
    ),
    // A parent must never be linked to themselves.
    check(
      'parent_child_links_distinct_check',
      sql`${table.parentUserId} <> ${table.studentUserId}`,
    ),
    index('parent_child_links_parent_idx').on(table.parentUserId),
    index('parent_child_links_student_idx').on(table.studentUserId),
    index('parent_child_links_tenant_idx').on(table.tenantId),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type EmailVerificationTokenRow = typeof emailVerificationTokens.$inferSelect;
export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
export type ParentChildLinkRow = typeof parentChildLinks.$inferSelect;
export type NewParentChildLinkRow = typeof parentChildLinks.$inferInsert;
export type LinkCodeRow = typeof linkCodes.$inferSelect;
export type NewLinkCodeRow = typeof linkCodes.$inferInsert;
