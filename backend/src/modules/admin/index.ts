import type { FastifyInstance } from 'fastify';
import type { AuditPort } from '@/platform/audit/index';
import type { CachePort } from '@/platform/cache/index';
import type { Clock } from '@/platform/clock/index';
import type { Logger } from '@/platform/logger/index';
import { RateLimitError } from '@/platform/errors/index';
import { createRequireAdmin, type SessionPreHandler } from '@/shared/http/require-admin';
import { REVEAL_LIMIT } from './domain/reveal';
import { createAdminDataRepository } from './admin.data.repository';
import { createAdminDataService } from './admin.data.service';
import { createAdminRepository, type AdminDbHandle } from './admin.repository';
import { registerAdminRoutes, ADMIN_PREFIX } from './admin.routes';
import { createAdminService, type AdminService } from './admin.service';

/**
 * ============================================================================
 * admin — THE PUBLIC SURFACE.
 *
 * The only file another module may import. Everything else here is private.
 *
 * Owns NO TABLES. That is the defining fact about this module and the reason it
 * is allowed to exist at all: it reads across `iam`, school, practice, foxy,
 * billing, jobs, metrics and audit, which no other module may do, and it is
 * permitted to because it cannot change any of them. A write belongs to the
 * module that owns the table, always, and there is no exception coming.
 *
 * ----------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT ROUTES SCATTERED THROUGH THE EIGHT IT READS.
 *
 * Scattering was considered and is worse in the way that matters: it would mean
 * eight separate role checks and eight separate audit implementations, and the
 * one that got it wrong would be an open door nobody could find by reading a
 * single file. One module means one gate, one audit path, and one place to
 * review before this is exposed to anything.
 *
 * ----------------------------------------------------------------------------
 * IT CALLS NO OTHER MODULE. Not `identity`, not `practice`, not `foxy`. Their
 * services are all self-scoped by design — `foxy.listSessions` returns the
 * ACTOR's sessions — so reading anybody's through them would mean adding a
 * "list anyone's" query to eight modules plus a bypass to `assertCanAccess`.
 * That would put new leak surface in eight places to avoid a read model in one.
 * ============================================================================
 */

export interface AdminModuleDeps {
  /** §3.1: admin reads are operator traffic, not learner traffic. */
  readonly db: AdminDbHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Every admin read writes a row here. One of the three things standing in
   * for the tenant guard this module deliberately does not use.
   */
  readonly audit: AuditPort;
  /** Backs the overview count cache. See `OVERVIEW_CACHE_SECONDS`. */
  readonly cache: CachePort;
  /** Identity's session validator, injected — no cross-module import. */
  readonly requireSession: SessionPreHandler;
  /** `/health/ready` of this API, probed by the signal collector. */
  readonly readinessUrl: string;
  /** Backup directory, when one is configured. Absent = signal unmeasured. */
  readonly backupDir?: string | undefined;
}

export interface AdminModule {
  readonly service: AdminService;
  registerRoutes(app: FastifyInstance): void;
}

export function createAdminModule(deps: AdminModuleDeps): AdminModule {
  const service = createAdminService({
    repository: createAdminRepository(deps.db),
    clock: deps.clock,
    logger: deps.logger,
    audit: deps.audit,
    cache: deps.cache,
    signalDb: deps.db,
    readinessUrl: deps.readinessUrl,
    backupDir: deps.backupDir,
  });

  /**
   * The data reads get their own repository and service, sharing the handle
   * and the audit port. Two pairs rather than one: monitoring answers "is the
   * system healthy" and this answers "what happened to this learner", and they
   * have nothing in common but the constraint that neither may write.
   */
  const data = createAdminDataService({
    repository: createAdminDataRepository(deps.db),
    audit: deps.audit,
  });

  /**
   * The reveal throttle, built here so the routes file holds no cache.
   *
   * A counter with a TTL rather than the platform limiter: this needs one
   * counter per actor per hour and nothing the limiter adds — no burst policy,
   * no per-route keying, no fallback metric. `incr` is atomic, and `expire` on
   * the first increment is what makes the window roll.
   *
   * A CACHE FAILURE DOES NOT OPEN THE GATE. If the counter cannot be read the
   * reveal is refused, because the alternative is that losing a cache silently
   * removes the only limit on bulk disclosure — the exact moment it matters.
   */
  const throttleReveal = async (actorUserId: string): Promise<void> => {
    const key = `admin:reveal:${actorUserId}`;
    let count: number;
    try {
      count = await deps.cache.incr(key);
      if (count === 1) await deps.cache.expire(key, REVEAL_LIMIT.windowSeconds);
    } catch {
      // `RateLimitError` takes retry-after SECONDS, not a message — its safe
      // message is fixed so a limiter cannot leak a policy detail to a caller.
      throw new RateLimitError(REVEAL_LIMIT.windowSeconds, {
        message: 'admin.reveal: throttle counter unavailable, refusing rather than opening',
      });
    }
    if (count > REVEAL_LIMIT.max) {
      throw new RateLimitError(REVEAL_LIMIT.windowSeconds, {
        message: `admin.reveal: actor exceeded ${String(REVEAL_LIMIT.max)} reveals per hour`,
      });
    }
  };

  const requireAdmin = createRequireAdmin({ requireSession: deps.requireSession });

  return {
    service,
    registerRoutes(app: FastifyInstance): void {
      registerAdminRoutes(app, { service, data, requireAdmin, throttleReveal });
    },
  };
}

export { ADMIN_PREFIX };
export type { AdminService } from './admin.service';
export type { AdminDataService } from './admin.data.service';
export type { AdminActor } from './admin.types';
