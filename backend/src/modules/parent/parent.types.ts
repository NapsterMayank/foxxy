import type { Actor, LinkStatus } from '@/platform/authz/index';
import type { BilingualText } from '@/platform/notify-channel/index';
import type { Grade, LanguageCode } from '@/shared/constants/curriculum';
import type { ChildSnapshot } from './domain/snapshot';

/**
 * Internal types for the parent module. Nothing here is public except where
 * `index.ts` re-exports it deliberately.
 *
 * ===========================================================================
 * EVERY CROSS-MODULE EDGE ON THIS PAGE IS AN INJECTED FUNCTION.
 *
 * `parent` reads a link status, a tenant, a child's profile and revokes a link
 * — all four belong to `identity` or `learner`, and this module imports
 * neither. They arrive as the function types below, wired in `app/routes.ts`,
 * which stays the complete dependency graph (D-051).
 * ===========================================================================
 */

/** The authenticated caller: `{ userId, role, tenantId }`, never a user row. */
export type ParentActor = Actor;

/**
 * The CURRENT parent-child link status, read per authorisation decision.
 *
 * §7 rule 3: never cached on the session, so a revocation takes effect on the
 * parent's very next request rather than at their next login. There is a test
 * that reads successfully, revokes, and reads again in the same test.
 *
 * Collapsed to `'approved' | null` at the composition root, exactly as
 * `learner` and `practice` take it: telling `pending` from `revoked` from "no
 * link at all" in a 403 would reveal whether a student account exists.
 */
export type LinkStatusReader = (
  parentUserId: string,
  studentUserId: string,
) => Promise<LinkStatus | null>;

/**
 * The tenant a user's account belongs to, read from `users`.
 *
 * D-091, and it is the single most important line in this module. The resource
 * tenant is resolved FROM THE DATA. Passing `actor.tenantId` here would satisfy
 * the type and make `assertTenantMatch` compare a value with itself — a check
 * that always passes, written in the shape of a check that sometimes fails.
 * `__tests__/parent.authz-mutation.test.ts` installs exactly that mistake and
 * proves a cross-tenant read then succeeds.
 */
export type TenantReader = (userId: string) => Promise<string | null>;

/** One approved parent-child link, as identity reports it. */
export interface LinkedChildLink {
  readonly linkId: string;
  readonly studentUserId: string;
  readonly approvedAt: Date | null;
}

/** identity's `getLinkedChildren`, injected. Approved links only. */
export type LinkedChildrenReader = (actor: ParentActor) => Promise<readonly LinkedChildLink[]>;

/**
 * identity's `revokeLink`, injected.
 *
 * `parent_child_links` is identity's table, so this module never writes it —
 * it asks the module that owns it, which is also where the
 * `identity.link_revoked` audit row and the link-state rules live.
 */
export type LinkRevoker = (actor: ParentActor, linkId: string) => Promise<void>;

/** The slice of a child's profile a parent screen shows. */
export interface ChildProfile {
  readonly displayName: string;
  readonly grade: Grade;
  readonly preferredLanguage: LanguageCode;
}

/** learner's `getProfile`, injected — and it re-runs the guard on its own. */
export type ChildProfileReader = (
  actor: ParentActor,
  studentUserId: string,
) => Promise<ChildProfile>;

/** One child, as the parent portal lists them. */
export interface ParentChild {
  readonly linkId: string;
  readonly childUserId: string;
  readonly displayName: string;
  readonly grade: Grade;
  readonly approvedAt: Date | null;
}

/** What a parent may see about a child, named rather than implied. */
export const CONSENT_SCOPES = ['snapshot', 'digest', 'transcript'] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

/**
 * The consent a link represents, from the parent's side.
 *
 * `status` is always `'approved'` — and that is not a redundant field. Every
 * method in this module goes through `assertCanAccess` first, which refuses a
 * `pending` or `revoked` link with the same contentless 403 as an unknown
 * child, so a consent state can only ever be READ for a link that is approved.
 * The field exists so the wire shape does not have to change when a future rule
 * lets a parent see more.
 */
export interface ConsentState {
  readonly childUserId: string;
  readonly linkId: string;
  readonly status: 'approved';
  readonly approvedAt: Date | null;
  readonly canView: readonly ConsentScope[];
  /**
   * WHETHER THE CHILD KNOWS. Always true, and exposed rather than assumed —
   * see `TranscriptVisibility`.
   */
  readonly childIsInformed: boolean;
  readonly notice: BilingualText;
}

/** What `revokeConsent` did. */
export interface ConsentRevocation {
  readonly childUserId: string;
  readonly linkId: string;
  readonly status: 'revoked';
  readonly revokedAt: Date;
}

/**
 * THE CHILD-VISIBILITY STATE — the honest half of the transcript feature.
 *
 * A parent reading a child's conversations with a tutor is a surveillance
 * capability, and the only thing that separates it from surveillance is that
 * the child knows. So the flag is part of the RESPONSE rather than a footnote
 * in a privacy policy: it is always present, it is always true today, and the
 * `disclosure` text is the exact wording the child is shown.
 *
 * `foxy` owns the student-facing surface that renders it and does not exist
 * yet. This module does not fabricate one — it publishes the state, and it
 * writes an `audit_log` row on every transcript read, so "who looked, and when"
 * is durable rather than reconstructed.
 */
export interface TranscriptVisibility {
  readonly parentCanView: boolean;
  readonly childIsTold: boolean;
  readonly disclosure: BilingualText;
}

export interface TranscriptMessage {
  readonly id: string;
  readonly role: 'student' | 'foxy';
  readonly text: string;
  readonly createdAt: Date;
}

export interface TranscriptSession {
  readonly sessionId: string;
  readonly mode: string;
  readonly startedAt: Date;
  readonly lastMessageAt: Date | null;
  readonly messages: readonly TranscriptMessage[];
}

/**
 * Why a transcript is empty — "there are no conversations" and "the feature
 * that would hold them does not exist yet" are different facts, and a parent
 * shown an empty list deserves to know which one they are looking at.
 */
export const TRANSCRIPT_SOURCES = ['foxy', 'not_yet_available'] as const;
export type TranscriptSource = (typeof TRANSCRIPT_SOURCES)[number];

export interface ChildTranscript {
  readonly childUserId: string;
  readonly source: TranscriptSource;
  readonly sessions: readonly TranscriptSession[];
  readonly visibility: TranscriptVisibility;
  /** READ-ONLY, stated on the wire. There is no write path in this module. */
  readonly readOnly: true;
}

/** A stored digest, as the parent portal reads it back. */
export interface DigestRecord {
  readonly id: string;
  readonly parentUserId: string;
  readonly childUserId: string;
  /** `YYYY-MM-DD` of the week's Monday. */
  readonly weekStart: string;
  readonly summary: BilingualText;
  readonly suggestedAction: BilingualText;
  /** NULL for essentially every real week today — D-077, and it is honest. */
  readonly misconceptionCode: string | null;
  readonly sessionsCount: number;
  readonly questionsAnswered: number;
  readonly daysPractised: number;
  readonly generatedAt: Date;
}

/** What `generateDigest` did — and whether it did anything at all. */
export interface DigestGeneration {
  readonly digest: DigestRecord;
  /**
   * False when this week's digest already existed.
   *
   * A RESULT rather than a silent overwrite: "running twice must not send
   * twice" is only assertable if the second run can be told apart from the
   * first.
   */
  readonly created: boolean;
}

/** The snapshot, plus who it is about. */
export interface ChildSnapshotResult {
  readonly childUserId: string;
  readonly snapshot: ChildSnapshot;
}
