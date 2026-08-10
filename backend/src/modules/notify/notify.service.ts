import { createAccessGuard } from '@/platform/authz/index';
import type { CachePort } from '@/platform/cache/index';
import type { Clock } from '@/platform/clock/index';
import { ForbiddenError, NotFoundError } from '@/platform/errors/index';
import type { EnqueueInput, EnqueueResult, JobRecord } from '@/platform/jobs/index';
import type { Logger } from '@/platform/logger/index';
import type { MetricsPort } from '@/platform/metrics/index';
import type {
  Channel,
  ChannelMessage,
  ChannelName,
  ChannelRecipient,
  NotificationDispatcher,
} from '@/platform/notify-channel/index';
import { planDelivery } from './domain/delivery-plan';
import {
  FREQUENCY_CAP_TTL_SECONDS,
  digestJobKey,
  frequencyCapKey,
  weekKey,
  weekStartOf,
} from './domain/digest-week';
import { KIND_POLICY, NOTIFY_METRICS, type NotifyKind } from './domain/kinds';
import { resolvePreferences, type NotifyPreferences } from './domain/preferences';
import type { NotifyRepository } from './notify.repository';
import type { NotifyPreferencesStore } from './notify.preferences-store';
import type {
  DeliveryJobPayload,
  DeliveryOutcome,
  NotificationRecord,
  NotifyActor,
  NotifyRecipient,
  RecipientReader,
  SendNotificationInput,
  SendResult,
} from './notify.types';

/**
 * The notify use-cases — 01-BACKEND-IMPLEMENTATION-PLAN.md §8.9.
 *
 * This layer ORCHESTRATES: it authorises, loads, calls domain functions and
 * persists. Every decision that could be expressed as a calculation lives in
 * `domain/` and is unit-tested with no database: which channels a kind uses,
 * whether an instant is inside quiet hours, when the window ends, which week a
 * date belongs to.
 *
 * The clock is injected. There is no `new Date()` in this file and there must
 * never be one.
 *
 * ===========================================================================
 * THE SHAPE OF A SEND, AND WHY IT IS TWO PHASES.
 *
 *   PHASE 1, IN THE REQUEST: write the in-app row. One INSERT, no network,
 *   returns an id. The person has now been told.
 *
 *   PHASE 2, IN THE WORKER: everything that leaves the process — email today,
 *   WhatsApp in Phase 2, push in Phase 3.
 *
 * An outbound SMTP call in a request path is how a slow provider becomes a slow
 * product: the mail port has a timeout and a breaker, so a dead provider costs
 * the request its timeout rather than hanging it, and that is still a timeout
 * charged to a user who was doing something else entirely. Moving it to the
 * queue also gives retries with backoff and a dead-letter path for free, which
 * an inline call cannot have — there is nobody to retry to.
 *
 * The two phases together are what makes "a mail-port failure does not break
 * the calling flow" (§8.9) structurally true rather than carefully handled: the
 * calling flow never touches the mail port at all.
 *
 * ===========================================================================
 * `send` TAKES NO ACTOR, AND THAT IS DELIBERATE.
 *
 * Every other data-touching method here takes one and calls `assertCanAccess`.
 * `send` does not, because there is no actor: the caller is the system —
 * `billing` reacting to a webhook, `identity` recording a link request, the
 * worker building a digest. Inventing an actor for it would mean either a
 * synthetic "system" principal that the authz boundary has to grant everything
 * to, or the CALLER's actor, which is wrong in the common case (the person who
 * triggered a link request is not the person being notified).
 *
 * `send` is therefore not reachable over HTTP. There is no endpoint for it, the
 * same way `learner.updateMastery` has none: a route would let anyone write
 * into anyone's inbox.
 *
 * What protects the recipient instead is that `send` resolves the tenant FROM
 * THE RECIPIENT and files the row under it, so a notification can never be
 * addressed into a tenant it does not belong to.
 */

/** The job kinds this module owns. Registered by `worker/worker.ts`. */
export const NOTIFY_DELIVER_JOB = 'notify.deliver_notification';
export const NOTIFY_DIGEST_SCAN_JOB = 'notify.scan_weekly_digests';
export const NOTIFY_DIGEST_DELIVER_JOB = 'notify.deliver_weekly_digest';

/** The narrow slice of `JobQueue` this module needs. Enqueue only. */
export interface NotifyJobEnqueuer {
  enqueue(input: EnqueueInput): Promise<EnqueueResult>;
}

/**
 * The seam the `parent` module fills.
 *
 * §8.7 owns the weekly digest: it reads the child's Foxy traces and practice
 * results, asks the language model for a five-line summary, and names a
 * misconception and one concrete action. NONE of that is notify's business —
 * notify knows when to ask and how to deliver the answer, and nothing else.
 *
 * IT IS OPTIONAL AT THE COMPOSITION ROOT, AND THAT IS THE POINT. When no
 * `DigestSource` is supplied, the two digest job kinds are NOT REGISTERED with
 * the worker at all. PROGRESS.md §7 is explicit about why a stub would be
 * worse: "a registered handler that does nothing lets a job succeed without
 * doing the work, which is worse than the 'no handler' error the runner
 * raises". So the absence of `parent` is loud rather than green.
 */
export interface DigestCandidate {
  readonly parentUserId: string;
}

export interface DigestContent {
  readonly title: ChannelMessage['title'];
  readonly body: ChannelMessage['body'];
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface DigestSource {
  /** Parents who should receive a digest for the week beginning `weekStart`. */
  findParentsDue(weekStart: Date): Promise<readonly DigestCandidate[]>;
  /**
   * Builds one parent's digest, or null when the week produced nothing worth
   * sending. §8.7 asks for "a graceful message rather than an empty digest" —
   * that judgement belongs to `parent`, which is why this may return content
   * for a quiet week rather than being forced to return null.
   */
  buildDigest(input: {
    readonly parentUserId: string;
    readonly weekStart: Date;
  }): Promise<DigestContent | null>;
}

export interface NotifyServiceDeps {
  readonly repository: NotifyRepository;
  readonly preferences: NotifyPreferencesStore;
  /**
   * The in-app adapter, called DIRECTLY rather than through the dispatcher.
   *
   * In-app is not a routing choice — see the header of `domain/kinds.ts`. It is
   * the durable record, it is written in the request, and it must happen
   * exactly once. Sending it through the dispatcher would put it in the same
   * fan-out as the remote channels, which run later in a different process, and
   * would give the worker a second opportunity to write the same row.
   */
  readonly inAppChannel: Channel;
  /**
   * The remote fan-out. Holds the MECHANISM; this module supplies the POLICY
   * (`toChannelPolicy()`), wired at the composition root.
   */
  readonly dispatcher: NotificationDispatcher;
  readonly queue: NotifyJobEnqueuer;
  /** Frequency-cap counters ONLY. Nothing here decides what a user may do. */
  readonly cache: CachePort;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: MetricsPort;
  /** Injected — `users` is identity's table. See `RecipientReader`. */
  readonly readRecipient: RecipientReader;
  /** Absent until the `parent` module exists. See `DigestSource`. */
  readonly digest?: DigestSource;
}

export interface ListNotificationsInput {
  readonly limit: number;
  readonly before?: Date | undefined;
}

export interface ListNotificationsResult {
  readonly notifications: readonly NotificationRecord[];
  readonly nextBefore: Date | null;
  readonly unreadCount: number;
}

export interface NotifyService {
  /** §8.9. System-level: no actor, no endpoint. See the header. */
  send(input: SendNotificationInput): Promise<SendResult>;
  listForUser(actor: NotifyActor, input: ListNotificationsInput): Promise<ListNotificationsResult>;
  markRead(
    actor: NotifyActor,
    notificationId: string,
  ): Promise<{ readonly changed: boolean; readonly unreadCount: number }>;
  markAllRead(
    actor: NotifyActor,
  ): Promise<{ readonly marked: number; readonly unreadCount: number }>;
  getUnreadCount(actor: NotifyActor): Promise<number>;
  /** The worker's entry point. Idempotent; throws to request a retry. */
  deliver(job: JobRecord): Promise<DeliveryOutcome>;
  /** The weekly scan. Enqueues one delivery per due parent. */
  scanWeeklyDigests(): Promise<number>;
  /** Builds and sends one parent's digest. Idempotent per (parent, week). */
  deliverWeeklyDigest(parentUserId: string, weekStart: Date): Promise<SendResult | null>;
}

/**
 * Every deny in this module is the same contentless 403.
 *
 * `assertCanAccess` produces it, and the resource kind is `account`: a
 * notification belongs to the person it is addressed to and to nobody else.
 * Notably NOT `student-data` — that kind carries the parent-child rule, and a
 * parent must not read a child's notifications. A child's inbox may hold a
 * link-revocation notice or a payment message; "a parent may observe their
 * child's learning" is not "a parent may read their child's mail".
 *
 * The link reader is therefore `() => null` and is never consulted: the
 * `account` branch of the guard compares ownership and returns before any link
 * lookup. Wiring a real reader here would suggest a rule that does not exist.
 */
const guard = createAccessGuard({ readLinkStatus: () => null });

export function createNotifyService(deps: NotifyServiceDeps): NotifyService {
  const { repository, clock, logger, metrics } = deps;

  /**
   * Authorises one operation against one person's notifications.
   *
   * `ownerUserId` and `tenantId` ALWAYS come from data — from the row for
   * anything addressed by id, from `users` for the `/notifications` endpoints.
   * Never from the actor. See `authoriseSelf` for why that distinction is the
   * whole of D-073.
   */
  function authorise(
    actor: NotifyActor,
    action: 'read' | 'write',
    ownerUserId: string,
    tenantId: string,
  ): void {
    guard.assertCanAccess(actor, action, { kind: 'account', ownerUserId, tenantId });
  }

  /**
   * Authorises an actor against THEIR OWN inbox, and returns the tenant that
   * was checked.
   *
   * ==========================================================================
   * THE TENANT IS READ FROM `users`, NOT TAKEN FROM THE ACTOR — D-073.
   *
   * This function used to be one line: `authorise(actor, action, actor.userId,
   * actor.tenantId)`, justified by "the target IS the actor, so the two tenants
   * are the same value by definition". They are not. `actor.tenantId` is a
   * CLAIM — it arrives on a session row, a JSON body or a cast — and passing it
   * as the resource tenant makes `assertTenantMatch` compare a value with
   * itself. That is a check that always passes, written in the shape of a check
   * that sometimes fails, which `can-access.ts` names explicitly as the thing
   * not to do. The endpoint was tenant-enforced only in appearance.
   *
   * It is worth being precise about the size of the hole, because it was not
   * cosmetic. `listForUser`, `markAllRead` and `getUnreadCount` then went on to
   * SCOPE THEIR QUERIES by that same unverified `actor.tenantId`. So an actor
   * whose session tenant did not match their row's tenant did not get somebody
   * else's mail — they got an empty list. The damage was in the other
   * direction: the day tenancy stops being one deployment-wide constant, the
   * only thing standing between a claimed tenant and a real one on these three
   * endpoints was a `where` clause. "Enforced by remembering to write the
   * predicate" is exactly the failure mode `platform/authz` exists to remove.
   *
   * THE COST, STATED RATHER THAN AVOIDED: one indexed lookup on `users` per
   * call, including the unread-badge poll. The previous version's speed came
   * from not performing the check. `learner` short-circuits self-access for the
   * same reason and is right to — its resource kind is `student-data`, whose
   * rules turn on the parent-child link, and its `/me/…` routes cannot be
   * reached without a session that already produced the actor. This module
   * takes the round trip instead: the badge is a count over a partial index,
   * and one more primary-key read is a cheaper thing to spend than the property
   * that the tenant boundary is real on every path.
   *
   * A RECIPIENT THAT CANNOT BE RESOLVED resolves to the empty string, which
   * `assertCanAccess` treats as "no tenant" and DENIES — routed through the
   * guard rather than thrown here, so "no such account" and "an account in
   * another tenant" produce byte-identical output. They only do that if both
   * take the same path.
   *
   * RETURNED so every query below is scoped by the tenant that was CHECKED
   * rather than by the one that was claimed. That is what makes the repository
   * predicate belt-and-braces instead of the only belt.
   */
  async function authoriseSelf(actor: NotifyActor, action: 'read' | 'write'): Promise<string> {
    const recipient = await deps.readRecipient(actor.userId);
    const tenantId = recipient?.tenantId ?? '';
    // The owner id comes from the same row as the tenant, so BOTH sides of the
    // comparison are data. `recipient.userId` equals `actor.userId` by
    // construction today; reading it back rather than echoing the argument is
    // what keeps that a fact about the data instead of a fact about this line.
    authorise(actor, action, recipient?.userId ?? '', tenantId);
    return tenantId;
  }

  /**
   * Resolves the row's owner and authorises against it — for the one endpoint
   * that takes an identifier.
   *
   * A MISSING ROW AND SOMEBODY ELSE'S ROW PRODUCE THE IDENTICAL 403. Not a 404
   * for the first: the difference is an oracle for "does this notification id
   * exist", and ids are guessable in bulk in a way that student names are not.
   * Both go through the guard so the two answers are byte-identical rather than
   * merely similar.
   *
   * Returns the ROW's tenant, for the same reason `authoriseSelf` does: the
   * update below is then scoped by the tenant that was checked rather than by
   * the one the caller claimed.
   */
  async function authoriseRow(
    actor: NotifyActor,
    action: 'read' | 'write',
    notificationId: string,
  ): Promise<string> {
    const owner = await repository.findOwner(notificationId);
    if (owner === null) {
      throw new ForbiddenError({
        message: 'Access denied: no such notification',
        details: { actorRole: actor.role, action, resourceKind: 'account' },
      });
    }
    authorise(actor, action, owner.recipientUserId, owner.tenantId);
    return owner.tenantId;
  }

  async function loadPreferences(userId: string): Promise<NotifyPreferences> {
    return resolvePreferences(await deps.preferences.read(userId));
  }

  function toChannelRecipient(
    recipient: NotifyRecipient,
    preferences: NotifyPreferences,
  ): ChannelRecipient {
    return {
      userId: recipient.userId,
      tenantId: recipient.tenantId,
      email: recipient.email,
      language: preferences.language,
    };
  }

  /**
   * Counts one send against the daily cap for its kind.
   *
   * FAILS OPEN. A cache outage lets the notification through rather than
   * silencing the product — a cap is a courtesy to the recipient, not a
   * security control, and the failure it prevents (a buggy caller sending the
   * same thing a thousand times) is far less likely than Valkey being briefly
   * unavailable. D-034's rate-limit fallback fails open for the same reason and
   * makes the same noise about it.
   */
  async function withinDailyCap(userId: string, kind: NotifyKind, now: Date): Promise<boolean> {
    const key = frequencyCapKey(userId, kind, now);
    try {
      const count = await deps.cache.incr(key);
      if (count === 1) {
        // Set the TTL immediately after the first increment. A counter created
        // without one is a counter that never resets — the defect that produced
        // a permanent lockout in the identity rate limiter.
        await deps.cache.expire(key, FREQUENCY_CAP_TTL_SECONDS);
      }
      return count <= KIND_POLICY[kind].dailyCap;
    } catch (error) {
      logger.warn(
        {
          event: 'notify.cap_unavailable',
          kind,
          err: error instanceof Error ? error.message : 'unknown cache failure',
        },
        'the notification frequency cap could not be counted; allowing the send',
      );
      return true;
    }
  }

  async function sendNotification(input: SendNotificationInput): Promise<SendResult> {
    const now = clock.now();

    const recipient = await deps.readRecipient(input.recipientUserId);
    if (recipient === null) {
      // A system caller naming an account that does not exist is a defect in
      // that caller, not a user-facing condition. Thrown so the job carrying it
      // fails loudly and eventually dead-letters, rather than being swallowed
      // into a `delivered: false` nobody reads.
      throw new NotFoundError('Notification recipient not found.', {
        message: 'notify.send: no such recipient account',
        details: { kind: input.kind },
      });
    }

    if (!(await withinDailyCap(recipient.userId, input.kind, now))) {
      metrics.counter(NOTIFY_METRICS.SUPPRESSED, 1, {
        kind: input.kind,
        reason: 'frequency_cap',
      });
      logger.info(
        { event: 'notify.suppressed', kind: input.kind, reason: 'frequency_cap' },
        'a notification was suppressed by its daily cap',
      );
      return {
        notificationId: null,
        created: false,
        suppressed: 'frequency_cap',
        scheduledChannels: [],
        deliverAfter: null,
      };
    }

    const preferences = await loadPreferences(recipient.userId);
    const plan = planDelivery({ kind: input.kind, preferences, at: now });

    const message: ChannelMessage = {
      kind: input.kind,
      title: input.title,
      body: input.body,
      ...(input.data === undefined ? {} : { data: input.data }),
    };

    // PHASE 1 — the durable record, in the request. The in-app channel is the
    // only one that cannot fail for a reason outside our control: it needs an
    // INSERT. It also stamps the tenant it was handed, which is D-084's named
    // mechanism for giving `notifications` a real tenant.
    const inApp = await deps.inAppChannel.send(toChannelRecipient(recipient, preferences), message);
    const notificationId = inApp.reference;

    if (!inApp.delivered || notificationId === undefined) {
      throw new Error(`notify.send: the in-app channel wrote no row (${inApp.reason ?? 'no id'})`);
    }

    metrics.counter(NOTIFY_METRICS.CREATED, 1, { kind: input.kind });

    if (plan.channels.length === 0) {
      // An in-app-only kind. No job, no queue row, one INSERT for the whole
      // send — see the `streak_reminder` row in the routing table.
      return {
        notificationId,
        created: true,
        scheduledChannels: [],
        deliverAfter: null,
      };
    }

    if (plan.deferred) {
      metrics.counter(NOTIFY_METRICS.DEFERRED, 1, { kind: input.kind });
    }

    // PHASE 2 — everything that leaves the process. Keyed by the notification
    // id, which is derived from the work and is therefore a legal idempotency
    // key: a retried enqueue is the same row, never a second delivery.
    const payload: DeliveryJobPayload = {
      notificationId,
      channels: [...plan.channels],
    };

    try {
      await deps.queue.enqueue({
        kind: NOTIFY_DELIVER_JOB,
        idempotencyKey: notificationId,
        payload,
        runAt: plan.sendAfter,
      });
    } catch (error) {
      // The in-app row already exists, so the person WILL find out. What is
      // lost is the email — and losing it silently is exactly the failure this
      // module refuses to have. Recorded on the row, counted, and logged at
      // `error`, so it is visible from three directions.
      await repository.recordDeliveryOutcome(notificationId, 'dead_letter', now);
      metrics.counter(NOTIFY_METRICS.DEAD_LETTER, 1, { kind: input.kind, stage: 'enqueue' });
      logger.error(
        {
          event: 'notify.enqueue_failed',
          kind: input.kind,
          err: error instanceof Error ? error.message : 'unknown queue failure',
        },
        'a notification was written in-app but its remote delivery could not be queued',
      );
      return { notificationId, created: true, scheduledChannels: [], deliverAfter: null };
    }

    return {
      notificationId,
      created: true,
      scheduledChannels: plan.channels,
      deliverAfter: plan.sendAfter,
    };
  }

  /**
   * Reads the delivery job's payload back out of jsonb.
   *
   * Validated rather than cast. A payload is written by one release and read by
   * another, so TypeScript's belief about its shape stands behind nothing —
   * and the worst outcome of a wrong cast here is a `channels` array holding
   * something that is not a channel name, which the dispatcher would resolve to
   * `undefined` and call `.send` on.
   */
  function readDeliveryPayload(job: JobRecord): DeliveryJobPayload | null {
    const notificationId = job.payload.notificationId;
    const channels = job.payload.channels;
    if (typeof notificationId !== 'string' || notificationId.length === 0) return null;
    if (!Array.isArray(channels)) return null;
    return {
      notificationId,
      channels: channels.filter((entry): entry is ChannelName => typeof entry === 'string'),
    };
  }

  async function dispatchRemote(
    notification: NotificationRecord,
    channels: readonly ChannelName[],
    job: JobRecord,
  ): Promise<DeliveryOutcome> {
    const now = clock.now();

    const recipient = await deps.readRecipient(notification.recipientUserId);
    if (recipient === null) {
      // The account was deleted between the send and the delivery. Nothing to
      // retry towards, so this is settled rather than failed.
      await repository.recordDeliveryOutcome(notification.id, 'undelivered', now);
      logger.warn(
        { event: 'notify.recipient_gone', kind: notification.kind },
        'a notification recipient no longer exists; remote delivery abandoned',
      );
      return 'undelivered';
    }

    const preferences = await loadPreferences(recipient.userId);

    /**
     * THE SERVICE NEVER NAMES A CHANNEL, AND THIS IS WHERE THAT IS VISIBLE.
     *
     * The dispatcher chooses from the policy the module handed it at wiring
     * time (`toChannelPolicy()`); this call only narrows that choice to what
     * the plan decided at send time, expressed as an opt-out. So adding a
     * channel is a row in `domain/kinds.ts` plus an adapter in the container —
     * this function does not change, and a test proves it by delivering
     * through a channel this file has never heard of.
     */
    const optOut = deps.dispatcher
      .channelsFor(notification.kind)
      .filter((channel) => !channels.includes(channel));

    const outcome = await deps.dispatcher.send(
      toChannelRecipient(recipient, preferences),
      {
        kind: notification.kind,
        title: notification.title,
        body: notification.body,
        data: notification.data,
      },
      { optOut },
    );

    if (outcome.delivered) {
      await repository.recordDeliveryOutcome(notification.id, 'delivered', clock.now());
      return 'delivered';
    }

    // NOTHING LANDED. The last attempt gets a dead-letter record and a metric
    // before the throw, because after the throw the queue marks the job `dead`
    // and this handler is never called again — there is no later moment at
    // which to say so.
    const finalAttempt = job.attempts >= job.maxAttempts;
    if (finalAttempt) {
      await repository.recordDeliveryOutcome(notification.id, 'dead_letter', clock.now());
      metrics.counter(NOTIFY_METRICS.DEAD_LETTER, 1, {
        kind: notification.kind,
        stage: 'delivery',
      });
      logger.error(
        {
          event: 'notify.dead_letter',
          kind: notification.kind,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
        },
        'a notification exhausted its delivery attempts and will never be sent remotely',
      );
    } else {
      // Released back to `failed` so the retry can claim it again. Without this
      // the claim marker would still read `in_progress` and the retry would
      // report a duplicate and succeed without sending anything.
      await repository.recordDeliveryOutcome(notification.id, 'failed', clock.now());
    }

    // Thrown either way. The runner turns a throw into `fail()`, which applies
    // the jittered backoff and, on the last attempt, the `dead` status. A
    // return here would mark the job succeeded and hide the failure completely.
    throw new Error(`notify.deliver: no channel delivered notification kind ${notification.kind}`);
  }

  return {
    send: sendNotification,

    async listForUser(
      actor: NotifyActor,
      input: ListNotificationsInput,
    ): Promise<ListNotificationsResult> {
      const tenantId = await authoriseSelf(actor, 'read');

      const notifications = await repository.list({
        recipientUserId: actor.userId,
        tenantId,
        limit: input.limit,
        before: input.before,
      });

      // The cursor is only offered when the page was FULL. A short page is the
      // end of the list, and handing back a cursor for it makes every client
      // issue one more request that always returns nothing.
      const oldest = notifications.at(-1);
      const nextBefore =
        notifications.length === input.limit && oldest !== undefined ? oldest.createdAt : null;

      return {
        notifications,
        nextBefore,
        unreadCount: await repository.countUnread({
          recipientUserId: actor.userId,
          tenantId,
        }),
      };
    },

    async markRead(
      actor: NotifyActor,
      notificationId: string,
    ): Promise<{ readonly changed: boolean; readonly unreadCount: number }> {
      // The row's tenant, not the actor's claim — the one endpoint that takes
      // an identifier already resolved it from the row it is about to touch.
      const tenantId = await authoriseRow(actor, 'write', notificationId);

      const changed = await repository.markRead({
        notificationId,
        recipientUserId: actor.userId,
        tenantId,
        now: clock.now(),
      });

      return {
        changed,
        unreadCount: await repository.countUnread({
          recipientUserId: actor.userId,
          tenantId,
        }),
      };
    },

    async markAllRead(
      actor: NotifyActor,
    ): Promise<{ readonly marked: number; readonly unreadCount: number }> {
      const tenantId = await authoriseSelf(actor, 'write');

      const marked = await repository.markAllRead({
        recipientUserId: actor.userId,
        tenantId,
        now: clock.now(),
      });

      return {
        marked,
        unreadCount: await repository.countUnread({
          recipientUserId: actor.userId,
          tenantId,
        }),
      };
    },

    async getUnreadCount(actor: NotifyActor): Promise<number> {
      const tenantId = await authoriseSelf(actor, 'read');
      return repository.countUnread({
        recipientUserId: actor.userId,
        tenantId,
      });
    },

    /**
     * §8.9 remote delivery, run by the worker.
     *
     * IDEMPOTENT BY COMPARE-AND-SET, not by hope. `claimDelivery` writes the
     * claim only if none is present, in one statement; the loser returns
     * `duplicate` and the job succeeds having sent nothing. That is what makes
     * `platform/jobs`' at-least-once guarantee — "EVERY HANDLER MUST BE
     * IDEMPOTENT. This is not advice." — actually hold for an email.
     */
    async deliver(job: JobRecord): Promise<DeliveryOutcome> {
      const payload = readDeliveryPayload(job);
      if (payload === null) {
        // Malformed payload. A retry cannot fix it, so it is recorded and
        // RETURNED rather than thrown — `platform/jobs` is explicit that a
        // handler which knows its input is unprocessable should record that and
        // return, because the work was to determine it.
        logger.error(
          { event: 'notify.bad_payload', jobId: job.id },
          'a delivery job carried an unusable payload and will not be retried',
        );
        return 'undelivered';
      }

      const notification = await repository.findForDelivery(payload.notificationId);
      if (notification === null) {
        logger.warn(
          { event: 'notify.notification_gone', jobId: job.id },
          'a delivery job referenced a notification that no longer exists',
        );
        return 'undelivered';
      }

      if (!(await repository.claimDelivery(notification.id, clock.now()))) {
        metrics.counter(NOTIFY_METRICS.DUPLICATE, 1, { kind: notification.kind });
        logger.info(
          { event: 'notify.duplicate_delivery', kind: notification.kind },
          'a delivery job ran for a notification that was already delivered',
        );
        return 'duplicate';
      }

      return dispatchRemote(notification, payload.channels, job);
    },

    /**
     * The weekly scan — SCHEDULING ONLY.
     *
     * It finds who is due and enqueues one job each. It does not build content,
     * does not read a child's practice history, and does not know what a digest
     * says. That is `parent`'s work, reached through `DigestSource`, and the
     * separation is what lets this half be finished and tested now.
     *
     * IDEMPOTENT PER (PARENT, WEEK) through the job key, which is the entire
     * mechanism — see `domain/digest-week.ts`. Ten replicas scanning on Monday
     * produce one digest per parent, with no "have I already done this" query
     * anywhere, because the unique index IS that query.
     */
    async scanWeeklyDigests(): Promise<number> {
      const source = deps.digest;
      if (source === undefined) {
        // Unreachable through the worker, which does not register this handler
        // without a source. Thrown rather than returning 0, because a scan that
        // silently found nobody is indistinguishable from a scan that worked.
        throw new Error('notify.scanWeeklyDigests: no DigestSource is wired');
      }

      const now = clock.now();
      const weekStart = weekStartOf(now);
      const candidates = await source.findParentsDue(weekStart);

      let enqueued = 0;
      for (const candidate of candidates) {
        const result = await deps.queue.enqueue({
          kind: NOTIFY_DIGEST_DELIVER_JOB,
          idempotencyKey: digestJobKey(candidate.parentUserId, now),
          payload: { parentUserId: candidate.parentUserId, weekStart: weekStart.toISOString() },
        });
        if (result.created) enqueued += 1;
      }

      metrics.counter(NOTIFY_METRICS.DIGEST_ENQUEUED, enqueued);
      // Counts only. Never a parent id — this line describes personal data and
      // must not become personal data.
      logger.info(
        { event: 'notify.digest_scan', due: candidates.length, enqueued },
        'weekly digest scan completed',
      );
      return enqueued;
    },

    /**
     * Builds and sends ONE parent's digest.
     *
     * Idempotent per (parent, week) TWICE OVER, and both are needed. The job key
     * stops a duplicated ENQUEUE; the `hasDigestFor` check stops a duplicated
     * RUN, which the stuck-job reaper can cause and which no key can prevent.
     */
    async deliverWeeklyDigest(parentUserId: string, weekStart: Date): Promise<SendResult | null> {
      const source = deps.digest;
      if (source === undefined) {
        throw new Error('notify.deliverWeeklyDigest: no DigestSource is wired');
      }

      const week = weekKey(weekStart);
      if (await repository.hasDigestFor(parentUserId, week)) {
        metrics.counter(NOTIFY_METRICS.DIGEST_SKIPPED, 1, { reason: 'already_sent' });
        return null;
      }

      const content = await source.buildDigest({ parentUserId, weekStart });
      if (content === null) {
        metrics.counter(NOTIFY_METRICS.DIGEST_SKIPPED, 1, { reason: 'no_content' });
        logger.info(
          { event: 'notify.digest_empty' },
          'a due parent produced no digest content this week',
        );
        return null;
      }

      return sendNotification({
        recipientUserId: parentUserId,
        kind: 'digest_ready',
        title: content.title,
        body: content.body,
        // `weekStart` is what `hasDigestFor` matches on, so it is not optional
        // decoration — it is the durable half of this function's idempotence.
        data: { ...content.data, weekStart: week },
      });
    },
  };
}
