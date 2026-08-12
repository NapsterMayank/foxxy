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
 * CROSS-TENANT ACCESS and the WIDENED ROLE ENUM — 05-ROADMAP.md §8,
 * migrations 0004 and 0005.
 *
 * A separate file from `can-access.test.ts`, which covers the §7 decision table
 * row by row. These are the two rules added by the foundation hooks, and they
 * are both rules about what the table does NOT say: a tenant mismatch denies
 * even where the table says allow, and a role the table has never heard of is
 * denied rather than falling into the nearest branch.
 *
 * Coverage on `can-access.ts` is 100% — a gate, not a target (D-006).
 */

const STUDENT_A = 'student-a';
const PARENT_A = 'parent-a';
const TENANT_A = 'tenant-aaaa';
const TENANT_B = 'tenant-bbbb';

const parentIn2 = (userId: string): Actor => ({ userId, role: 'parent', tenantId: TENANT_A });
const studentIn = (userId: string, tenantId: string): Actor => ({
  userId,
  role: 'student',
  tenantId,
});
const parentIn = (userId: string, tenantId: string): Actor => ({
  userId,
  role: 'parent',
  tenantId,
});

const studentData = (studentUserId: string, scope: StudentScope = 'profile'): Resource => ({
  kind: 'student-data',
  studentUserId,
  scope,
  tenantId: TENANT_A,
});

/**
 * An actor or a resource whose tenant DID NOT ARRIVE.
 *
 * `tenantId` is a required `string` since D-073, so producing this state needs a
 * cast — and the cast is exactly what the test is for. A tenant reaches this
 * file from a database column, a session row or a JSON body, all places where
 * the compiler's belief and the runtime value can differ. The type makes the
 * mistake hard to write; these tests prove it cannot be got away with.
 */
function withoutTenant<T extends object>(value: T): T {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.tenantId;
  return copy as T;
}

/** Overrides the tenant with a value the types say is impossible. */
function withTenant<T extends object>(value: T, tenantId: unknown): T {
  return { ...value, tenantId };
}

const studentDataIn = (
  studentUserId: string,
  tenantId: string,
  scope: StudentScope = 'profile',
): Resource => ({ kind: 'student-data', studentUserId, scope, tenantId });

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

describe('assertCanAccess — cross-tenant access', () => {
  it('DENIES a parent reading an APPROVED child in another tenant', () => {
    // THE test for this hook. Every ownership and consent rule in the file says
    // yes here: the link exists, the student approved it, the action is a read.
    // The answer is still no, because the tenant check runs before all of them.
    //
    // 05-ROADMAP.md §7 describes Phase 5 as "tenant isolation enforced at the
    // AUTHORISATION BOUNDARY". The alternative — a `where tenant_id = $1` in
    // every query — fails by being forgotten once, in eighteen months, by
    // somebody who has never read that sentence.
    const guard = guardWithLink('approved');
    expect(() => {
      guard.assertCanAccess(
        parentIn(PARENT_A, TENANT_A),
        'read',
        studentDataIn(STUDENT_A, TENANT_B),
      );
    }).toThrow(ForbiddenError);
  });

  it('allows that same parent and child when both are in one tenant', () => {
    // The control. Without it the test above would pass just as happily against
    // a guard that denied everything, and would be measuring nothing.
    const guard = guardWithLink('approved');
    expect(() => {
      guard.assertCanAccess(
        parentIn(PARENT_A, TENANT_A),
        'read',
        studentDataIn(STUDENT_A, TENANT_A),
      );
    }).not.toThrow();
  });

  it('DENIES a student reading their OWN data filed under another tenant', () => {
    // Ownership is the simplest allow rule there is, and it is not enough.
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess(
        studentIn(STUDENT_A, TENANT_A),
        'read',
        studentDataIn(STUDENT_A, TENANT_B),
      );
    }).toThrow(ForbiddenError);
  });

  it('DENIES an account reading its own profile across a tenant boundary', () => {
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess(studentIn(STUDENT_A, TENANT_A), 'read', {
        kind: 'account',
        ownerUserId: STUDENT_A,
        tenantId: TENANT_B,
      });
    }).toThrow(ForbiddenError);
  });

  it('DENIES a subscription read across a tenant boundary', () => {
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess(parentIn(PARENT_A, TENANT_A), 'read', {
        kind: 'subscription',
        ownerUserId: PARENT_A,
        tenantId: TENANT_B,
      });
    }).toThrow(ForbiddenError);
  });

  it('denies every scope and every action across tenants, not only reads', () => {
    const guard = guardWithLink('approved');
    for (const scope of ALL_SCOPES) {
      for (const action of ALL_ACTIONS) {
        expect(() => {
          guard.assertCanAccess(
            studentIn(STUDENT_A, TENANT_A),
            action,
            studentDataIn(STUDENT_A, TENANT_B, scope),
          );
        }).toThrow(ForbiddenError);
      }
    }
  });

  it('leaves CONTENT reachable across tenants — the corpus is shared curriculum', () => {
    // Migration 0004 gives `chapters`, `questions` and `rag_chunks` no
    // `tenant_id` at all: NCERT is CBSE curriculum, identical for every school.
    // Tenanting it would either duplicate 16,000 chunks per customer or leave a
    // column that is always the default and always ignored.
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess(studentIn(STUDENT_A, TENANT_A), 'read', { kind: 'content' });
    }).not.toThrow();
  });
});

describe('cross-tenant denials leak nothing', () => {
  it('returns the same contentless 403 as every other deny', () => {
    const guard = guardWithLink('approved');
    try {
      guard.assertCanAccess(
        parentIn(PARENT_A, TENANT_A),
        'read',
        studentDataIn(STUDENT_A, TENANT_B),
      );
      expect.unreachable('expected a ForbiddenError');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      const forbidden = error as ForbiddenError;
      expect(forbidden.safeMessage).toBe('Forbidden.');
      expect(forbidden.httpStatus).toBe(403);
      expect(forbidden.toClientPayload()).toEqual({
        error: { code: 'FORBIDDEN', message: 'Forbidden.' },
      });
    }
  });

  it('names NEITHER tenant, on the client side or in the log details', () => {
    // "You are in tenant A and this belongs to tenant B" confirms that tenant B
    // holds this resource. In a white-labelled deployment, a competitor
    // school's mere presence on the platform is commercially sensitive before
    // it is anything else — and the identifier is itself a lookup key.
    const guard = guardWithLink('approved');
    try {
      guard.assertCanAccess(
        parentIn(PARENT_A, TENANT_A),
        'read',
        studentDataIn(STUDENT_A, TENANT_B),
      );
      expect.unreachable('expected a ForbiddenError');
    } catch (error) {
      const forbidden = error as ForbiddenError;
      const clientSide = JSON.stringify(forbidden.toClientPayload());
      const logSide = JSON.stringify(forbidden.details);
      for (const secret of [TENANT_A, TENANT_B, STUDENT_A, PARENT_A]) {
        expect(clientSide).not.toContain(secret);
        expect(logSide).not.toContain(secret);
      }
      expect(forbidden.details).toEqual({
        actorRole: 'parent',
        action: 'read',
        resourceKind: 'student-data',
      });
    }
  });

  it('is indistinguishable from an ordinary unlinked-parent denial', () => {
    // Two different reasons, one identical response. Were a cross-tenant deny
    // distinguishable from a not-linked deny, an attacker could map which
    // student accounts exist inside OTHER tenants by comparing the two — the
    // same enumeration leak §7 rule 2 closes for pending/revoked/absent.
    const guard = guardWithLink('approved');

    const capture = (run: () => void): unknown => {
      try {
        run();
      } catch (error) {
        return (error as ForbiddenError).toClientPayload();
      }
      return null;
    };

    const crossTenant = capture(() => {
      guard.assertCanAccess(
        parentIn(PARENT_A, TENANT_A),
        'read',
        studentDataIn(STUDENT_A, TENANT_B),
      );
    });
    const notLinked = capture(() => {
      guardWithLink(null).assertCanAccess(parentIn2(PARENT_A), 'read', studentData(STUDENT_A));
    });

    expect(crossTenant).toEqual(notLinked);
    expect(crossTenant).not.toBeNull();
  });
});

describe('a MISSING tenant is a DENY, on either side — D-073', () => {
  /**
   * THIS BLOCK IS THE INVERSE OF THE ONE IT REPLACES, AND THAT IS THE POINT.
   *
   * Until D-073, `tenantId` was optional on both sides and the rule was "deny
   * when BOTH are present and they differ". Four tests here pinned that
   * leniency: neither side, actor only, resource only, and an explicit null all
   * ALLOWED. The note above them said, in as many words, that they would need to
   * change before a second tenant existed and that changing them was the signal.
   *
   * This is that change. Every one of those four cases is now a denial.
   *
   * WHY THE OLD RULE WAS NOT ACCEPTABLE, restated at the place that enforces it:
   * a caller who forgets to populate `resource.tenantId` got NO tenant
   * enforcement on that call, and the call site looked identical either way.
   * That is the "enforced by remembering" failure the boundary exists to remove,
   * moved one layer up and made invisible. `tenant_id` was added early to avoid
   * a migration across every table once real student data exists; a nullable
   * column with a lenient guard does not avoid that migration, it defers it
   * while reading as complete.
   *
   * `tenantId` is a required `string` in the types, so each case below needs a
   * cast to construct. The cast is not a workaround for the test — it is the
   * test. A tenant arrives from a database column, a session row or a JSON
   * body, and in every one of those places the compiler's belief and the runtime
   * value can differ.
   */
  it('DENIES when NEITHER side carries a tenant', () => {
    const guard = guardWithLink('approved');
    expect(() => {
      guard.assertCanAccess(
        withoutTenant(parentIn(PARENT_A, TENANT_A)),
        'read',
        withoutTenant(studentDataIn(STUDENT_A, TENANT_A)),
      );
    }).toThrow(ForbiddenError);
  });

  it('DENIES when only the ACTOR carries a tenant', () => {
    const guard = guardWithLink('approved');
    expect(() => {
      guard.assertCanAccess(
        parentIn(PARENT_A, TENANT_A),
        'read',
        withoutTenant(studentDataIn(STUDENT_A, TENANT_A)),
      );
    }).toThrow(ForbiddenError);
  });

  it('DENIES when only the RESOURCE carries a tenant', () => {
    const guard = guardWithLink('approved');
    expect(() => {
      guard.assertCanAccess(
        withoutTenant(parentIn(PARENT_A, TENANT_A)),
        'read',
        studentDataIn(STUDENT_A, TENANT_A),
      );
    }).toThrow(ForbiddenError);
  });

  it('DENIES an explicit null tenant, on either side', () => {
    // `null` is what a mis-joined column or a row predating the backfill yields.
    // Under the old rule it meant "unknown, carry on"; it now means "no tenant",
    // which is a denial. Migration 0008 makes the column NOT NULL, so a null
    // arriving here is a defect — and a defect must not be a grant.
    const guard = guardWithLink('approved');
    expect(() => {
      guard.assertCanAccess(
        withTenant(parentIn(PARENT_A, TENANT_A), null),
        'read',
        studentDataIn(STUDENT_A, TENANT_A),
      );
    }).toThrow(ForbiddenError);
    expect(() => {
      guard.assertCanAccess(
        parentIn(PARENT_A, TENANT_A),
        'read',
        withTenant(studentDataIn(STUDENT_A, TENANT_A), null),
      );
    }).toThrow(ForbiddenError);
  });

  it('DENIES an empty or whitespace tenant, which is not a tenant', () => {
    // The empty string is what a caller produces when it resolves a tenant that
    // does not exist and passes the result on rather than branching. `learner`
    // and `identity` both do exactly that deliberately, so that "no such
    // student" and "a student in another tenant" take the same path and produce
    // the same output. Both must land here, and both must be refused.
    const guard = guardWithLink('approved');
    for (const empty of ['', '   ']) {
      expect(() => {
        guard.assertCanAccess(
          parentIn(PARENT_A, TENANT_A),
          'read',
          withTenant(studentDataIn(STUDENT_A, TENANT_A), empty),
        );
      }).toThrow(ForbiddenError);
      expect(() => {
        guard.assertCanAccess(
          withTenant(parentIn(PARENT_A, TENANT_A), empty),
          'read',
          studentDataIn(STUDENT_A, TENANT_A),
        );
      }).toThrow(ForbiddenError);
    }
  });

  it('DENIES a tenantless actor even for CONTENT, which has no tenant of its own', () => {
    // The corpus is shared curriculum and carries no `tenant_id`, so there is
    // nothing to compare it against — but an actor with no tenant is not a
    // half-authenticated caller, it is a wiring defect, and it must reach
    // NOTHING. Denying it here is what stops "content is untenanted" becoming a
    // hole through which a malformed actor is served anything at all.
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess(withoutTenant(studentIn(STUDENT_A, TENANT_A)), 'read', {
        kind: 'content',
      });
    }).toThrow(ForbiddenError);
  });

  it('leaks nothing on a missing-tenant deny, and is indistinguishable from the others', () => {
    /**
     * The three reasons a tenant check can refuse — mismatch, absent actor
     * tenant, absent resource tenant — must produce ONE response.
     *
     * Were they distinguishable, "your tenant is fine but the resource has none"
     * tells a caller that the resource EXISTS and is misconfigured, which is
     * both an existence disclosure and a map of where to push next.
     */
    const guard = guardWithLink('approved');
    const capture = (run: () => void): { payload: unknown; details: unknown } => {
      try {
        run();
      } catch (error) {
        const forbidden = error as ForbiddenError;
        return { payload: forbidden.toClientPayload(), details: forbidden.details };
      }
      throw new Error('expected a ForbiddenError');
    };

    const mismatch = capture(() => {
      guard.assertCanAccess(
        parentIn(PARENT_A, TENANT_A),
        'read',
        studentDataIn(STUDENT_A, TENANT_B),
      );
    });
    const noResourceTenant = capture(() => {
      guard.assertCanAccess(
        parentIn(PARENT_A, TENANT_A),
        'read',
        withoutTenant(studentDataIn(STUDENT_A, TENANT_A)),
      );
    });
    const noActorTenant = capture(() => {
      guard.assertCanAccess(
        withoutTenant(parentIn(PARENT_A, TENANT_A)),
        'read',
        studentDataIn(STUDENT_A, TENANT_A),
      );
    });

    expect(noResourceTenant).toEqual(mismatch);
    expect(noActorTenant).toEqual(mismatch);
    expect(mismatch.payload).toEqual({ error: { code: 'FORBIDDEN', message: 'Forbidden.' } });

    // And nothing identifying, on either side of the error.
    for (const captured of [mismatch, noResourceTenant, noActorTenant]) {
      const serialised = JSON.stringify(captured);
      for (const secret of [TENANT_A, TENANT_B, STUDENT_A, PARENT_A]) {
        expect(serialised).not.toContain(secret);
      }
    }
  });
});

describe('matching tenants never become a grant', () => {
  it('still denies an unapproved link when the tenants match', () => {
    // Tenancy only ever ADDS a denial. A matching tenant must never become an
    // accidental grant.
    const guard = guardWithLink('pending');
    expect(() => {
      guard.assertCanAccess(
        parentIn(PARENT_A, TENANT_A),
        'read',
        studentDataIn(STUDENT_A, TENANT_A),
      );
    }).toThrow(ForbiddenError);
  });

  it('still denies a parent WRITING to a matched-tenant approved child', () => {
    const guard = guardWithLink('approved');
    expect(() => {
      guard.assertCanAccess(
        parentIn(PARENT_A, TENANT_A),
        'write',
        studentDataIn(STUDENT_A, TENANT_A),
      );
    }).toThrow(ForbiddenError);
  });
});

describe('roles with no rules are denied — the widened role enum', () => {
  /**
   * Migration 0005 widened `users.role` from two values to ten so that Phase 1
   * would not need a locking migration on a live table, and `ActorRole` widened
   * with it.
   *
   * IT HAD TO WIDEN. While the type said `'student' | 'parent'`, the
   * `student-data` branch read as "if student … otherwise parent" — so the
   * first `teacher` row to reach this file would have been judged by the PARENT
   * rules. A privilege escalation delivered by a type that was merely out of
   * date.
   *
   * Nothing grants these roles today. These tests are what makes "a teacher can
   * read nothing" a property of THIS FILE rather than a property of the current
   * wiring, which is precisely what Phase 1 changes.
   */
  const UNGRANTED_ROLES = [
    'teacher',
    'principal',
    'content_author',
    'academic_reviewer',
    'implementation_manager',
    'support_agent',
    'school_success',
    'super_admin',
  ] as const;

  it("denies every non-student, non-parent role access to a student's data", () => {
    // `super_admin` included, deliberately. A role called "super admin" that
    // can read nothing looks wrong and is right: no rule grants it anything,
    // and a default-deny boundary is the one place where a name must not be
    // persuasive.
    const guard = guardWithLink('approved');
    for (const role of UNGRANTED_ROLES) {
      for (const action of ALL_ACTIONS) {
        expect(() => {
          guard.assertCanAccess(
            { userId: 'someone', role, tenantId: TENANT_A },
            action,
            studentData(STUDENT_A),
          );
        }).toThrow(ForbiddenError);
      }
    }
  });

  it('denies them even with an approved link row in place', () => {
    // The specific escalation the branch prevents: a teacher account that
    // happens to hold an approved parent-child link would otherwise have read
    // that child's data through a rule written for a parent.
    const guard = guardWithLink('approved');
    expect(() => {
      guard.assertCanAccess(
        { userId: 'a-teacher', role: 'teacher', tenantId: TENANT_A },
        'read',
        studentData(STUDENT_A),
      );
    }).toThrow(ForbiddenError);
  });

  it('still lets them read shared content, which is not student data', () => {
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess({ userId: 'a-teacher', role: 'teacher', tenantId: TENANT_A }, 'read', {
        kind: 'content',
      });
    }).not.toThrow();
  });

  it('still lets them reach their OWN account', () => {
    // Ownership, not role, decides an `account` resource — so a teacher reaches
    // their own profile without anybody having written a teacher rule.
    const guard = guardWithLink(null);
    expect(() => {
      guard.assertCanAccess({ userId: 'a-teacher', role: 'teacher', tenantId: TENANT_A }, 'read', {
        kind: 'account',
        ownerUserId: 'a-teacher',
        tenantId: TENANT_A,
      });
    }).not.toThrow();
  });
});
