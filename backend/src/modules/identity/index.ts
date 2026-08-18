import {
  randomBytes as cryptoRandomBytes,
  randomInt as cryptoRandomInt,
  randomUUID as cryptoRandomUUID,
} from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AuditPort } from '@/platform/audit/index';
import type { CachePort } from '@/platform/cache/index';
import type { Clock } from '@/platform/clock/index';
import type { Logger } from '@/platform/logger/index';
import type { MailPort } from '@/platform/mail/index';
import { createRequireSession, type SessionCookieOptions } from './identity.plugin';
import { createArgon2PasswordHasher } from './identity.password-hasher';
import { createIdentityRepository, type IdentityDbHandle } from './identity.repository';
import { registerIdentityRoutes } from './identity.routes';
import type { MetricsSink } from './identity.rate-limit';
import { createIdentityService, type IdentityService } from './identity.service';
import type { PasswordHasher, SessionActor } from './identity.types';

/**
 * ============================================================================
 * identity — THE PUBLIC SURFACE.
 *
 * This is the only file another module may import (00-ARCHITECTURE.md,
 * Foundation 1, enforced by ESLint `no-restricted-imports`). Everything else
 * in this directory is private.
 *
 * Owns: users, credentials, sessions, verification and reset tokens, and
 * parent-child links. Calls no other module.
 * ============================================================================
 *
 * A NOTE ON WHERE LINK CODES LIVE, because it is a deliberate departure from
 * the schema table in §4 and should not be discovered later by surprise.
 *
 * §4 puts `link_code` and `code_expires_at` on `parent_child_links`. That
 * table's `parent_user_id` is NOT NULL, and §6.8 has the STUDENT issue a code
 * BEFORE any parent is known — so there is no parent id to put in the row at
 * the moment the code is created. The two cannot both be satisfied.
 *
 * The first resolution put an issued code in `platform/cache` under a key that
 * expires in 15 minutes. That bought "one active code per student" and the
 * expiry for free — and gave away durability. A cache restart silently
 * invalidated every outstanding code, so a parent entering a code their child
 * had just read aloud was told it was invalid: intermittent, unreproducible,
 * and in the middle of the onboarding funnel.
 *
 * ---------------------------------------------------------------------------
 * RESOLVED, 8 August 2026 — codes are rows in `link_codes` (migration
 * `0001_link_codes`), reached through three repository functions:
 *
 *     issueLinkCode({ studentUserId, code, expiresAt, now })
 *     consumeLinkCode({ code, now })            -> { studentUserId } | null
 *     findActiveLinkCodeForStudent(studentUserId, now)
 *
 * "One active code per student" is a PARTIAL UNIQUE INDEX on
 * `student_user_id WHERE consumed_at IS NULL` — enforced by Postgres, not
 * promised by this module, and with no application-level emulation of it left
 * anywhere in the service. Expiry is `expires_at`, compared against the
 * INJECTED clock.
 *
 * `platform/cache` is now used for RATE-LIMIT COUNTERS ONLY. The standing rule
 * this episode produced: nothing whose loss changes what a user is allowed to
 * do may live in a cache. See D-012, D-021 and D-033.
 * ---------------------------------------------------------------------------
 */

export interface IdentityModuleDeps {
  readonly db: IdentityDbHandle;
  readonly cache: CachePort;
  readonly mail: MailPort;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly session: SessionCookieOptions;
  /**
   * THE TENANT THIS DEPLOYMENT SERVES — D-073.
   *
   * Signup has no authenticated actor to inherit a tenant from, so it is
   * supplied here from `config.tenancy.defaultTenantId`. Never read from a
   * request: a client-supplied tenant would let anyone choose which school's
   * namespace to join.
   */
  readonly defaultTenantId: string;
  readonly urls: {
    /** Backend origin. The verification link in email points here. */
    readonly apiBaseUrl: string;
    /** Frontend origin. Where a verified account is redirected. */
    readonly appBaseUrl: string;
  };
  /** Test seam: substitute a fast hasher so a suite is not Argon2-bound. */
  readonly hasher?: PasswordHasher;
  /**
   * Where the rate-limit in-process-fallback metric is emitted (D-034).
   * Optional until a metrics port exists; a missing sink means the `warn` log
   * line is the only signal, which is why that line is unconditional.
   */
  readonly metrics?: MetricsSink;
  /**
   * The append-only record of privileged actions — 05-ROADMAP.md §8.
   *
   * Four actions in this module write to it: password reset, logout-all, link
   * approval and link revocation. The link pair are the CONSENT TRAIL, which is
   * the artefact a school or a regulator asks for when the question is how a
   * parent came to have access to a minor's data.
   *
   * Optional, defaulting to a no-op, so the existing harnesses keep working
   * unchanged. `app/routes.ts` always passes the real one.
   */
  readonly audit?: AuditPort;
  /**
   * THE SALT FOR EVERY IDENTIFIER HASH IN THIS MODULE — D-221.
   *
   * `hashIp` was a bare SHA-256. There are 2^32 IPv4 addresses, so an unsalted
   * digest over that space is a rainbow table anybody can build in minutes:
   * `sessions.ip_hash` was pseudonymised in name only. The same digest also
   * appeared as a rate-limit cache key, making it a stable cross-store
   * correlator that joins a cache dump to a database dump exactly.
   *
   * OPTIONAL HERE AND REQUIRED ONE LAYER DOWN, deliberately. The service takes
   * `ipHashSalt: string` with no default, so nothing INSIDE the module can
   * forget it; at this boundary — the composition edge, where the harnesses and
   * `app/routes.ts` meet — it may be omitted.
   *
   * IT IS NOT READ FROM `process.env` HERE, and an earlier draft of this fix did
   * exactly that. `no-restricted-properties` forbids it in as many words: the
   * environment is parsed ONCE, in `platform/config`, into a frozen object, so
   * that the set of variables the process depends on is enumerable in one file
   * rather than discovered by grep. A module reaching around that is how a
   * deployment acquires an undocumented required variable.
   *
   * WHEN IT IS NOT SUPPLIED the module logs at `warn` and uses
   * `UNCONFIGURED_IP_HASH_SALT` below. That is a REAL but PARTIAL fix and is
   * labelled as such rather than dressed up: it removes the generic
   * precomputed-rainbow-table attack over the IPv4 space and it does NOT defend
   * against anyone holding this source. The durable fix is an
   * `IDENTITY_IP_HASH_SALT` entry in `platform/config` threaded through
   * `app/routes.ts` into this field — two files this module does not own, so the
   * change is REPORTED rather than reached across for, and the warn line above
   * is what makes the gap visible in the meantime.
   */
  readonly ipHashSalt?: string;
}

/**
 * The salt used when none is configured. NOT a secret and documented as not one.
 *
 * A constant here is strictly better than no salt — it breaks every precomputed
 * SHA-256 table, and it is stable across processes and restarts, which an
 * per-process random salt would not be. That stability is not cosmetic: the
 * digest is a rate-limit cache KEY, so a salt that differed per instance would
 * silently turn the shared cross-instance counter into a per-instance one, which
 * is the in-process-fallback security downgrade of D-034 arriving by accident and
 * with no warning line.
 */
export const UNCONFIGURED_IP_HASH_SALT = 'identity.unconfigured-ip-hash-salt.v1';

/**
 * The variable `platform/config` should parse when the durable fix lands, named
 * here so that the reported change and the code that consumes it agree.
 *
 * Declared and NOT read: this module never touches `process.env` (see
 * `ipHashSalt`). It is a constant for the config owner to point at.
 */
export const IP_HASH_SALT_ENV_VAR = 'IDENTITY_IP_HASH_SALT';

function resolveIpHashSalt(deps: IdentityModuleDeps): string {
  const explicit = deps.ipHashSalt;
  if (explicit !== undefined && explicit.length > 0) return explicit;

  deps.logger.warn(
    { event: 'identity.ip_hash_salt_unconfigured', envVar: IP_HASH_SALT_ENV_VAR },
    'no IP-hash salt configured: identifier hashes fall back to a build constant, which is not secret',
  );
  return UNCONFIGURED_IP_HASH_SALT;
}

export interface IdentityModule {
  /** Every identity use-case. The only object other modules should hold. */
  readonly service: IdentityService;
  /** Registers the identity endpoints under `/api/v1`. */
  registerRoutes(app: FastifyInstance): Promise<void>;
  /**
   * The session-validation preHandler (§6.5), for other modules' routes.
   * Attaches `{ userId, role }` to the request and nothing else.
   */
  readonly requireSession: ReturnType<typeof createRequireSession>;
}

/**
 * Builds the identity module and wires its internals.
 *
 * Randomness is bound here, at the edge, rather than reached for inside the
 * domain: `crypto.randomBytes` for tokens and `crypto.randomInt` for link
 * codes. `randomInt` rejects-and-retries rather than taking a modulo, so a
 * 31-character alphabet stays uniform — a modulo would quietly bias the first
 * few characters, and no test would notice.
 */
export function createIdentityModule(deps: IdentityModuleDeps): IdentityModule {
  const repository = createIdentityRepository(deps.db);
  const hasher = deps.hasher ?? createArgon2PasswordHasher();
  // Resolved ONCE. Two resolutions could disagree, and the service's keys and
  // the routes' `ip_hash` must be the same function or the rate limit silently
  // counts a different thing than the column records.
  const ipHashSalt = resolveIpHashSalt(deps);

  const service = createIdentityService({
    repository,
    cache: deps.cache,
    hasher,
    mail: deps.mail,
    clock: deps.clock,
    logger: deps.logger,
    randomBytes: (size: number): Uint8Array => cryptoRandomBytes(size),
    randomInt: (max: number): number => cryptoRandomInt(max),
    randomUuid: (): string => cryptoRandomUUID(),
    sessionTtlDays: deps.session.ttlDays,
    ipHashSalt,
    // D-073 — from configuration, never from a request body.
    defaultTenantId: deps.defaultTenantId,
    urls: deps.urls,
    ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
    ...(deps.audit === undefined ? {} : { audit: deps.audit }),
  });

  return {
    service,
    registerRoutes(app: FastifyInstance): Promise<void> {
      return registerIdentityRoutes(app, {
        service,
        cookie: deps.session,
        postVerifyRedirectUrl: `${deps.urls.appBaseUrl}/onboarding`,
        ipHashSalt,
      });
    },
    requireSession: createRequireSession({ service, cookie: deps.session }),
  };
}

/**
 * ---------------------------------------------------------------------------
 * The use-cases, as named in §8.1. Each is reached through `module.service`.
 *
 *   signup                 Creates an account and mails a verification link. An
 *                          address that already exists yields the IDENTICAL
 *                          result and mails its owner instead.
 *   resendVerification     Re-mails a verification link (D-291) — the recovery
 *                          path D-217's fire-and-forget send assumed and which
 *                          did not exist. Constant response for an unknown, an
 *                          unverified and an already-verified address.
 *   verifyEmail            Consumes a single-use token, marks the address
 *                          verified, and issues a session — one transaction.
 *   login                  Authenticates and issues a fresh session token.
 *                          Rate limited before any database work.
 *   logout                 Deletes one session. Idempotent.
 *   logoutAll              Deletes every session for the user.
 *   validateSession        Resolves a token to `{ userId, role }`, renewing it
 *                          when older than 24 hours.
 *   requestPasswordReset   Mails a one-hour reset token. Never reveals whether
 *                          the address exists.
 *   resetPassword          Sets a new password and deletes EVERY session, in
 *                          one transaction.
 *   generateLinkCode       Issues a student's 6-character code. One active code
 *                          per student, 15-minute expiry.
 *   getActiveLinkCode      The student's outstanding code, or null — so a screen
 *                          can show it again instead of replacing it.
 *   submitLinkCode         A parent redeems a code, creating a PENDING link
 *                          that grants nothing.
 *   approveLink            The student consents. This is the step that grants
 *                          access.
 *   revokeLink             Either party ends the link, effective immediately.
 *   getLinkedChildren      A parent's approved children.
 *   isLinkApproved         Whether a parent-child link is approved, read at
 *                          query time.
 *   getTenantOfUser        The tenant an account belongs to — the resource side
 *                          of the tenant comparison (D-073).
 *   getNotificationRecipient
 *                          Tenant plus VERIFIED email address, for `notify`.
 *                          An unverified address comes back null.
 *   assertParentCanReadChild
 *                          Throws a contentless ForbiddenError unless the
 *                          actor may read that student's data. The entry point
 *                          other modules use.
 * ---------------------------------------------------------------------------
 */
export type { IdentityService, NotificationRecipient } from './identity.service';

/** The authenticated caller: `{ userId, role }`, never the user row. */
export type { SessionActor };

/** A parent-child link and a parent's approved child, as other modules see them. */
export type { LinkRecord, LinkedChildRecord, PasswordHasher } from './identity.types';

/** Where the rate-limit fallback metric is emitted. See D-034. */
export type { MetricsSink } from './identity.rate-limit';

/** Cookie policy for the session token: httpOnly, secure, sameSite=lax. */
export type { SessionCookieOptions } from './identity.plugin';

/** Thrown on login when the password is right but the address is unverified. */
export { EmailNotVerifiedError } from './identity.service';
