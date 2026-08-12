import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '../../errors/index';
import {
  createAccessGuard,
  type AccessGuard,
  type Action,
  type Actor,
  type LinkStatus,
  type Resource,
  type StudentScope,
} from '../can-access';

/**
 * Every row of the decision table in §7, plus the default-deny case.
 * Coverage on can-access.ts is 100% — a gate, not a target.
 */

const STUDENT_A = 'student-a';
const STUDENT_B = 'student-b';
const PARENT_A = 'parent-a';

/**
 * ONE tenant, shared by every actor and resource in this file.
 *
 * This suite covers the §7 decision table, which is a table about ownership,
 * role and consent — not about tenancy. Giving everything the same tenant keeps
 * the tenant check satisfied and out of the way, so each test still measures the
 * row it names. The tenant rules have their own file,
 * `can-access.tenancy.test.ts`, where a mismatch and a MISSING tenant are the
 * subject rather than the background.
 *
 * It is a required field now (D-073), so it cannot simply be omitted — and that
 * is the point: the compiler lists every call site, including these.
 */
const TENANT = 'tenant-shared';

const student = (userId: string): Actor => ({ userId, role: 'student', tenantId: TENANT });
const parent = (userId: string): Actor => ({ userId, role: 'parent', tenantId: TENANT });

const studentData = (studentUserId: string, scope: StudentScope = 'profile'): Resource => ({
  kind: 'student-data',
  studentUserId,
  scope,
  tenantId: TENANT,
});

/** A guard whose link reader always answers the same thing. */
function guardWithLink(status: LinkStatus | null): AccessGuard {
  return createAccessGuard({ readLinkStatus: () => status });
}

const ALL_SCOPES: readonly StudentScope[] = [
  'profile',
  'sessions',
  'practice',
  'chat',
  'mastery',
  'progress',
];
const ALL_ACTIONS: readonly Action[] = ['read', 'write'];

describe('assertCanAccess — student rows', () => {
  it('allows a student to reach their own profile, sessions, practice and chat', () => {
    const guard = guardWithLink(null);
    for (const scope of ALL_SCOPES) {
      for (const action of ALL_ACTIONS) {
        expect(() => {
          guard.assertCanAccess(student(STUDENT_A), action, studentData(STUDENT_A, scope));
        }).not.toThrow();
      }
    }
  });

  it("denies a student any access to another student's data", () => {
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess(student(STUDENT_A), 'read', studentData(STUDENT_B));
    }).toThrow(ForbiddenError);
  });

  it("denies a student writing to another student's data", () => {
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess(student(STUDENT_A), 'write', studentData(STUDENT_B, 'practice'));
    }).toThrow(ForbiddenError);
  });

  it('does not consult the link reader for a student actor', () => {
    let calls = 0;
    const guard = createAccessGuard({
      readLinkStatus: () => {
        calls += 1;
        return 'approved';
      },
    });
    expect(() => {
      guard.assertCanAccess(student(STUDENT_A), 'read', studentData(STUDENT_B));
    }).toThrow(ForbiddenError);
    expect(calls).toBe(0);
  });
});

describe('assertCanAccess — parent rows', () => {
  it('allows a parent to read a linked child whose link is approved', () => {
    const guard = guardWithLink('approved');
    for (const scope of ALL_SCOPES) {
      expect(() => {
        guard.assertCanAccess(parent(PARENT_A), 'read', studentData(STUDENT_A, scope));
      }).not.toThrow();
    }
  });

  it('denies a parent WRITING to an approved linked child — parent access is read-only', () => {
    const guard = guardWithLink('approved');
    expect(() => {
      guard.assertCanAccess(parent(PARENT_A), 'write', studentData(STUDENT_A));
    }).toThrow(ForbiddenError);
  });

  it('denies a parent whose link is still pending', () => {
    const guard = guardWithLink('pending');
    expect(() => {
      guard.assertCanAccess(parent(PARENT_A), 'read', studentData(STUDENT_A));
    }).toThrow(ForbiddenError);
  });

  it('denies a parent whose link has been revoked', () => {
    const guard = guardWithLink('revoked');
    expect(() => {
      guard.assertCanAccess(parent(PARENT_A), 'read', studentData(STUDENT_A));
    }).toThrow(ForbiddenError);
  });

  it('denies a parent with no link to the student at all', () => {
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess(parent(PARENT_A), 'read', studentData(STUDENT_A));
    }).toThrow(ForbiddenError);
  });

  it('reads link status at call time, so a revocation takes effect immediately', () => {
    let status: LinkStatus = 'approved';
    const guard = createAccessGuard({ readLinkStatus: () => status });

    expect(() => {
      guard.assertCanAccess(parent(PARENT_A), 'read', studentData(STUDENT_A));
    }).not.toThrow();

    status = 'revoked';

    expect(() => {
      guard.assertCanAccess(parent(PARENT_A), 'read', studentData(STUDENT_A));
    }).toThrow(ForbiddenError);
  });

  it('passes the actor and the student to the link reader in that order', () => {
    const seen: [string, string][] = [];
    const guard = createAccessGuard({
      readLinkStatus: (parentUserId, studentUserId) => {
        seen.push([parentUserId, studentUserId]);
        return 'approved';
      },
    });
    guard.assertCanAccess(parent(PARENT_A), 'read', studentData(STUDENT_A));
    expect(seen).toEqual([[PARENT_A, STUDENT_A]]);
  });
});

describe('assertCanAccess — own account and subscription rows', () => {
  it('allows a parent to reach their own subscription', () => {
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess(parent(PARENT_A), 'read', {
        tenantId: TENANT,
        kind: 'subscription',
        ownerUserId: PARENT_A,
      });
    }).not.toThrow();
  });

  it('allows a parent to write to their own account', () => {
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess(parent(PARENT_A), 'write', { tenantId: TENANT, kind: 'account', ownerUserId: PARENT_A });
    }).not.toThrow();
  });

  it('allows a student to reach their own account', () => {
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess(student(STUDENT_A), 'read', {
        tenantId: TENANT,
        kind: 'account',
        ownerUserId: STUDENT_A,
      });
    }).not.toThrow();
  });

  it("denies reaching someone else's account", () => {
    const guard = guardWithLink('approved');
    expect(() => {
      guard.assertCanAccess(parent(PARENT_A), 'read', { tenantId: TENANT, kind: 'account', ownerUserId: STUDENT_A });
    }).toThrow(ForbiddenError);
  });

  it("denies reaching someone else's subscription even with an approved link", () => {
    const guard = guardWithLink('approved');
    expect(() => {
      guard.assertCanAccess(parent(PARENT_A), 'read', {
        tenantId: TENANT,
        kind: 'subscription',
        ownerUserId: STUDENT_A,
      });
    }).toThrow(ForbiddenError);
  });
});

describe('assertCanAccess — content row', () => {
  it('allows any authenticated actor to read content and chapters', () => {
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess(student(STUDENT_A), 'read', { kind: 'content' });
    }).not.toThrow();
    expect(() => {
      guard.assertCanAccess(parent(PARENT_A), 'read', { kind: 'content' });
    }).not.toThrow();
  });

  it('denies writing to content — nothing authors curriculum over the API', () => {
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess(student(STUDENT_A), 'write', { kind: 'content' });
    }).toThrow(ForbiddenError);
  });
});

describe('assertCanAccess — deny by default', () => {
  it('denies a resource kind that no branch grants', () => {
    const guard = guardWithLink('approved');
    /**
     * Deliberately malformed: this is the case that proves the function ends in
     * a throw rather than falling through to an implicit allow.
     *
     * IT CARRIES A MATCHING TENANT, ON PURPOSE. Without one, the tenant check
     * (which runs first, before any allow rule) would refuse it for having no
     * tenant, and this test would pass while never reaching the default-deny
     * line at all — a green test measuring a different branch. The tenant is
     * what makes the unknown KIND the reason for the denial.
     */
    const unknownResource = {
      kind: 'something-nobody-wrote-a-rule-for',
      tenantId: TENANT,
    } as unknown as Resource;
    expect(() => {
      guard.assertCanAccess(student(STUDENT_A), 'read', unknownResource);
    }).toThrow(ForbiddenError);
  });
});

describe('deny responses carry no payload', () => {
  it('uses the fixed safe message "Forbidden." and never names the resource', () => {
    const guard = guardWithLink('pending');
    try {
      guard.assertCanAccess(parent(PARENT_A), 'read', studentData(STUDENT_A));
      expect.unreachable('expected a ForbiddenError');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      const forbidden = error as ForbiddenError;
      expect(forbidden.safeMessage).toBe('Forbidden.');
      expect(forbidden.httpStatus).toBe(403);
      expect(forbidden.toClientPayload()).toEqual({
        error: { code: 'FORBIDDEN', message: 'Forbidden.' },
      });
      // No student identifier anywhere in what the client would see.
      expect(JSON.stringify(forbidden.toClientPayload())).not.toContain(STUDENT_A);
    }
  });

  it('keeps identifiers out of the log-side details as well', () => {
    const guard = guardWithLink(null);
    try {
      guard.assertCanAccess(parent(PARENT_A), 'read', studentData(STUDENT_A));
      expect.unreachable('expected a ForbiddenError');
    } catch (error) {
      const forbidden = error as ForbiddenError;
      expect(JSON.stringify(forbidden.details)).not.toContain(STUDENT_A);
      expect(JSON.stringify(forbidden.details)).not.toContain(PARENT_A);
      expect(forbidden.details).toEqual({
        actorRole: 'parent',
        action: 'read',
        resourceKind: 'student-data',
      });
    }
  });
});
