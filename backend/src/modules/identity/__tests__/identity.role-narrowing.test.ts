import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_ROLES, SIGNUP_ROLES } from '@/shared/constants/roles';
import { roleSchema } from '@/shared/contracts/identity.contract';
import type { Role } from '@/shared/contracts/identity.contract';
import { hashToken } from '../domain/token';
import { createIdentityRepository, type IdentityRepository } from '../identity.repository';
import type { IdentityService } from '../identity.service';
import type { UserRecord } from '../identity.types';
import { TEST_TENANT_ID, startIdentityHarness, type IdentityHarness } from './harness';

/**
 * =============================================================================
 * A ROW'S ROLE IS NOT A SIGNUP'S ROLE — D-293.
 *
 * `identity.repository.ts` carried this, at two places:
 *
 *     // The column carries a CHECK constraint limiting it to these two values,
 *     // so the database is the guarantee behind this narrowing.
 *     role: row.role as Role,
 *
 * `Role` is `z.enum(['student', 'parent'])` — TWO values. The CHECK is built
 * from `PLATFORM_ROLES` — TEN (`0000_baseline.sql:129`,
 * `shared/constants/roles.ts:39-53`). The column was deliberately widened so
 * that Phase 1 needs no locking DDL on a live table. **The cited guarantee was
 * the exact opposite of the truth**, and a comment that asserts a database
 * invariant is the most expensive kind of wrong: the next reader stops checking.
 *
 * The second site is the sharper one — `findSessionByTokenHash`, the lookup on
 * every authenticated request, whose result becomes the request `Actor`.
 *
 * `platform/authz/can-access.ts` documents this failure mode by name and fixed
 * ITS OWN type for it: "a `teacher` row would arrive as a value the compiler
 * believes is impossible … a privilege escalation delivered by a type that was
 * merely out of date." The repository sits UPSTREAM of that file and was not
 * fixed with it.
 *
 * NOT EXPLOITABLE TODAY — nothing grants a non-signup role, and
 * `can-access.ts:300` denies unknown roles explicitly. The defect is that it
 * becomes silent the day one is granted, which is a day nobody will connect to
 * this cast.
 *
 * These tests grant one. They insert a `teacher` the way an operator eventually
 * will — straight into the column the CHECK already permits — and assert that it
 * arrives as itself, through both paths, and is not quietly wearing the type of
 * a signup role.
 * =============================================================================
 */

let harness: IdentityHarness;
let repository: IdentityRepository;
let service: IdentityService;

beforeAll(async () => {
  harness = await startIdentityHarness();
  service = harness.identity.service;
  repository = createIdentityRepository(harness.container.poolFor('identity'));
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

/**
 * Grants a role no signup can claim, by INSERT — which is exactly how Phase 1
 * will do it, and the reason the column was widened ahead of time.
 */
async function grantRole(email: string, role: string): Promise<string> {
  const inserted = await harness.postgres.client.query<{ id: string }>(
    `insert into users (email, password_hash, role, tenant_id, email_verified_at)
       values ($1, $2, $3, $4, now()) returning id`,
    [email, 'fake$whatever', role, TEST_TENANT_ID],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error(`grantRole: no row for ${email}`);
  return id;
}

/** A live session for a user, written directly — no login path grants a teacher. */
async function grantSession(userId: string, token: string): Promise<void> {
  const now = harness.clock.now();
  await harness.postgres.client.query(
    `insert into sessions (user_id, token_hash, expires_at, created_at, last_used_at)
       values ($1, $2, $3, $4, $4)`,
    [userId, hashToken(token), new Date(now.getTime() + 24 * 60 * 60 * 1000), now],
  );
}

// ---------------------------------------------------------------------------

describe('D-293: a non-signup role does not arrive as `Role`', () => {
  it('THE DATABASE ACCEPTS A TEACHER, which is what makes the old comment false', async () => {
    // If this insert failed, the two-value narrowing would have been honest and
    // there would be no defect. It does not fail: the CHECK admits ten values.
    await expect(grantRole('teacher@example.test', 'teacher')).resolves.toBeDefined();

    const stored = await harness.postgres.client.query<{ role: string }>(
      'select role from users where email = $1',
      ['teacher@example.test'],
    );
    expect(stored.rows[0]?.role).toBe('teacher');
  });

  it('findUserByEmail returns the role the ROW carries, not a signup role', async () => {
    await grantRole('teacher-read@example.test', 'teacher');

    const user = await repository.findUserByEmail('teacher-read@example.test');

    expect(user).not.toBeNull();
    expect(user?.role).toBe('teacher');
    // The value is real and it is outside the two-value union the cast claimed.
    expect(SIGNUP_ROLES).not.toContain(user?.role);
    expect(PLATFORM_ROLES).toContain(user?.role);
  });

  it('THE SESSION LOOKUP — the path that builds the Actor — carries it too', async () => {
    /**
     * The site that matters most. `validateSession` returns this straight to
     * every authorisation decision in the product, so a role mistyped here is a
     * role mistyped at the access boundary.
     */
    const userId = await grantRole('teacher-session@example.test', 'teacher');
    const token = 'a-teachers-session-token';
    await grantSession(userId, token);

    const actor = await service.validateSession(token);

    expect(actor.userId).toBe(userId);
    expect(actor.role).toBe('teacher');
    // Nothing in the chain silently rewrote it into 'student' or 'parent' — the
    // failure `can-access.ts` describes, where an "if student … otherwise
    // parent" branch reads a teacher as a PARENT.
    expect(actor.role).not.toBe('student');
    expect(actor.role).not.toBe('parent');
  });

  it('carries EVERY widened role, not just the one this file happens to name', async () => {
    const ungranted = PLATFORM_ROLES.filter(
      (role) => !(SIGNUP_ROLES as readonly string[]).includes(role),
    );
    expect(ungranted.length).toBeGreaterThan(0);

    for (const role of ungranted) {
      const email = `${role}@example.test`;
      await grantRole(email, role);
      const user = await repository.findUserByEmail(email);
      expect(user?.role).toBe(role);
    }
  });

  /**
   * THE COMPILE-TIME HALF, and it is the half that actually pins the TYPE.
   *
   * The assertions above check VALUES, and values would survive a re-narrowing
   * to `Role` unchanged — `'teacher'` is still `'teacher'` at runtime however it
   * is typed. That is precisely why the defect was invisible.
   *
   * `Exclude<UserRecord['role'], Role>` is the set of roles a user record can
   * hold that a signup cannot claim. It must be INHABITED. Narrow the record
   * type back to `Role` and it collapses to `never`, the assignment below stops
   * compiling, and `npm run type-check` fails — which is the only place this
   * particular regression can be caught at all.
   */
  it('types a user record wide enough to HOLD a non-signup role', () => {
    type NonSignupRole = Exclude<UserRecord['role'], Role>;
    const teacher: NonSignupRole = 'teacher';
    const superAdmin: NonSignupRole = 'super_admin';

    expect(teacher).toBe('teacher');
    expect(superAdmin).toBe('super_admin');
  });

  /**
   * THE OTHER DIRECTION, and it is not optional.
   *
   * Widening what a ROW may hold must not widen what a SIGNUP may claim. Those
   * are separate constants for exactly this reason (`shared/constants/roles.ts`
   * spells out the trap), and the day somebody "tidies up" by pointing
   * `roleSchema` at `PLATFORM_ROLES`, nothing fails to compile and nothing fails
   * to insert — the public endpoint just acquires a `super_admin` option.
   */
  it('does NOT widen what a signup may claim', () => {
    expect(roleSchema.options).toEqual(['student', 'parent']);
    for (const role of PLATFORM_ROLES) {
      const accepted = roleSchema.safeParse(role).success;
      expect(accepted).toBe((SIGNUP_ROLES as readonly string[]).includes(role));
    }
  });

  it('refuses a teacher at the signup endpoint, over HTTP', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      headers: { origin: 'http://app.test' },
      url: '/api/v1/auth/signup',
      payload: { email: 'nope@example.test', password: 'vermillion-otter-49', role: 'teacher' },
    });
    expect(response.statusCode).toBe(400);
  });
});
