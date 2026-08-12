import { AUDIT_ACTIONS, AUDIT_RESOURCES, type AuditPort } from '@/platform/audit/index';
import { createAccessGuard, type StudentScope } from '@/platform/authz/index';
import type { Clock } from '@/platform/clock/index';
import { InternalError } from '@/platform/errors/index';
import type { Logger } from '@/platform/logger/index';
import type { BilingualText } from '@/platform/notify-channel/index';
import { checkDigestHonesty } from './domain/digest-honesty';
import type { DigestEvidence } from './domain/digest-evidence';
import { buildSnapshot, type WeekActivity } from './domain/snapshot';
import { previousWeekStart, weekKeyOf, weekStartOf, weekWindowOf } from './domain/week-window';
import type { DigestWriter } from './parent.digest-writer';
import type { ParentRepository } from './parent.repository';
import type {
  ChildProfileReader,
  ChildSnapshotResult,
  ChildTranscript,
  ConsentRevocation,
  ConsentState,
  DigestGeneration,
  DigestRecord,
  LinkRevoker,
  LinkStatusReader,
  LinkedChildrenReader,
  ParentActor,
  ParentChild,
  TenantReader,
  TranscriptVisibility,
} from './parent.types';
import { CONSENT_SCOPES } from './parent.types';

/**
 * The parent use-cases — 01-BACKEND-IMPLEMENTATION-PLAN.md §8.7.
 *
 * ===========================================================================
 * THE PARENT-CHILD LINK IS THE ONLY CROSS-USER DATA PATH IN THE PRODUCT, AND
 * THIS FILE IS WHERE IT IS WALKED. EVERY METHOD CALLS `assertCanAccess` FIRST.
 *
 * Not "every method that seems to need it". All seven, including `getChildren`,
 * whose target is the actor themselves and which therefore cannot fail the
 * check today. Those are exactly the methods that become dangerous later, when
 * an admin tool starts passing a different id and the guard that "was not
 * needed" is still absent.
 *
 * THREE RULES, AND EACH ONE HAS A TEST THAT BREAKS IT DELIBERATELY
 * (`__tests__/parent.authz-mutation.test.ts`):
 *
 *  1. THE RESOURCE TENANT IS RESOLVED FROM THE DATA, NEVER FROM THE ACTOR.
 *     `authoriseChild` reads `users.tenant_id` through the injected
 *     `readTenantOfStudent`. Passing `actor.tenantId` would satisfy the type
 *     and make the guard compare a value with itself — a check that always
 *     passes, in the shape of one that sometimes fails. That is D-091, found
 *     in `notify` after it had shipped, and it is the mistake most likely to
 *     be repeated here.
 *
 *  2. LINK STATUS IS READ AT QUERY TIME, EVERY TIME. Never cached, never on the
 *     session. A revocation takes effect on the parent's very next request —
 *     there is a test that reads successfully, revokes, and reads again inside
 *     the same test.
 *
 *  3. THE DENY PATH CARRIES NO PAYLOAD. "Not linked", "no such child", "a
 *     pending link" and "another tenant" all produce the SAME contentless 403,
 *     because they all take the same path through the guard. A distinguishable
 *     404 would be a child-existence oracle: a parent could discover which
 *     student accounts exist by trying ids.
 *
 * That last one is why nothing in this file throws `NotFoundError` for a child.
 * An unknown student resolves to the empty-string tenant, which the guard
 * treats as "no tenant" and DENIES — routed through the guard rather than
 * short-circuited here, because byte-identical output is only guaranteed if
 * both cases take the same code path.
 * ===========================================================================
 *
 * The clock is injected. There is no `new Date()` in this file and there must
 * never be one.
 */

export interface ParentServiceDeps {
  readonly repository: ParentRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Read at query time so a revocation is effective immediately (§7 rule 3). */
  readonly readLinkStatus: LinkStatusReader;
  /** The RESOURCE side of the tenant comparison, read from `users` (D-091). */
  readonly readTenantOfStudent: TenantReader;
  readonly listLinkedChildren: LinkedChildrenReader;
  readonly readChildProfile: ChildProfileReader;
  /** identity's `revokeLink` — `parent_child_links` is not this module's table. */
  readonly revokeLink: LinkRevoker;
  /** Deterministic today; one argument swaps in a model. */
  readonly writer: DigestWriter;
  /** Consent changes and transcript reads are audited. Never throws. */
  readonly audit: AuditPort;
}

export interface ParentService {
  getChildren(actor: ParentActor): Promise<readonly ParentChild[]>;
  getSnapshot(actor: ParentActor, childUserId: string, at?: Date): Promise<ChildSnapshotResult>;
  getDigest(actor: ParentActor, childUserId: string, at?: Date): Promise<DigestRecord | null>;
  generateDigest(actor: ParentActor, childUserId: string, at?: Date): Promise<DigestGeneration>;
  getChildTranscript(actor: ParentActor, childUserId: string, limit: number): Promise<ChildTranscript>;
  getConsentState(actor: ParentActor, childUserId: string): Promise<ConsentState>;
  revokeConsent(actor: ParentActor, childUserId: string): Promise<ConsentRevocation>;
  /**
   * SYSTEM-LEVEL, for the weekly job. No actor exists in a worker.
   *
   * Authorised entirely FROM THE DATA: the approved link and both tenants are
   * read out of `parent_child_links` and `users`, and a mismatched pair is
   * skipped. There is no argument a caller could supply to widen the set.
   */
  buildWeeklyDigestFor(parentUserId: string, weekStart: Date): Promise<DigestGeneration[]>;
  /** SYSTEM-LEVEL. Every parent holding at least one approved link. */
  listParentsDue(): Promise<readonly string[]>;
}

/** How many transcript sessions one request may return. */
export const TRANSCRIPT_PAGE_LIMIT = 20;

/**
 * WHAT THE CHILD IS TOLD, VERBATIM.
 *
 * The flag and this wording are the product's honesty, not a detail: a parent
 * reading a child's conversations is a surveillance capability, and the only
 * thing separating it from surveillance is that the child knows. So the exact
 * sentence the child is shown is part of the parent's response too — the two
 * cannot drift apart if there is one copy of it.
 */
const TRANSCRIPT_VISIBILITY: TranscriptVisibility = Object.freeze({
  parentCanView: true,
  childIsTold: true,
  disclosure: Object.freeze({
    en: 'Your parent can read your chats with Foxy. You can see this in your settings, and you can ask them to remove their access.',
    hi: 'आपके माता-पिता फ़ॉक्सी के साथ आपकी बातचीत पढ़ सकते हैं। यह आपकी सेटिंग्स में दिखता है, और आप उनसे अपनी पहुँच हटाने को कह सकते हैं।',
  }),
});

const CONSENT_NOTICE: BilingualText = Object.freeze({
  en: 'You can see your child’s weekly summary, their digest and their chats with Foxy. Your child was asked before this was switched on, and either of you can switch it off at any time.',
  hi: 'आप अपने बच्चे का साप्ताहिक सारांश, उनका डाइजेस्ट और फ़ॉक्सी के साथ उनकी बातचीत देख सकते हैं। यह चालू करने से पहले आपके बच्चे से अनुमति ली गई थी, और आप दोनों में से कोई भी इसे कभी भी बंद कर सकता है।',
});

export function createParentService(deps: ParentServiceDeps): ParentService {
  const { repository, clock, logger } = deps;

  /**
   * Authorises one operation against one child's data. THE ONLY DOOR.
   *
   * The link status is fetched HERE, immediately before the decision, and
   * handed to a guard built for that single call — `createAccessGuard` takes a
   * SYNCHRONOUS reader by design (D-001), and this is what "read at query time"
   * means in practice.
   *
   * Returns the tenant that was checked, so anything written afterwards is
   * filed under the tenant the check passed on rather than under whatever the
   * actor claimed.
   */
  async function authoriseChild(
    actor: ParentActor,
    childUserId: string,
    scope: StudentScope,
  ): Promise<string> {
    const status = await deps.readLinkStatus(actor.userId, childUserId);

    /**
     * THE RESOURCE'S TENANT, READ FROM `users` — D-091.
     *
     * There is NO self short-circuit here, unlike `learner`. A parent is never
     * the child, so every call is a real lookup; and an unknown child resolves
     * to `''`, which `assertCanAccess` treats as "no tenant" and denies. Routed
     * through the guard rather than thrown here so that "no such child" and "a
     * child in another tenant" produce byte-identical output — which they only
     * do if both take the same path.
     */
    const tenantId = (await deps.readTenantOfStudent(childUserId)) ?? '';

    const guard = createAccessGuard({ readLinkStatus: () => status });
    guard.assertCanAccess(actor, 'read', {
      kind: 'student-data',
      studentUserId: childUserId,
      scope,
      tenantId,
    });

    return tenantId;
  }

  /**
   * Authorises the actor against their OWN account.
   *
   * D-091 IN ITS ORIGINAL FORM: the tenant is read from `users` through the
   * same injected reader, NOT copied off `actor.tenantId`. That is the exact
   * short-circuit `notify` justified as a hot-path optimisation and which made
   * `assertTenantMatch` compare a value with itself. One indexed read is the
   * price of the check actually being a check.
   */
  async function authoriseSelf(actor: ParentActor): Promise<string> {
    const tenantId = (await deps.readTenantOfStudent(actor.userId)) ?? '';
    const guard = createAccessGuard({ readLinkStatus: () => null });
    guard.assertCanAccess(actor, 'read', {
      kind: 'account',
      ownerUserId: actor.userId,
      tenantId,
    });
    return tenantId;
  }

  /** The link this parent holds on this child. Only ever called post-guard. */
  async function requireLink(
    actor: ParentActor,
    childUserId: string,
  ): Promise<{ linkId: string; approvedAt: Date | null }> {
    const children = await deps.listLinkedChildren(actor);
    const link = children.find((candidate) => candidate.studentUserId === childUserId);
    if (link === undefined) {
      /**
       * UNREACHABLE THROUGH THE GUARD, and thrown rather than defaulted.
       *
       * `assertCanAccess` has already confirmed an APPROVED link exists, so
       * `getLinkedChildren` disagreeing with `isLinkApproved` means the two
       * disagree about the same table. That is a defect in this system, so it
       * is a 500 with no detail — not a 404, which would be a different answer
       * for a caller who has already been authorised.
       */
      throw new InternalError({
        message: 'parent.service: authorised for a child with no approved link row',
      });
    }
    return { linkId: link.linkId, approvedAt: link.approvedAt };
  }

  /** Assembles one week of evidence from real rows. */
  async function readEvidence(
    childUserId: string,
    tenantId: string,
    weekStart: Date,
  ): Promise<DigestEvidence> {
    const window = weekWindowOf(weekStart);
    const [activity, chapters, misconceptions, effort] = await Promise.all([
      repository.readWeekActivity(childUserId, tenantId, window),
      repository.readChapterWeeks(childUserId, tenantId, window),
      repository.readMisconceptions(childUserId, tenantId, window),
      repository.readEffortSignals(childUserId, tenantId, window),
    ]);

    return {
      weekStart: window.from,
      activity,
      chapters,
      misconceptions,
      recoveries: effort.recoveries,
      hintsUsed: effort.hintsUsed,
    };
  }

  /**
   * Writes one digest, idempotently, for a (parent, child, week) already
   * authorised by the caller.
   *
   * THE HONESTY GATE RUNS ON EVERY DRAFT, from every writer. A violation is an
   * `InternalError`: a dishonest digest is a defect in this system, never
   * something the parent did, and the client is told nothing.
   */
  async function writeDigest(
    parentUserId: string,
    childUserId: string,
    tenantId: string,
    weekStart: Date,
  ): Promise<DigestGeneration> {
    const week = weekKeyOf(weekStart);

    // THE FIRST OF TWO IDEMPOTENCE CHECKS. This one avoids the work; the
    // unique constraint below is what actually guarantees the property, since
    // two concurrent callers both pass this one.
    const existing = await repository.findDigest(parentUserId, childUserId, week);
    if (existing !== null) return { digest: existing, created: false };

    const evidence = await readEvidence(childUserId, tenantId, weekStart);
    const draft = await deps.writer.write(evidence);

    const violations = checkDigestHonesty(draft, evidence);
    if (violations.length > 0) {
      logger.error(
        { event: 'parent.digest_refused', writer: deps.writer.kind, violations },
        'a digest draft was refused by the honesty gate',
      );
      throw new InternalError({
        message: `parent.service: digest refused (${violations.join(', ')})`,
        details: { writer: deps.writer.kind, violations },
      });
    }

    const summary: BilingualText = {
      en: draft.lines.map((line) => line.en).join('\n'),
      hi: draft.lines.map((line) => line.hi).join('\n'),
    };

    const { created } = await repository.insertDigest({
      parentUserId,
      studentUserId: childUserId,
      weekStart: week,
      summary,
      suggestedAction: draft.suggestedAction,
      misconceptionCode: draft.misconceptionCode,
      sessionsCount: evidence.activity.sessions,
      questionsAnswered: evidence.activity.questionsAnswered,
      daysPractised: evidence.activity.daysPractised,
      chapterId: evidence.chapters[0]?.chapterId ?? null,
      tenantId,
      generatedAt: clock.now(),
    });

    const digest = await repository.findDigest(parentUserId, childUserId, week);
    if (digest === null) {
      throw new InternalError({ message: 'parent.service: digest vanished after insert' });
    }

    // COUNTS ONLY. This line describes personal data and must not become it —
    // no parent id, no child id, no digest text.
    logger.info(
      { event: 'parent.digest_generated', created, writer: deps.writer.kind },
      'weekly digest generated',
    );

    return { digest, created };
  }

  /**
   * Distinguishes "there was no previous week" from "the previous week was
   * quiet", without a second query.
   *
   * A previous week with zero sessions could mean either — unless this child
   * has done something at some point, in which case a quiet week is a real
   * observation. This is deliberately conservative: with no evidence either
   * way it reports `first_week`, which claims less.
   */
  function previousOrNull(previous: WeekActivity, current: WeekActivity): WeekActivity | null {
    if (previous.sessions > 0) return previous;
    // The child practised this week and not last week: that IS a comparison.
    return current.sessions > 0 ? previous : null;
  }
  return {
    /**
     * §8.7 — the parent's children.
     *
     * APPROVED LINKS ONLY, and the list comes from `identity`, which is the
     * module that owns `parent_child_links`. A pending link appears nowhere
     * here: it grants nothing, and listing it beside the approved ones invites
     * a client to render both the same way.
     */
    async getChildren(actor: ParentActor): Promise<readonly ParentChild[]> {
      await authoriseSelf(actor);

      const links = await deps.listLinkedChildren(actor);
      const children: ParentChild[] = [];
      for (const link of links) {
        // `getProfile` runs the guard AGAIN, on `learner`'s side, for each
        // child. Redundant by design: this list is the one place a child id
        // reaches this module without a caller having supplied it, and a second
        // independent check costs one indexed read.
        const profile = await deps.readChildProfile(actor, link.studentUserId);
        children.push({
          linkId: link.linkId,
          childUserId: link.studentUserId,
          displayName: profile.displayName,
          grade: profile.grade,
          approvedAt: link.approvedAt,
        });
      }
      return children;
    },

    /** §8.7 — the weekly snapshot. Four numbers and one trend, from real rows. */
    async getSnapshot(
      actor: ParentActor,
      childUserId: string,
      at?: Date,
    ): Promise<ChildSnapshotResult> {
      const tenantId = await authoriseChild(actor, childUserId, 'progress');

      const weekStart = weekStartOf(at ?? clock.now());
      const previousStart = previousWeekStart(weekStart);

      const [activity, previous] = await Promise.all([
        repository.readWeekActivity(childUserId, tenantId, weekWindowOf(weekStart)),
        repository.readWeekActivity(childUserId, tenantId, weekWindowOf(previousStart)),
      ]);

      /**
       * "NO PREVIOUS WEEK" AND "A PREVIOUS WEEK WITH NOTHING IN IT" ARE
       * DIFFERENT FACTS, and the snapshot reports them differently.
       *
       * A family in their first week has nothing to compare against; a family
       * who skipped last week has a comparison, and it is unflattering. Passing
       * an empty week for both would round the first case into the second.
       */
      const snapshot = buildSnapshot({
        weekStart,
        activity,
        previous: previousOrNull(previous, activity),
      });

      return { childUserId, snapshot };
    },

    /**
     * §8.7 — the stored digest for a week, or null.
     *
     * A GET NEVER GENERATES. Reading a page must not write a row, and a digest
     * built on demand at 11pm on Sunday would report a different week from the
     * one the Monday job will send. `null` says plainly that this week's has
     * not been produced yet.
     */
    async getDigest(actor: ParentActor, childUserId: string, at?: Date): Promise<DigestRecord | null> {
      await authoriseChild(actor, childUserId, 'progress');
      const week = weekKeyOf(at ?? clock.now());
      return repository.findDigest(actor.userId, childUserId, week);
    },

    /** §8.7 — generation, idempotent per (parent, child, week). */
    async generateDigest(
      actor: ParentActor,
      childUserId: string,
      at?: Date,
    ): Promise<DigestGeneration> {
      const tenantId = await authoriseChild(actor, childUserId, 'progress');
      const weekStart = weekStartOf(at ?? clock.now());
      return writeDigest(actor.userId, childUserId, tenantId, weekStart);
    },

    /**
     * §8.7 — the child's Foxy conversations, READ ONLY.
     *
     * Every successful read writes an audit row. That is not bookkeeping: the
     * child-visibility flag says a parent CAN look, and the audit row is the
     * durable record of when they DID — which is what makes "your child can see
     * that you can read this" a statement about the system rather than about
     * our intentions.
     */
    async getChildTranscript(
      actor: ParentActor,
      childUserId: string,
      limit: number,
    ): Promise<ChildTranscript> {
      const tenantId = await authoriseChild(actor, childUserId, 'chat');
      const result = await repository.readTranscript(childUserId, tenantId, limit);

      await deps.audit.record({
        actor: { userId: actor.userId, role: actor.role, tenantId: actor.tenantId },
        action: AUDIT_ACTIONS.PARENT_TRANSCRIPT_VIEWED,
        resourceType: AUDIT_RESOURCES.USER,
        resourceId: childUserId,
        // IDENTIFIERS AND COUNTS ONLY. Never a message, never a name, never an
        // email — a record OF a privacy-sensitive read must not itself be one.
        metadata: { sessions: result.sessions.length, available: result.present },
      });

      return {
        childUserId,
        source: result.present ? 'foxy' : 'not_yet_available',
        sessions: result.sessions,
        visibility: TRANSCRIPT_VISIBILITY,
        readOnly: true,
      };
    },

    /** §8.7 — what this parent may see, and that the child was asked. */
    async getConsentState(actor: ParentActor, childUserId: string): Promise<ConsentState> {
      await authoriseChild(actor, childUserId, 'profile');
      const link = await requireLink(actor, childUserId);

      return {
        childUserId,
        linkId: link.linkId,
        status: 'approved',
        approvedAt: link.approvedAt,
        canView: CONSENT_SCOPES,
        childIsInformed: true,
        notice: CONSENT_NOTICE,
      };
    },

    /**
     * §8.7 — the parent gives up their own access.
     *
     * REVOCATION IS IMMEDIATE. It is `identity` that writes the row, and every
     * authorisation in this module re-reads the status, so the parent's very
     * next request is refused. Nothing is cached and nothing needs invalidating
     * — there is a test that reads successfully, revokes, and reads again.
     *
     * A SECOND REVOKE IS A CONTENTLESS 403, not a 200. Once the link is
     * revoked, `authoriseChild` refuses exactly as it does for a parent who
     * never had one — which is the same rule that makes the four deny paths
     * indistinguishable, applied to this method too.
     */
    async revokeConsent(actor: ParentActor, childUserId: string): Promise<ConsentRevocation> {
      await authoriseChild(actor, childUserId, 'profile');
      const link = await requireLink(actor, childUserId);

      await deps.revokeLink(actor, link.linkId);

      const revokedAt = clock.now();
      await deps.audit.record({
        actor: { userId: actor.userId, role: actor.role, tenantId: actor.tenantId },
        /**
         * A SEPARATE ACTION FROM `identity.link_revoked`, which identity also
         * writes for this same revocation.
         *
         * Deliberate duplication: the identity row records that a link changed
         * state, by either party. This one records that a PARENT withdrew their
         * own access through the parent portal — a different question, asked by
         * different people (a support agent, a school, a regulator), and one
         * that a query over `identity.link_revoked` cannot answer without
         * joining to the role of an actor who may have changed role since.
         */
        action: AUDIT_ACTIONS.PARENT_CONSENT_REVOKED,
        resourceType: AUDIT_RESOURCES.PARENT_CHILD_LINK,
        resourceId: link.linkId,
        metadata: { scopes: CONSENT_SCOPES.length },
      });

      return { childUserId, linkId: link.linkId, status: 'revoked', revokedAt };
    },

    /**
     * SYSTEM-LEVEL — the worker's per-parent digest build.
     *
     * AUTHORISED FROM THE DATA AND NOTHING ELSE. There is no actor in a worker,
     * so there is nothing to trust: the approved links and both sides' tenants
     * come out of `parent_child_links` and `users`, and a pair whose tenants
     * differ is SKIPPED. That is the same rule the request path enforces
     * through `assertCanAccess`, expressed the only way it can be without a
     * session — and it is why this method takes no tenant argument that a
     * caller could get wrong.
     */
    async buildWeeklyDigestFor(parentUserId: string, weekStart: Date): Promise<DigestGeneration[]> {
      const links = await repository.listApprovedChildrenOf(parentUserId);
      const generated: DigestGeneration[] = [];

      for (const link of links) {
        if (link.parentTenantId !== link.studentTenantId) {
          logger.warn(
            { event: 'parent.digest_cross_tenant_skipped' },
            'skipped an approved link whose two sides are in different tenants',
          );
          continue;
        }
        generated.push(
          await writeDigest(parentUserId, link.studentUserId, link.studentTenantId, weekStart),
        );
      }
      return generated;
    },

    listParentsDue(): Promise<readonly string[]> {
      return repository.listParentsWithApprovedChildren();
    },
  };
}

