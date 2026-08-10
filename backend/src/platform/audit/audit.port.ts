/**
 * platform/audit — the append-only record of privileged actions.
 *
 * 05-ROADMAP.md §8 bundles `audit_log` with the role enum and the schools stub
 * as a Phase 0 hook, because Phase 4 needs a "full role matrix, audited 'view
 * as', complete audit log" and an audit log that starts in Phase 4 has nothing
 * in it about Phases 0 to 3 — which are the phases during which the pilot is
 * actually being judged.
 *
 * ===========================================================================
 * WHAT BELONGS IN HERE, AND WHAT EMPHATICALLY DOES NOT.
 *
 * IN:  actions that CHANGE SECURITY STATE or that a school, a parent or a
 *      regulator could reasonably ask about afterwards. Password reset. Logout
 *      everywhere. A parent gaining access to a child's data. A parent losing
 *      it. Later: role grants, "view as", content publication.
 *
 * OUT: ordinary activity. Answering a question is not an audit event, it is a
 *      row in `question_responses`. Logging in successfully is not an audit
 *      event either — it happens hundreds of times a day per user and would
 *      bury the four events that matter under a million that do not. An audit
 *      log that is expensive to read is an audit log nobody reads.
 *
 * ===========================================================================
 * `record()` NEVER THROWS. This is the single most important property here.
 *
 * Every caller is a privileged action in progress: a password being reset, a
 * link being revoked. If auditing could fail the operation, then a full disk, a
 * schema drift or a bug in metadata assembly would BLOCK A USER FROM REVOKING A
 * PARENT'S ACCESS — the failure of the record breaking the thing recorded, at
 * the exact moment somebody urgently needs it to work.
 *
 * So a write failure is logged at `error` and swallowed. That is a real
 * trade-off with a real cost: a lost audit row is unrecoverable and invisible
 * to the user. It is accepted because the alternative is worse in the case that
 * matters. The compensating control is that the failure is loud on the
 * operator's side — `error` level plus a metric — rather than merely absent.
 *
 * ===========================================================================
 * PII IS SCRUBBED, NOT REJECTED. See `platform/pii` for the full reasoning:
 * rejecting would mean a defect in the RECORD of a security operation fails the
 * SECURITY OPERATION. Scrubbing is logged at `warn` and counted, because a
 * module putting an email address in an audit payload is a defect to be fixed
 * at the source. The scrub is the safety net, never the design.
 */

/** Who acted. Null for system actions — the worker has no user. */
export interface AuditActor {
  readonly userId: string | null;
  /** The role AT THE TIME. Denormalised so a later change cannot rewrite it. */
  readonly role: string | null;
  readonly tenantId?: string | null;
}

export interface AuditEntry {
  readonly actor: AuditActor;
  /** Dotted and past tense: `identity.password_reset`. */
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  /**
   * IDENTIFIERS AND COUNTS ONLY. Never an email, a phone number, a name, or
   * free text a user typed. Scrubbed before it is written; the scrub is
   * insurance against an accident, not permission to be careless.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditPort {
  /** Appends one entry. Never throws, never rejects. */
  record(entry: AuditEntry): Promise<void>;
}

/**
 * The action vocabulary, as constants.
 *
 * String literals at call sites would drift — `identity.password_reset` in one
 * place and `identity.passwordReset` in another produce two actions that no
 * query joins, and the gap is invisible until somebody investigates an incident
 * and finds half the history missing.
 *
 * These four are the privileged actions that EXIST TODAY. The list grows as
 * modules do; it does not get pre-populated with actions nothing performs,
 * because an unused constant reads as a feature somebody forgot to finish.
 */
export const AUDIT_ACTIONS = {
  /** §6.7 — a password was reset by token, and every session was revoked. */
  PASSWORD_RESET: 'identity.password_reset',
  /** §6.6 — "sign out everywhere". */
  LOGOUT_ALL: 'identity.logout_all',
  /** §6.8 step 5 — THE STUDENT approved a parent's access. Consent, recorded. */
  LINK_APPROVED: 'identity.link_approved',
  /** §6.8 step 7 — either party revoked it. */
  LINK_REVOKED: 'identity.link_revoked',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const AUDIT_RESOURCES = {
  USER: 'user',
  SESSION: 'session',
  PARENT_CHILD_LINK: 'parent_child_link',
} as const;

/**
 * The audit port that records nothing.
 *
 * Named and explicit so that discarding an audit trail is a decision a
 * composition root makes visibly. Used by test harnesses that are not asserting
 * audit behaviour — never in production wiring, and a test asserts that the
 * production container does not use it.
 */
export function createNoopAudit(): AuditPort {
  return {
    record(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** Test fake. Records entries in memory; assertions run against `entries`. */
export class RecordingAudit implements AuditPort {
  readonly entries: AuditEntry[] = [];

  record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }

  find(action: string): AuditEntry[] {
    return this.entries.filter((entry) => entry.action === action);
  }

  clear(): void {
    this.entries.length = 0;
  }
}
