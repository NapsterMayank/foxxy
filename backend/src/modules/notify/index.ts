import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { CachePort } from '@/platform/cache/index';
import type { Clock } from '@/platform/clock/index';
import type { Logger } from '@/platform/logger/index';
import type { MetricsPort } from '@/platform/metrics/index';
import type { Channel, NotificationDispatcher } from '@/platform/notify-channel/index';
import { createCachePreferencesStore, type NotifyPreferencesStore } from './notify.preferences-store';
import { createNotifyRepository, type NotifyDbHandle } from './notify.repository';
import { registerNotifyRoutes } from './notify.routes';
import {
  createNotifyService,
  type DigestSource,
  type NotifyJobEnqueuer,
  type NotifyService,
} from './notify.service';
import type { RecipientReader } from './notify.types';

/**
 * ============================================================================
 * notify — THE PUBLIC SURFACE.
 *
 * This is the only file another module may import (00-ARCHITECTURE.md,
 * Foundation 1, enforced by ESLint `no-restricted-imports`). Everything else in
 * this directory is private.
 *
 * Owns: the `notifications` table, the kind-to-channel routing table, per-user
 * preferences, quiet hours, frequency caps, and the two worker jobs that carry
 * remote delivery and the weekly digest (plan §8.9).
 *
 * Calls no other module. The one thing it needs from identity — a recipient's
 * tenant and email address — arrives as an injected function so the cross-module
 * edge lives in `app/routes.ts` and nowhere else.
 * ============================================================================
 *
 * THE FOUR THINGS ABOUT THIS MODULE MOST LIKELY TO BE UNDONE BY ACCIDENT.
 *
 * 1. CHANNEL SELECTION IS A TABLE, NOT A BRANCH. `domain/kinds.ts` maps kind to
 *    an ordered channel list, and no file in this module names a channel in an
 *    `if`. That is what makes 05-ROADMAP.md §4's Phase 2 WhatsApp digest a ROW
 *    EDIT plus an adapter, rather than a rewrite of every call site. A test
 *    delivers through a channel the service has never heard of, to prove it.
 *
 * 2. `in-app` IS ABSENT FROM EVERY ROW ON PURPOSE. It is not a routing choice —
 *    it is the durable record, written synchronously in the request, always,
 *    and it cannot be opted out of. Adding it to a row would give the worker a
 *    second chance to write the same notification.
 *
 * 3. EMAIL NEVER RUNS IN A REQUEST. `send` writes the in-app row and enqueues a
 *    job; the worker does the rest. An outbound SMTP call in a request path is
 *    how a slow provider becomes a slow product, and it is also why "a mail-port
 *    failure does not break the calling flow" (§8.9) is structurally true here
 *    rather than carefully handled.
 *
 * 4. QUIET HOURS DEFER, THEY DO NOT DROP. An ordinary kind raised at 23:00 is
 *    delivered at 07:00, not discarded. A suppression that leaves no trace is
 *    the same failure as a delivery that silently never arrives.
 *
 * ---------------------------------------------------------------------------
 * KNOWN GAP, REPORTED RATHER THAN HIDDEN: preferences are held in
 * `platform/cache` because a `notification_preferences` table needs a migration
 * and this module was built while the migration chain was being rewritten. The
 * shape is behind `NotifyPreferencesStore`, so the swap is one line at the
 * composition root. A lost preference reverts to the defaults, which are
 * strictly more conservative (quiet hours on, nothing opted out) — see the long
 * note in `notify.preferences-store.ts`.
 * ---------------------------------------------------------------------------
 */

export interface NotifyModuleDeps {
  /** §3.1: notify is ordinary request traffic and gets the `core` pool. */
  readonly db: NotifyDbHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: MetricsPort;
  /** Frequency-cap counters and (for now) preferences. See the gap note. */
  readonly cache: CachePort;
  /**
   * The in-app adapter, called directly. It is the durable record rather than
   * one channel among equals — see point 2 in the header.
   */
  readonly inAppChannel: Channel;
  /** The remote fan-out, already carrying this module's routing table. */
  readonly dispatcher: NotificationDispatcher;
  /** Where `send` posts the remote-delivery job. Enqueue only. */
  readonly queue: NotifyJobEnqueuer;
  /**
   * Identity's session validator, passed in rather than imported — the same
   * reason as `learner`: the dependency stays declared in `app/routes.ts`,
   * which is also the complete list of who depends on whom.
   */
  readonly requireSession: preHandlerAsyncHookHandler;
  /**
   * A recipient's tenant and email address, read from `users`.
   *
   * INJECTED. It is what gives `notifications.tenant_id` a real value on every
   * row this module writes — D-084's named mechanism, "resolve the tenant from
   * the recipient".
   */
  readonly readRecipient: RecipientReader;
  /**
   * The weekly-digest content seam, filled by the `parent` module (§8.7).
   *
   * ABSENT TODAY, and its absence is load-bearing: with no source, the worker
   * registers no digest handlers at all, so a stray digest job fails with "no
   * handler registered" rather than succeeding without doing the work.
   */
  readonly digest?: DigestSource;
  /** Test seam: substitute a durable store once the table exists. */
  readonly preferences?: NotifyPreferencesStore;
}

export interface NotifyModule {
  /** Every notify use-case. The only object other modules should hold. */
  readonly service: NotifyService;
  /** Registers the four `/notifications` endpoints under `/api/v1`. */
  registerRoutes(app: FastifyInstance): void;
  /** True when the digest seam is wired — the worker asks before registering. */
  readonly hasDigestSource: boolean;
}

export function createNotifyModule(deps: NotifyModuleDeps): NotifyModule {
  const service = createNotifyService({
    repository: createNotifyRepository(deps.db),
    preferences:
      deps.preferences ??
      createCachePreferencesStore({ cache: deps.cache, logger: deps.logger }),
    inAppChannel: deps.inAppChannel,
    dispatcher: deps.dispatcher,
    queue: deps.queue,
    cache: deps.cache,
    clock: deps.clock,
    logger: deps.logger,
    metrics: deps.metrics,
    readRecipient: deps.readRecipient,
    ...(deps.digest === undefined ? {} : { digest: deps.digest }),
  });

  return {
    service,
    hasDigestSource: deps.digest !== undefined,
    registerRoutes(app: FastifyInstance): void {
      registerNotifyRoutes(app, { service, requireSession: deps.requireSession });
    },
  };
}

/**
 * ---------------------------------------------------------------------------
 * The use-cases, as named in §8.9 plus the worker's two entry points.
 *
 *   send                 Writes the in-app row and queues remote delivery.
 *                        SYSTEM-LEVEL: no actor, no endpoint. Applies the daily
 *                        cap and the quiet-hours plan.
 *   listForUser          The caller's own notifications, newest first, keyset
 *                        paginated. Never anybody else's.
 *   markRead             Marks one read. Idempotent; the row's owner is read
 *                        from the row before the guard runs.
 *   markAllRead          Clears the badge. Idempotent.
 *   getUnreadCount       The badge, as a count over a partial index.
 *   deliver              The worker's remote-delivery handler. Idempotent by
 *                        compare-and-set; throws to request a retry; records a
 *                        dead letter and a metric on the final attempt.
 *   scanWeeklyDigests    The weekly scan. Enqueues one delivery per due parent,
 *                        idempotent per (parent, week) through the job key.
 *   deliverWeeklyDigest  Builds one parent's digest through the `parent` seam
 *                        and sends it. Idempotent per (parent, week) durably.
 * ---------------------------------------------------------------------------
 */
export {
  NOTIFY_DELIVER_JOB,
  NOTIFY_DIGEST_DELIVER_JOB,
  NOTIFY_DIGEST_SCAN_JOB,
} from './notify.service';
export type {
  DigestCandidate,
  DigestContent,
  DigestSource,
  ListNotificationsInput,
  ListNotificationsResult,
  NotifyJobEnqueuer,
  NotifyService,
} from './notify.service';

/** The routing table, and the policy the dispatcher is built with. */
export {
  KIND_POLICY,
  NOTIFY_KINDS,
  NOTIFY_METRICS,
  isNotifyKind,
  toChannelPolicy,
} from './domain/kinds';
export type { KindPolicy, NotifyKind, NotifyUrgency } from './domain/kinds';

/** Preferences: the defaults, the resolver, and the store port. */
export {
  DEFAULT_PREFERENCES,
  DEFAULT_QUIET_HOURS,
  DEFAULT_TIMEZONE,
  resolvePreferences,
} from './domain/preferences';
export type { NotifyPreferences, StoredPreferences } from './domain/preferences';
export { createCachePreferencesStore } from './notify.preferences-store';
export type { NotifyPreferencesStore } from './notify.preferences-store';

/** Week arithmetic, shared with the worker's scheduler. */
export { digestScanKey, weekKey, weekStartOf } from './domain/digest-week';

/** A notification and a send, as other modules see them. */
export type {
  DeliveryOutcome,
  NotificationRecord,
  NotifyRecipient,
  RecipientReader,
  SendNotificationInput,
  SendResult,
} from './notify.types';
