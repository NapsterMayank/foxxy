/**
 * The caller of an admin route, after `requireAdmin` has proved the role.
 *
 * ===========================================================================
 * IT CARRIES A `tenantId` AND NOTHING SCOPES BY IT.
 *
 * Every other module's actor exists so `assertCanAccess` can compare its tenant
 * against the resource's. Admin reads across all of them by definition, so that
 * comparison never happens here — the tenant is carried purely so the AUDIT ROW
 * can say which tenant the operator's own account belongs to.
 *
 * Keeping the field and not using it is deliberate rather than sloppy: an actor
 * shape that dropped it would be a second actor type in the codebase, and the
 * next person to wire something would have to decide which one to use.
 * ===========================================================================
 */
export interface AdminActor {
  readonly userId: string;
  readonly role: string;
  readonly tenantId: string;
}
