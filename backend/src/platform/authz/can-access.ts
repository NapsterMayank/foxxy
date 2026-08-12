import { ForbiddenError } from '../errors/index';

/**
 * THE authorization boundary — 01-BACKEND-IMPLEMENTATION-PLAN.md §7.
 *
 * One function, one file. Every service method that touches data belonging to
 * a specific student calls it. There is no second place where access is
 * decided.
 *
 * Four rules govern this file:
 *  1. DENY BY DEFAULT. The function ends in `throw new ForbiddenError()`.
 *     Access is granted only by an explicit branch above that line.
 *  2. NO PAYLOAD ON A DENY. `ForbiddenError.safeMessage` is the fixed string
 *     "Forbidden." — never "that student exists but is not linked to you",
 *     which is an enumeration leak wearing a different hat.
 *  3. LINK STATUS IS READ AT QUERY TIME, never cached in the session, so that
 *     revocation is instant. That is why the reader is injected rather than
 *     taken from the actor.
 *  4. NO DATABASE ACCESS OUTSIDE A REPOSITORY — enforced by ESLint, which is
 *     why this file imports nothing but the error type.
 *
 * Coverage on this file is 100%. A gate, not a target.
 */

/**
 * Every role the `users.role` column will accept — NOT every role that can do
 * anything.
 *
 * Widened alongside the CHECK constraint in migration 0005. It matters that the
 * two lists match: if this type stayed `'student' | 'parent'` while the column
 * accepted ten values, a `teacher` row would arrive at this file as a value the
 * compiler believes is impossible, and the `student-data` branch below —
 * written as "if student … otherwise parent" — would have treated it as a
 * PARENT. That is a privilege escalation delivered by a type that was merely
 * out of date.
 *
 * So the type is wide and the RULES are narrow: the `student-data` branch names
 * `student` and `parent` explicitly and every other role falls through to the
 * default deny. A teacher can read nothing until Phase 1 writes a rule saying
 * what a teacher may read.
 */
export type ActorRole =
  | 'student'
  | 'parent'
  | 'teacher'
  | 'principal'
  | 'content_author'
  | 'academic_reviewer'
  | 'implementation_manager'
  | 'support_agent'
  | 'school_success'
  | 'super_admin';

/** Only ever `{ userId, role, tenantId }`. Never the whole user row (§6.5). */
export interface Actor {
  readonly userId: string;
  readonly role: ActorRole;
  /**
   * Which tenant this actor belongs to — 05-ROADMAP.md §8, migrations 0004 and
   * 0008.
   *
   * REQUIRED, as of D-073. It was optional for one build cycle and the
   * optionality is what D-073 rejected: a tenant that may be absent is a tenant
   * check that may be skipped, and the skipping is invisible at the call site.
   *
   * The type makes it hard to omit; `assertTenantMatch` below makes it
   * impossible to omit and still be allowed, because a missing or empty tenant
   * on either side is a DENY rather than a pass. Both, not either — the type
   * catches the honest mistake at compile time, the runtime check catches the
   * value that arrived from a database column, a JSON body or a cast.
   */
  readonly tenantId: string;
}

export type Action = 'read' | 'write';

export type LinkStatus = 'pending' | 'approved' | 'revoked';

/** The kinds of student-owned data guarded by this boundary. */
export type StudentScope = 'profile' | 'sessions' | 'practice' | 'chat' | 'mastery' | 'progress';

/**
 * The tenant a resource belongs to.
 *
 * REQUIRED on every variant that carries it (D-073). `content` deliberately has
 * NO tenant: the NCERT corpus is CBSE curriculum, identical for every school,
 * and migration 0004 gives `chapters`, `questions` and `rag_chunks` no
 * `tenant_id` at all.
 *
 * THE TENANT OF A RESOURCE IS READ FROM THE RESOURCE, NEVER FROM THE ACTOR.
 * Passing `actor.tenantId` here to satisfy the type would make the comparison
 * below compare a value with itself — a check that always passes, written in
 * the shape of a check that sometimes fails. Every caller resolves it from the
 * data it is about to serve.
 */
interface TenantScoped {
  readonly tenantId: string;
}

export type Resource =
  /** Anything belonging to one specific student. */
  | ({
      readonly kind: 'student-data';
      readonly studentUserId: string;
      readonly scope: StudentScope;
    } & TenantScoped)
  /** An account's own profile and credentials, for either role. */
  | ({ readonly kind: 'account'; readonly ownerUserId: string } & TenantScoped)
  /** An account's own subscription and billing. */
  | ({ readonly kind: 'subscription'; readonly ownerUserId: string } & TenantScoped)
  /** Curriculum: chapters, questions, chunks. Not owned by any user or tenant. */
  | { readonly kind: 'content' };

/**
 * Reads the CURRENT link status between a parent and a student, or null when
 * no link row exists.
 *
 * Injected rather than imported so this file can be tested exhaustively with
 * no database, and so the caller is forced to resolve status at query time.
 */
export type LinkStatusReader = (parentUserId: string, studentUserId: string) => LinkStatus | null;

export interface AuthzDeps {
  readonly readLinkStatus: LinkStatusReader;
}

export interface AccessGuard {
  assertCanAccess(actor: Actor, action: Action, resource: Resource): void;
}

/**
 * Every deny funnels through here, so the shape of a 403 is decided once.
 *
 * It BUILDS the error rather than throwing it, so that every call site reads
 * `throw forbidden(...)`. That keeps the control flow visible to a reader and
 * to `no-fallthrough`, which cannot see through a never-returning helper.
 */
function forbidden(
  reason: string,
  actor: Actor,
  action: Action,
  resource: Resource,
): ForbiddenError {
  return new ForbiddenError({
    // Log-side only. Deliberately carries no user or student identifier.
    message: `Access denied: ${reason}`,
    details: {
      actorRole: actor.role,
      action,
      resourceKind: resource.kind,
    },
  });
}

/**
 * Builds the guard with its dependencies bound.
 *
 * The returned `assertCanAccess(actor, action, resource)` is the signature the
 * plan specifies; the link reader is supplied here so it never has to be
 * threaded through every call site.
 */
/**
 * THE TENANT BOUNDARY — 05-ROADMAP.md §8 and §7, migration 0004.
 *
 * ===========================================================================
 * IT RUNS BEFORE EVERY ALLOW RULE, AND THAT ORDERING IS THE POINT.
 *
 * §7 of the roadmap describes Phase 5 as "tenant isolation enforced at the
 * authorisation boundary". The temptation is to enforce it in queries — add
 * `where tenant_id = $1` everywhere — and that is precisely the approach that
 * fails, because it is enforced by remembering. One query written without the
 * clause, in eighteen months, by somebody who has never read this file, and a
 * school sees another school's children. Nothing errors.
 *
 * Here, a tenant mismatch is refused BEFORE the switch below is reached. It
 * cannot be reached by an allow rule, because no allow rule runs first:
 *
 *   - A STUDENT reading THEIR OWN data in another tenant: denied. (Which should
 *     be impossible — but "impossible" states are what a boundary is for.)
 *   - A PARENT reading a child they have an APPROVED, student-consented link
 *     to, in another tenant: DENIED. This is the case worth stating out loud,
 *     because every ownership and consent rule in this file says yes and the
 *     answer is still no.
 *   - An account reading ITS OWN profile across a tenant boundary: denied.
 *
 * ===========================================================================
 * A MISSING TENANT IS A DENY, NOT A PASS — D-073, and this is the whole change.
 *
 * The first implementation of this function made both sides optional and denied
 * only when BOTH were present and they differed. That reads as complete and is
 * not: a caller that forgets to populate `resource.tenantId` gets no tenant
 * enforcement at all on that call. It is the "enforced by remembering" failure
 * this boundary exists to remove, moved one layer up and made invisible — the
 * call site looks identical whether or not the check happened.
 *
 * D-073: `tenant_id` was added early for exactly one reason, to avoid the
 * migration-across-every-table that retrofitting tenancy onto live student data
 * would cost. A nullable column with a lenient guard does not AVOID that
 * migration, it DEFERS it, while the tracker says it is paid. So:
 *
 *   - The columns are NOT NULL (migration 0008).
 *   - `Actor.tenantId` and `TenantScoped.tenantId` are REQUIRED types.
 *   - This function denies when either side is missing, empty, or not a string.
 *
 * The runtime check is not redundant with the types. A tenant arrives from a
 * database column, a session row or a JSON body — all places where TypeScript's
 * belief and the runtime value can differ — and the cost of being wrong here is
 * one school reading another school's children. The compiler makes the mistake
 * hard to write; this makes it impossible to get away with.
 *
 * WHAT A MISSING TENANT LOOKS LIKE TO THE CALLER: exactly what every other deny
 * looks like. Same contentless 403, same log details, no mention of which side
 * was absent.
 */

/** A usable tenant identifier. Empty strings and whitespace are not tenants. */
function isTenant(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertTenantMatch(actor: Actor, action: Action, resource: Resource): void {
  // `content` has no tenant — the corpus is shared curriculum (migration 0004).
  // The ACTOR's tenant is still required: an actor with no tenant is not a
  // half-authenticated caller, it is a wiring defect, and it must not be able to
  // reach anything at all.
  if (!isTenant(actor.tenantId)) {
    throw forbidden('actor carries no tenant', actor, action, resource);
  }

  if (resource.kind === 'content') return;

  if (!isTenant(resource.tenantId)) {
    throw forbidden('resource carries no tenant', actor, action, resource);
  }

  if (actor.tenantId === resource.tenantId) return;

  // NO PAYLOAD ON A DENY (§7 rule 2). The reason string is log-side only and
  // names NEITHER tenant: "you are in tenant A and this belongs to tenant B"
  // confirms that tenant B holds this resource, which is exactly the kind of
  // existence disclosure a white-labelled deployment cannot afford — a
  // competitor school's presence on the platform is commercially sensitive
  // before it is anything else.
  throw forbidden('cross-tenant access', actor, action, resource);
}

export function createAccessGuard(deps: AuthzDeps): AccessGuard {
  function assertCanAccess(actor: Actor, action: Action, resource: Resource): void {
    // FIRST. Before ownership, before consent, before role. A rule that can be
    // reached only after another rule has already said yes is not a boundary.
    assertTenantMatch(actor, action, resource);

    switch (resource.kind) {
      // --- Row: anyone authenticated -> content and chapters -> allow -----
      // Read-only. Nothing in the product authors content over the API.
      case 'content': {
        if (action === 'read') {
          return;
        }
        throw forbidden('content is read-only', actor, action, resource);
      }

      // --- Row: parent -> own subscription and profile -> allow -----------
      // The same rule covers a student's own account: ownership is what
      // matters, not role.
      case 'account':
      case 'subscription': {
        if (resource.ownerUserId === actor.userId) {
          return;
        }
        throw forbidden('account does not belong to the actor', actor, action, resource);
      }

      case 'student-data': {
        // --- Row: student -> own profile, sessions, practice, chat -> allow
        // --- Row: student -> any other student's anything -> DENY ---------
        if (actor.role === 'student') {
          if (actor.userId === resource.studentUserId) {
            return;
          }
          throw forbidden('a student may only reach their own data', actor, action, resource);
        }

        // --- Row: any other role -> a student's data -> DENY --------------
        //
        // THE REASON THIS BRANCH EXISTS AT ALL. `ActorRole` widened from two
        // values to ten in migration 0005 so that `users.role` would not need a
        // locking migration when Phase 1 introduces teachers. Until this line
        // was written, the code below read "if student … otherwise parent", so
        // the day a `teacher` row appeared it would have been handled by the
        // PARENT rules — and a teacher with an approved parent-child link row
        // would have read that child's data through a rule written for a
        // parent.
        //
        // Nothing grants those roles today, so this is unreachable in
        // production. It is written, and tested, because "unreachable" is a
        // property of the current wiring rather than of this file, and the
        // wiring is what Phase 1 changes. A teacher reads nothing until
        // somebody writes a rule saying what a teacher may read.
        if (actor.role !== 'parent') {
          throw forbidden('no rule grants this role access to student data', actor, action, resource);
        }

        // actor.role === 'parent' from here.
        //
        // --- Row: parent -> linked child -> allow, READ-ONLY --------------
        // A parent observes; a parent never acts on a child's behalf.
        if (action !== 'read') {
          throw forbidden('parent access to child data is read-only', actor, action, resource);
        }

        // Read at query time, never from the session — revocation is instant.
        const status = deps.readLinkStatus(actor.userId, resource.studentUserId);

        // --- Row: parent -> linked child, status approved -> allow --------
        if (status === 'approved') {
          return;
        }

        // --- Row: parent -> pending or revoked   -> DENY ------------------
        // --- Row: parent -> any unlinked student -> DENY ------------------
        // One indistinguishable deny for all three: telling them apart would
        // reveal whether a given student account exists.
        throw forbidden('no approved parent-child link', actor, action, resource);
      }

      default:
        break;
    }

    // --- DEFAULT DENY -----------------------------------------------------
    // Reached only by a resource kind nobody has written a rule for. A new
    // kind is denied until someone adds an explicit branch above.
    throw forbidden('no rule grants this access', actor, action, resource);
  }

  return { assertCanAccess };
}
