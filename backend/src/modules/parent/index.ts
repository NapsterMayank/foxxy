import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { createNoopAudit, type AuditPort } from '@/platform/audit/index';
import type { Clock } from '@/platform/clock/index';
import type { Logger } from '@/platform/logger/index';
import type { BilingualText } from '@/platform/notify-channel/index';
import { createEvidenceDigestWriter, type DigestWriter } from './parent.digest-writer';
import { createParentRepository, type ParentDbHandle } from './parent.repository';
import { registerParentRoutes } from './parent.routes';
import { createParentService, type ParentService } from './parent.service';
import type {
  ChildProfileReader,
  LinkRevoker,
  LinkStatusReader,
  LinkedChildrenReader,
  TenantReader,
} from './parent.types';

/**
 * ============================================================================
 * parent — THE PUBLIC SURFACE.
 *
 * This is the only file another module may import (00-ARCHITECTURE.md,
 * Foundation 1, enforced by ESLint `no-restricted-imports`). Everything else in
 * this directory is private.
 *
 * Owns: the weekly snapshot, the weekly digest, transcript access and consent
 * (plan §8.7). Calls no other module — the link status, the account tenant, the
 * child's profile and the link revocation all arrive as injected functions, so
 * every cross-module edge lives in `app/routes.ts` and nowhere else.
 * ============================================================================
 *
 * THE FOUR THINGS ABOUT THIS MODULE MOST LIKELY TO BE UNDONE BY ACCIDENT.
 *
 * 1. THE RESOURCE TENANT IS READ FROM `users`, NEVER OFF THE ACTOR (D-091).
 *    `readTenantOfStudent` is what makes `assertCanAccess` a check rather than
 *    a comparison of a value with itself. It costs one indexed read per call
 *    and somebody will eventually propose removing it as a hot-path
 *    optimisation — which is the exact justification `notify` used, in a
 *    comment, while enforcing nothing. `parent.authz-mutation.test.ts` installs
 *    that mistake deliberately and proves a cross-tenant read then succeeds.
 *
 * 2. EVERY DENY IS THE SAME CONTENTLESS 403. "Not linked", "no such child", "a
 *    pending link", "a revoked link" and "another tenant" are byte-identical to
 *    a caller, because they all take one path through the guard. A helpful 404
 *    for "no such child" would be a child-existence oracle — a parent could
 *    discover which student accounts exist by trying ids. There is a test that
 *    compares the raw response bodies of all four.
 *
 * 3. THE DIGEST NEVER INVENTES A MISCONCEPTION AND NEVER PRINTS A PERCENTAGE.
 *    `distractor_misconceptions` is NULL corpus-wide (D-077), so most weeks
 *    genuinely have none — the composer says what improved instead, and
 *    `checkDigestHonesty` refuses any draft that names an unobserved code,
 *    whether it came from the deterministic writer or from a language model.
 *
 * 4. THIS MODULE WRITES ONE TABLE: `weekly_digests`. It READS five others,
 *    deliberately (it is a reporting consumer — see the repository header), but
 *    a link is revoked by asking `identity`, never by an UPDATE here.
 */

export interface ParentModuleDeps {
  /** §3.1: parent is ordinary request traffic and gets the `core` pool. */
  readonly db: ParentDbHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Identity's session validator, passed in rather than imported. */
  readonly requireSession: preHandlerAsyncHookHandler;

  /** Read at query time so a revocation is effective immediately (§7 rule 3). */
  readonly readLinkStatus: LinkStatusReader;
  /** `users.tenant_id`, read from the DATA and never off the actor (D-091). */
  readonly readTenantOfStudent: TenantReader;
  readonly listLinkedChildren: LinkedChildrenReader;
  readonly readChildProfile: ChildProfileReader;
  /** identity's `revokeLink`. `parent_child_links` is not this module's table. */
  readonly revokeLink: LinkRevoker;

  /**
   * How a digest gets written.
   *
   * Defaults to the deterministic evidence composer, which is not a placeholder
   * — it reads real rows and names a real misconception when one exists. Swap
   * in `createLlmDigestWriter(llm)` when `platform/llm` has an adapter; nothing
   * else in this module changes, and the honesty gate still applies.
   */
  readonly writer?: DigestWriter;
  /**
   * Consent changes and transcript reads are audited.
   *
   * Defaults to the no-op so existing harnesses keep working; `app/routes.ts`
   * always supplies the real one and a test asserts that it does.
   */
  readonly audit?: AuditPort;
}

/**
 * The seam `notify` fills its weekly digest job from.
 *
 * Structurally identical to notify's `DigestSource`, and NOT imported from it:
 * `parent` reaching into `@/modules/notify` for a type would be a cross-module
 * import, which is exactly what `app/routes.ts` exists to prevent (D-051). The
 * composition root satisfies notify's interface with this object, and the
 * compiler checks the two shapes agree at that one line.
 */
export interface ParentDigestSource {
  findParentsDue(weekStart: Date): Promise<readonly { readonly parentUserId: string }[]>;
  buildDigest(input: {
    readonly parentUserId: string;
    readonly weekStart: Date;
  }): Promise<{
    readonly title: BilingualText;
    readonly body: BilingualText;
    readonly data?: Readonly<Record<string, unknown>>;
  } | null>;
}

export interface ParentModule {
  readonly service: ParentService;
  /** Registers the six `/parent/…` endpoints under `/api/v1`. */
  registerRoutes(app: FastifyInstance): void;
  /** Handed to `createNotifyModule` at the composition root. */
  readonly digestSource: ParentDigestSource;
}

/** The digest notification's title. Prose lives in the digest itself. */
const DIGEST_TITLE: BilingualText = Object.freeze({
  en: 'Your child’s week',
  hi: 'आपके बच्चे का सप्ताह',
});

export function createParentModule(deps: ParentModuleDeps): ParentModule {
  const service = createParentService({
    repository: createParentRepository(deps.db),
    clock: deps.clock,
    logger: deps.logger,
    readLinkStatus: deps.readLinkStatus,
    readTenantOfStudent: deps.readTenantOfStudent,
    listLinkedChildren: deps.listLinkedChildren,
    readChildProfile: deps.readChildProfile,
    revokeLink: deps.revokeLink,
    writer: deps.writer ?? createEvidenceDigestWriter(),
    audit: deps.audit ?? createNoopAudit(),
  });

  const digestSource: ParentDigestSource = {
    async findParentsDue(): Promise<readonly { readonly parentUserId: string }[]> {
      const parents = await service.listParentsDue();
      return parents.map((parentUserId) => ({ parentUserId }));
    },

    /**
     * Builds every approved child's digest for this parent and returns ONE
     * notification covering them.
     *
     * NULL WHEN THERE IS NOTHING TO SAY AT ALL — which here means "this parent
     * has no approved child", not "this child had a quiet week". A quiet week
     * still produces a digest with a graceful message (§8.7), because a parent
     * hearing nothing cannot tell "they did not practise" from "the email
     * failed".
     */
    async buildDigest(input): Promise<{
      readonly title: BilingualText;
      readonly body: BilingualText;
      readonly data?: Readonly<Record<string, unknown>>;
    } | null> {
      const generated = await service.buildWeeklyDigestFor(input.parentUserId, input.weekStart);
      if (generated.length === 0) return null;

      return {
        title: DIGEST_TITLE,
        body: {
          en: generated.map((entry) => entry.digest.summary.en).join('\n\n'),
          hi: generated.map((entry) => entry.digest.summary.hi).join('\n\n'),
        },
        // IDENTIFIERS AND COUNTS ONLY. `notify` persists this payload, and a
        // notification's `data` is not a place for a child's name.
        data: { children: generated.length },
      };
    },
  };

  return {
    service,
    digestSource,
    registerRoutes(app: FastifyInstance): void {
      registerParentRoutes(app, { service, requireSession: deps.requireSession });
    },
  };
}

/**
 * ---------------------------------------------------------------------------
 * The use-cases, as named in §8.7. Each is reached through `module.service`,
 * and each calls `assertCanAccess` BEFORE it touches anything.
 *
 *   getChildren        The parent's approved children. Never a pending link —
 *                      a pending link grants nothing and listing it invites a
 *                      client to render it like an approved one.
 *   getSnapshot        Four counts and one trend, from real practice rows.
 *                      Plain language, both languages, never a percentage.
 *   getDigest          The stored digest for a week, or null. A GET never
 *                      generates.
 *   generateDigest     Idempotent per (parent, child, week), twice over: a
 *                      pre-check that avoids the work, and a unique constraint
 *                      that settles two concurrent callers.
 *   getChildTranscript Read-only, with the child-visibility flag always
 *                      present, and an audit row on every read.
 *   getConsentState    What this parent may see, and that the child was asked.
 *   revokeConsent      Immediate. The next request is refused, because status
 *                      is read at query time and nothing is cached.
 * ---------------------------------------------------------------------------
 */
export type { ParentService } from './parent.service';
export { TRANSCRIPT_PAGE_LIMIT } from './parent.service';

/** The digest writer port, its two adapters, and the honesty gate. */
export { createEvidenceDigestWriter, createLlmDigestWriter } from './parent.digest-writer';
export type { DigestWriter } from './parent.digest-writer';
export { DIGEST_VIOLATIONS, checkDigestHonesty } from './domain/digest-honesty';
export type { DigestViolation } from './domain/digest-honesty';

/** Week arithmetic, pinned against notify's by a test. */
export { previousWeekStart, weekKeyOf, weekStartOf, weekWindowOf } from './domain/week-window';

/** The injected-dependency shapes `app/routes.ts` has to satisfy. */
export type {
  ChildProfile,
  ChildProfileReader,
  ChildSnapshotResult,
  ChildTranscript,
  ConsentRevocation,
  ConsentState,
  DigestGeneration,
  DigestRecord,
  LinkRevoker,
  LinkStatusReader,
  LinkedChildLink,
  LinkedChildrenReader,
  ParentActor,
  ParentChild,
  TenantReader,
} from './parent.types';
