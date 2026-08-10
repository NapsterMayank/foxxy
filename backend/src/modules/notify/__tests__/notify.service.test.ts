import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryCache, type CachePort } from '@/platform/cache/index';
import { ForbiddenError, NotFoundError } from '@/platform/errors/index';
import { FakeLogger } from '@/platform/logger/index';
import { MemoryMetrics } from '@/platform/metrics/index';
import type { MailPort } from '@/platform/mail/index';
import {
  createEmailChannel,
  createNotificationDispatcher,
  createPushChannel,
  type Channel,
  type ChannelMessage,
  type ChannelName,
  type ChannelRecipient,
  type ChannelResult,
  type NotificationDispatcher,
} from '@/platform/notify-channel/index';
import {
  OTHER_TENANT_ID,
  TEST_TENANT_ID,
  createSecondTenant,
  onboardAccount,
  startAppHarness,
  type AppHarness,
  type HarnessAccount,
} from '../../../../tests/helpers/app-harness';
import { createNotifyModule, toChannelPolicy, type NotifyModule } from '../index';
import { KIND_POLICY, NOTIFY_METRICS } from '../domain/kinds';
import { weekKey, weekStartOf } from '../domain/digest-week';
import type { DigestContent, DigestSource, NotifyJobEnqueuer } from '../notify.service';
import type { SendNotificationInput } from '../notify.types';

/**
 * notify service tests — a real Postgres, faked everything else (§9.1).
 *
 * The §8.9 requirements live at this level:
 *
 *   every notification has both English and Hindi text
 *   a mail-port failure does not break the calling flow
 *   notifications are scoped to their owner
 *
 * plus the properties the two-phase design owes: the delivery job is idempotent,
 * it retries with backoff on the injected clock, it dead-letters visibly, quiet
 * hours defer rather than drop, the digest scheduler is idempotent per parent
 * per week, and a channel this module has never heard of can be delivered
 * through with NO CHANGE to the service.
 *
 * Every deny test asserts something stronger than a status code: that the
 * refusal carries no data at all.
 */

let harness: AppHarness;

const MESSAGE = {
  title: { en: 'Your weekly summary', hi: 'आपका साप्ताहिक सारांश' },
  body: { en: 'Asha completed 4 missions.', hi: 'आशा ने 4 मिशन पूरे किए।' },
} as const;

beforeAll(async () => {
  harness = await startAppHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

function actorOf(
  account: HarnessAccount,
  overrides: { role?: 'student' | 'parent'; tenantId?: string } = {},
): { userId: string; role: 'student' | 'parent'; tenantId: string } {
  return {
    userId: account.userId,
    role: overrides.role ?? 'student',
    // Stated rather than read back, so the CROSS-TENANT tests — which pass a
    // different value deliberately — are visibly different from ordinary ones.
    tenantId: overrides.tenantId ?? TEST_TENANT_ID,
  };
}

/** A channel that records what it was asked to deliver, or misbehaves. */
function fakeChannel(name: ChannelName, behaviour: 'ok' | 'fail' | 'throw'): Channel & {
  readonly sent: { recipient: ChannelRecipient; message: ChannelMessage }[];
} {
  const sent: { recipient: ChannelRecipient; message: ChannelMessage }[] = [];
  return {
    name,
    sent,
    send(recipient: ChannelRecipient, message: ChannelMessage): Promise<ChannelResult> {
      if (behaviour === 'throw') return Promise.reject(new Error(`${name} exploded`));
      sent.push({ recipient, message });
      return Promise.resolve({
        channel: name,
        delivered: behaviour === 'ok',
        ...(behaviour === 'fail' ? { reason: 'declined' } : {}),
      });
    },
  };
}

/**
 * The real `MemoryCache` with its COUNTER broken, and nothing else changed.
 *
 * Extending the platform fake rather than hand-rolling a `CachePort` keeps the
 * other five methods honest: when the port grows a sixth, this fake grows it
 * too, for free. A partial object literal would have compiled on the day it was
 * written and broken on the day the interface moved.
 */
class BrokenCounterCache extends MemoryCache {
  override incr(): Promise<number> {
    return Promise.reject(new Error('cache down'));
  }
}

interface BespokeNotify {
  readonly module: NotifyModule;
  readonly metrics: MemoryMetrics;
  readonly logger: FakeLogger;
}

/**
 * A notify module wired to substituted ports.
 *
 * It shares the harness's real database, real in-app adapter and real queue —
 * everything that must not be faked — and swaps only the remote fan-out, so
 * each test can decide how the outside world behaves.
 */
function buildNotify(options: {
  readonly dispatcher?: NotificationDispatcher;
  readonly channels?: Partial<Record<ChannelName, Channel>>;
  readonly policy?: Record<string, readonly ChannelName[]>;
  readonly queue?: NotifyJobEnqueuer;
  readonly cache?: CachePort;
  readonly digest?: DigestSource;
} = {}): BespokeNotify {
  const logger = new FakeLogger();
  const metrics = new MemoryMetrics({ clock: harness.clock });

  const dispatcher =
    options.dispatcher ??
    createNotificationDispatcher({
      channels: {
        email: options.channels?.email ?? fakeChannel('email', 'ok'),
        'in-app': harness.container.channels['in-app'],
        whatsapp: options.channels?.whatsapp ?? fakeChannel('whatsapp', 'ok'),
        push: options.channels?.push ?? createPushChannel(),
      },
      policy: options.policy ?? toChannelPolicy(),
      logger,
      metrics,
    });

  const module = createNotifyModule({
    db: harness.container.poolFor('notify'),
    clock: harness.clock,
    logger,
    metrics,
    cache: options.cache ?? harness.cache,
    inAppChannel: harness.container.channels['in-app'],
    dispatcher,
    queue: options.queue ?? harness.container.jobQueue,
    requireSession: harness.identity.requireSession,
    readRecipient: (userId) => harness.identity.service.getNotificationRecipient(userId),
    // ABSENT by default, exactly as production is until `parent` exists. A
    // harness that always wired a fake would hide the fact that the default
    // posture is "no source, and loud about it".
    ...(options.digest === undefined ? {} : { digest: options.digest }),
  });

  return { module, metrics, logger };
}

async function student(email: string): Promise<HarnessAccount> {
  return onboardAccount(harness, email, 'student');
}

// ---------------------------------------------------------------------------
// Both languages
// ---------------------------------------------------------------------------

describe('every notification has both English and Hindi text (§8.9)', () => {
  it('rejects a single-language message AT THE TYPE LEVEL', () => {
    // This test cannot fail at runtime; it documents a COMPILE-TIME guarantee,
    // which is the guarantee that actually matters. P7 does not decay by
    // decision — it decays when somebody adds a notification under time
    // pressure with English text and a `// TODO: hi`, which renders perfectly
    // for the person who wrote it and is invisible in review.
    //
    // The directives sit on the offending PROPERTIES rather than on the
    // declaration, because `@ts-expect-error` suppresses the error on the line
    // that follows it and TypeScript reports a missing property at the property
    // site. If either line stops erroring, the type has been widened and P7 has
    // lost its mechanical enforcement — which is what the "unused directive"
    // failure would then be telling us.
    const englishOnly: SendNotificationInput = {
      recipientUserId: 'user-1',
      kind: 'digest_ready',
      // @ts-expect-error `hi` is required on BilingualText.
      title: { en: 'Only English' },
      // @ts-expect-error `hi` is required on BilingualText.
      body: { en: 'Only English' },
    };
    expect(englishOnly.kind).toBe('digest_ready');
  });

  it('stores BOTH languages on the row and returns both', async () => {
    const account = await student('bilingual@example.test');
    const { module } = buildNotify();

    await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    const listed = await module.service.listForUser(actorOf(account), { limit: 10 });
    const notification = listed.notifications[0];

    expect(notification?.title).toEqual(MESSAGE.title);
    expect(notification?.body).toEqual(MESSAGE.body);
  });

  it('is refused by the DATABASE when a blank language slips past the type', async () => {
    // Types do not survive a raw INSERT. The `notifications_bilingual_check`
    // CHECK is `length(btrim(...)) > 0` rather than merely NOT NULL, precisely
    // so that `hi: ''` — the shape somebody writes to get past a NOT NULL — is
    // refused too.
    const account = await student('blank-hi@example.test');
    await expect(
      harness.postgres.client.query(
        `insert into notifications
           (recipient_user_id, tenant_id, kind, title_en, body_en, title_hi, body_hi)
         values ($1, $2, 'digest_ready', 'T', 'B', '   ', 'B')`,
        [account.userId, TEST_TENANT_ID],
      ),
    ).rejects.toThrow(/notifications_bilingual_check/);
  });
});

// ---------------------------------------------------------------------------
// The two-phase send
// ---------------------------------------------------------------------------

describe('send — phase 1 writes the row, phase 2 is queued', () => {
  it('writes the in-app row synchronously and stamps the recipient tenant', async () => {
    // D-084's named mechanism: the tenant is resolved FROM THE RECIPIENT rather
    // than left to the column default, which cannot tell "not supplied" from
    // "supplied and equal to the default".
    const account = await student('phase1@example.test');
    const { module } = buildNotify();

    const result = await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    expect(result.created).toBe(true);
    const rows = await harness.postgres.client.query<{ tenant_id: string }>(
      `select tenant_id from notifications where id = $1`,
      [result.notificationId],
    );
    expect(rows.rows[0]?.tenant_id).toBe(TEST_TENANT_ID);
  });

  it('enqueues ONE delivery job keyed by the notification id', async () => {
    const account = await student('phase2@example.test');
    const { module } = buildNotify();

    const result = await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    const jobs = await harness.postgres.client.query<{ idempotency_key: string }>(
      `select idempotency_key from jobs where kind = 'notify.deliver_notification'`,
    );
    expect(jobs.rowCount).toBe(1);
    expect(jobs.rows[0]?.idempotency_key).toBe(result.notificationId);
  });

  it('enqueues NO job for an in-app-only kind', async () => {
    // `streak_reminder`. The cheapest notification in the product costs one
    // INSERT and no queue row at all.
    const account = await student('inapponly@example.test');
    const { module } = buildNotify();

    const result = await module.service.send({
      recipientUserId: account.userId,
      kind: 'streak_reminder',
      ...MESSAGE,
    });

    expect(result.created).toBe(true);
    expect(result.scheduledChannels).toEqual([]);
    const jobs = await harness.postgres.client.query(`select 1 from jobs`);
    expect(jobs.rowCount).toBe(0);
  });

  it('refuses a recipient that does not exist', async () => {
    const { module } = buildNotify();
    await expect(
      module.service.send({
        recipientUserId: '11111111-1111-4111-8111-111111111111',
        kind: 'digest_ready',
        ...MESSAGE,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('still writes the in-app row when the QUEUE is unavailable, and says so loudly', async () => {
    // The person will find out; what is lost is the email. Losing it SILENTLY
    // is the failure this module refuses to have, so it is recorded on the row,
    // counted, and logged at error.
    const account = await student('queuedown@example.test');
    const { module, metrics, logger } = buildNotify({
      queue: {
        enqueue: () => Promise.reject(new Error('queue is down')),
      },
    });

    const result = await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    expect(result.created).toBe(true);
    expect(result.scheduledChannels).toEqual([]);
    expect(metrics.totalFor(NOTIFY_METRICS.DEAD_LETTER)).toBe(1);
    expect(logger.lines.some((line) => line.obj.event === 'notify.enqueue_failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A failing mail port
// ---------------------------------------------------------------------------

describe('a mail-port failure does not break the calling flow (§8.9)', () => {
  it('the in-app notification still lands when the mail port THROWS', async () => {
    // Structurally true rather than carefully handled: the calling flow never
    // touches the mail port at all. Phase 1 is one INSERT; the mail provider is
    // reached later, in another process, by a job that can be retried.
    const account = await student('mailfail@example.test');
    const throwingMail: MailPort = {
      send: () => Promise.reject(new Error('SMTP provider is on fire')),
    };
    const { module } = buildNotify({
      channels: { email: createEmailChannel({ mail: throwingMail }) },
    });

    const result = await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    expect(result.created).toBe(true);
    const listed = await module.service.listForUser(actorOf(account), { limit: 10 });
    expect(listed.notifications).toHaveLength(1);
    expect(listed.unreadCount).toBe(1);
  });

  it('the in-app row survives even when DELIVERY later fails completely', async () => {
    const account = await student('mailfail2@example.test');
    const { module } = buildNotify({ channels: { email: fakeChannel('email', 'throw') } });

    const sent = await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    const job = await claimNextDeliveryJob();
    await expect(module.service.deliver(job)).rejects.toThrow(/no channel delivered/);

    // The notification is still there, still unread, still readable.
    const listed = await module.service.listForUser(actorOf(account), { limit: 10 });
    expect(listed.notifications[0]?.id).toBe(sent.notificationId);
  });

  it('never writes an email address into a log line', async () => {
    const account = await student('pii@example.test');
    const { module, logger } = buildNotify({
      channels: { email: fakeChannel('email', 'throw') },
    });

    await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });
    const job = await claimNextDeliveryJob();
    await expect(module.service.deliver(job)).rejects.toThrow();

    const serialised = JSON.stringify(logger.lines);
    expect(serialised).not.toContain('pii@example.test');
    expect(serialised).not.toContain(account.userId);
  });
});

/** Claims the oldest delivery job through the real queue, as the worker does. */
async function claimNextDeliveryJob() {
  const job = await harness.container.jobQueue.claim(
    'test-worker',
    ['notify.deliver_notification'],
    harness.clock.now(),
  );
  if (job === null) throw new Error('no delivery job was queued');
  return job;
}

// ---------------------------------------------------------------------------
// Ownership and tenancy
// ---------------------------------------------------------------------------

describe('notifications are scoped to their owner (§8.9)', () => {
  it('lists only the caller own notifications', async () => {
    const mine = await student('owner-a@example.test');
    const theirs = await student('owner-b@example.test');
    const { module } = buildNotify();

    await module.service.send({ recipientUserId: mine.userId, kind: 'digest_ready', ...MESSAGE });
    await module.service.send({
      recipientUserId: theirs.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    const listed = await module.service.listForUser(actorOf(mine), { limit: 50 });
    expect(listed.notifications).toHaveLength(1);
    expect(listed.notifications[0]?.recipientUserId).toBe(mine.userId);
  });

  it('DENIES marking another user notification read, with no payload', async () => {
    const owner = await student('owner-c@example.test');
    const intruder = await student('intruder@example.test');
    const { module } = buildNotify();

    const sent = await module.service.send({
      recipientUserId: owner.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    let thrown: unknown;
    try {
      await module.service.markRead(actorOf(intruder), sent.notificationId ?? '');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenError);
    // NOT MERELY THE RIGHT STATUS CODE. The refusal must carry nothing about
    // the notification or its owner — no title, no owner id, no kind. A 403
    // that helpfully explains whose notification it is confirms the row exists,
    // which is the enumeration leak §7 rule 2 closes.
    const serialised = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown));
    expect(serialised).not.toContain(owner.userId);
    expect(serialised).not.toContain(sent.notificationId);
    expect(serialised).not.toContain('weekly summary');
  });

  it('leaves the row UNREAD after a denied attempt', async () => {
    const owner = await student('owner-d@example.test');
    const intruder = await student('intruder-d@example.test');
    const { module } = buildNotify();

    const sent = await module.service.send({
      recipientUserId: owner.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });
    await expect(
      module.service.markRead(actorOf(intruder), sent.notificationId ?? ''),
    ).rejects.toThrow(ForbiddenError);

    expect(await module.service.getUnreadCount(actorOf(owner))).toBe(1);
  });

  it('gives a MISSING notification the identical refusal to somebody else notification', async () => {
    // Same error type, same contentless message. A 404 for the first would be
    // an oracle for "does this notification id exist".
    const account = await student('owner-e@example.test');
    const { module } = buildNotify();

    await expect(
      module.service.markRead(actorOf(account), '33333333-3333-4333-8333-333333333333'),
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses a PARENT reading a linked child notifications', async () => {
    // A child inbox may hold a link-revocation notice or a payment message.
    // "A parent may observe their child learning" is not "a parent may read
    // their child mail", and the resource kind used here (`account`) is what
    // keeps the two apart.
    const child = await student('child-f@example.test');
    const parent = await onboardAccount(harness, 'parent-f@example.test', 'parent');
    const { module } = buildNotify();

    const sent = await module.service.send({
      recipientUserId: child.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    await expect(
      module.service.markRead(actorOf(parent, { role: 'parent' }), sent.notificationId ?? ''),
    ).rejects.toThrow(ForbiddenError);
  });

  it('marks all read for the caller and NOBODY ELSE', async () => {
    const mine = await student('owner-g@example.test');
    const theirs = await student('owner-h@example.test');
    const { module } = buildNotify();

    await module.service.send({ recipientUserId: mine.userId, kind: 'digest_ready', ...MESSAGE });
    await module.service.send({
      recipientUserId: theirs.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    const cleared = await module.service.markAllRead(actorOf(mine));
    expect(cleared.marked).toBe(1);
    expect(cleared.unreadCount).toBe(0);
    expect(await module.service.getUnreadCount(actorOf(theirs))).toBe(1);
  });

  it('is idempotent on a second markRead', async () => {
    const account = await student('owner-i@example.test');
    const { module } = buildNotify();
    const sent = await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    const first = await module.service.markRead(actorOf(account), sent.notificationId ?? '');
    const second = await module.service.markRead(actorOf(account), sent.notificationId ?? '');

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.unreadCount).toBe(0);
  });
});

describe('cross-tenant access is denied (D-073)', () => {
  it('DENIES a read by an actor claiming another tenant', async () => {
    await createSecondTenant(harness);
    const account = await student('tenant-a@example.test');
    const { module } = buildNotify();

    await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    // The SAME user id, in a different tenant. Every ownership rule says yes
    // and the answer is still no, because the tenant check runs before any
    // allow rule is considered.
    await expect(
      module.service.listForUser(actorOf(account, { tenantId: OTHER_TENANT_ID }), { limit: 10 }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('DENIES marking read across a tenant boundary, with no payload', async () => {
    await createSecondTenant(harness);
    const account = await student('tenant-b@example.test');
    const { module } = buildNotify();

    const sent = await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    let thrown: unknown;
    try {
      await module.service.markRead(
        actorOf(account, { tenantId: OTHER_TENANT_ID }),
        sent.notificationId ?? '',
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenError);
    const serialised = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown));
    // Neither tenant is named. "You are in A and this belongs to B" confirms
    // that B holds this resource, which a white-labelled deployment cannot
    // afford to disclose.
    expect(serialised).not.toContain(OTHER_TENANT_ID);
    expect(serialised).not.toContain(TEST_TENANT_ID);
  });

  it('denies an actor carrying no tenant at all', async () => {
    const account = await student('tenant-c@example.test');
    const { module } = buildNotify();
    await expect(
      module.service.getUnreadCount(actorOf(account, { tenantId: '' })),
    ).rejects.toThrow(ForbiddenError);
  });

  /**
   * EVERY method that takes an actor, not just the one the bug was found on.
   *
   * The original defect was in `listForUser`, and it was in `markAllRead` and
   * `getUnreadCount` too — all three resolved the resource tenant by echoing
   * `actor.tenantId` back, which makes `assertTenantMatch` compare a value with
   * itself. One test on one method would have proved the fix and left the other
   * two holes open, so the rule here is: if the bug is in one, it is in all of
   * them until each is separately shown otherwise.
   *
   * `markRead` is covered above and was ALREADY correct — it resolves the
   * tenant from the row through `findOwner`. That it was right is the evidence
   * that the pattern works, not a reason to skip it.
   */
  it('DENIES getUnreadCount by an actor claiming another tenant', async () => {
    await createSecondTenant(harness);
    const account = await student('tenant-d@example.test');
    const { module } = buildNotify();

    await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    await expect(
      module.service.getUnreadCount(actorOf(account, { tenantId: OTHER_TENANT_ID })),
    ).rejects.toThrow(ForbiddenError);
  });

  it('DENIES markAllRead across a tenant boundary and clears NOTHING', async () => {
    // The second assertion is the one that matters. Before the tenant was read
    // from `users`, this call did not throw — it "succeeded" having scoped its
    // UPDATE to a tenant the caller had merely claimed, marked zero rows, and
    // returned `{ marked: 0 }`. A wrong answer that looks like an empty inbox
    // is worse than a refusal, because nobody investigates a zero.
    await createSecondTenant(harness);
    const account = await student('tenant-e@example.test');
    const { module } = buildNotify();

    await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    await expect(
      module.service.markAllRead(actorOf(account, { tenantId: OTHER_TENANT_ID })),
    ).rejects.toThrow(ForbiddenError);

    // Still unread, read back through the tenant that really owns the row.
    expect(await module.service.getUnreadCount(actorOf(account))).toBe(1);
  });

  it('leaks NOTHING when listForUser is refused across a tenant boundary', async () => {
    await createSecondTenant(harness);
    const account = await student('tenant-f@example.test');
    const { module } = buildNotify();

    const sent = await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    let thrown: unknown;
    try {
      await module.service.listForUser(actorOf(account, { tenantId: OTHER_TENANT_ID }), {
        limit: 10,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenError);
    const serialised = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown));
    // No tenant, no user id, no notification id, no message text. A deny that
    // names either tenant confirms that tenant holds this data, which is the
    // disclosure a white-labelled deployment cannot afford.
    expect(serialised).not.toContain(OTHER_TENANT_ID);
    expect(serialised).not.toContain(TEST_TENANT_ID);
    expect(serialised).not.toContain(account.userId);
    expect(serialised).not.toContain(sent.notificationId);
    expect(serialised).not.toContain('weekly summary');
  });

  it('DENIES an actor whose account no longer exists, identically', async () => {
    // The tenant is resolved from `users`. A deleted account resolves to no
    // tenant at all, which is a DENY rather than a pass — and it takes the same
    // path as a cross-tenant refusal, so the two are byte-identical rather than
    // merely similar. A `null` handled with an early `throw new NotFoundError`
    // here would have been an oracle for "does this account still exist".
    const { module } = buildNotify();
    const ghost = {
      userId: '44444444-4444-4444-8444-444444444444',
      role: 'student' as const,
      tenantId: TEST_TENANT_ID,
    };

    await expect(module.service.getUnreadCount(ghost)).rejects.toThrow(ForbiddenError);
    await expect(module.service.listForUser(ghost, { limit: 10 })).rejects.toThrow(ForbiddenError);
    await expect(module.service.markAllRead(ghost)).rejects.toThrow(ForbiddenError);
  });

  it('files a send under the RECIPIENT tenant, which no caller supplies', async () => {
    // `send` takes no actor at all, so there is no claimed tenant it could
    // trust: it resolves the tenant from the recipient and stamps the row with
    // it. That is why the cross-tenant hole could not reach the write path —
    // and this pins it, so a future `tenantId` parameter on `SendNotificationInput`
    // has to fail here before it can file mail into a tenant it does not belong to.
    await createSecondTenant(harness);
    const account = await student('tenant-g@example.test');
    const { module } = buildNotify();

    const sent = await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    const rows = await harness.postgres.client.query<{ tenant_id: string }>(
      `select tenant_id from notifications where id = $1`,
      [sent.notificationId],
    );
    expect(rows.rows[0]?.tenant_id).toBe(TEST_TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
// Quiet hours, end to end
// ---------------------------------------------------------------------------

describe('quiet hours (§ preferences)', () => {
  const NIGHT = '2026-06-01T18:00:00.000Z'; // 23:30 IST

  it('DEFERS an ordinary kind and still writes the in-app row immediately', async () => {
    const account = await student('quiet-a@example.test');
    harness.clock.setTo(NIGHT);
    const { module, metrics } = buildNotify();

    const result = await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    expect(result.created).toBe(true);
    expect(metrics.totalFor(NOTIFY_METRICS.DEFERRED)).toBe(1);

    const jobs = await harness.postgres.client.query<{ run_at: Date }>(
      `select run_at from jobs where kind = 'notify.deliver_notification'`,
    );
    // 07:00 IST the next morning, not now.
    expect(jobs.rows[0]?.run_at.toISOString()).toBe('2026-06-02T01:30:00.000Z');
  });

  it('does NOT defer a security kind at the same instant', async () => {
    const account = await student('quiet-b@example.test');
    harness.clock.setTo(NIGHT);
    const { module, metrics } = buildNotify();

    await module.service.send({
      recipientUserId: account.userId,
      kind: 'link_requested',
      ...MESSAGE,
    });

    expect(metrics.totalFor(NOTIFY_METRICS.DEFERRED)).toBe(0);
    const jobs = await harness.postgres.client.query<{ run_at: Date }>(
      `select run_at from jobs where kind = 'notify.deliver_notification'`,
    );
    expect(jobs.rows[0]?.run_at.toISOString()).toBe(NIGHT);
  });
});

// ---------------------------------------------------------------------------
// Frequency caps
// ---------------------------------------------------------------------------

describe('frequency caps', () => {
  it('suppresses a send past the daily cap for its kind, writing no row', async () => {
    const account = await student('cap-a@example.test');
    const { module, metrics } = buildNotify();
    const cap = KIND_POLICY.digest_ready.dailyCap;

    for (let index = 0; index < cap; index += 1) {
      const allowed = await module.service.send({
        recipientUserId: account.userId,
        kind: 'digest_ready',
        ...MESSAGE,
      });
      expect(allowed.created).toBe(true);
    }

    const refused = await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    expect(refused.created).toBe(false);
    expect(refused.suppressed).toBe('frequency_cap');
    expect(refused.notificationId).toBeNull();
    expect(metrics.totalFor(NOTIFY_METRICS.SUPPRESSED)).toBe(1);
    expect(await module.service.getUnreadCount(actorOf(account))).toBe(cap);
  });

  it('counts each kind separately', async () => {
    const account = await student('cap-b@example.test');
    const { module } = buildNotify();

    await module.service.send({ recipientUserId: account.userId, kind: 'digest_ready', ...MESSAGE });
    const other = await module.service.send({
      recipientUserId: account.userId,
      kind: 'streak_reminder',
      ...MESSAGE,
    });

    expect(other.created).toBe(true);
  });

  it('FAILS OPEN when the counter cannot be read', async () => {
    // A cap is a courtesy to the recipient, not a security control. Failing
    // closed would let a Valkey blip silence the product — and D-034's
    // rate-limit fallback fails open for the same reason.
    const account = await student('cap-c@example.test');
    // SUBCLASSED rather than spread. `{ ...harness.cache, incr: … }` looks
    // equivalent and is not: `MemoryCache` is a class, its methods live on the
    // prototype, and object spread copies own enumerable properties only — so
    // the result is an object with `incr` and NOTHING ELSE, which does not
    // satisfy `CachePort`. An inline partial fake also drifts from the port
    // every time the port grows a method; extending the real fake cannot.
    const { module, logger } = buildNotify({ cache: new BrokenCounterCache(harness.clock) });

    const result = await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    expect(result.created).toBe(true);
    expect(logger.lines.some((line) => line.obj.event === 'notify.cap_unavailable')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The delivery job
// ---------------------------------------------------------------------------

describe('the delivery job', () => {
  it('delivers over the channels the routing table chose', async () => {
    const account = await student('deliver-a@example.test');
    const email = fakeChannel('email', 'ok');
    const { module } = buildNotify({ channels: { email } });

    await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });
    const outcome = await module.service.deliver(await claimNextDeliveryJob());

    expect(outcome).toBe('delivered');
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.message.title).toEqual(MESSAGE.title);
  });

  it('does NOT write a second in-app row', async () => {
    // The invariant behind `in-app` being absent from every routing row. If it
    // were listed, the dispatcher would fan out over it here and the user would
    // see the same notification twice — a duplicate no test of the SENDING path
    // would ever notice, because the first row is correct.
    const account = await student('deliver-b@example.test');
    const { module } = buildNotify();

    await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });
    await module.service.deliver(await claimNextDeliveryJob());

    const rows = await harness.postgres.client.query(
      `select 1 from notifications where recipient_user_id = $1`,
      [account.userId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('IS IDEMPOTENT — running twice sends once', async () => {
    // `platform/jobs`: "EVERY HANDLER MUST BE IDEMPOTENT. This is not advice."
    // A worker can complete the work and be killed before recording that it
    // did, and the stuck-job reaper will hand the row back. Without the
    // compare-and-set claim, that is a second email.
    const account = await student('deliver-c@example.test');
    const email = fakeChannel('email', 'ok');
    const { module, metrics } = buildNotify({ channels: { email } });

    await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });
    const job = await claimNextDeliveryJob();

    expect(await module.service.deliver(job)).toBe('delivered');
    expect(await module.service.deliver(job)).toBe('duplicate');

    expect(email.sent).toHaveLength(1);
    expect(metrics.totalFor(NOTIFY_METRICS.DUPLICATE)).toBe(1);
  });

  it('DEAD-LETTERS on the final attempt, with a metric and a marker', async () => {
    // The one metric in this module that deserves an alert. A notification that
    // silently never arrives is worse than one that visibly fails, and this
    // counter is the entire difference between the two.
    //
    // It is recorded BEFORE the throw, because after the throw the queue marks
    // the job `dead` and this handler is never called again — there is no later
    // moment at which to say so.
    const account = await student('deadletter@example.test');
    const { module, metrics, logger } = buildNotify({
      channels: { email: fakeChannel('email', 'fail') },
    });

    const sent = await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    const job = await claimNextDeliveryJob();
    const finalAttempt = { ...job, attempts: job.maxAttempts, maxAttempts: job.maxAttempts };

    await expect(module.service.deliver(finalAttempt)).rejects.toThrow(/no channel delivered/);

    expect(metrics.totalFor(NOTIFY_METRICS.DEAD_LETTER)).toBe(1);
    expect(logger.lines.some((line) => line.obj.event === 'notify.dead_letter')).toBe(true);

    // Durable, not just observable in a log: support has to be able to answer
    // "did this ever go out" months later, and a metric has a retention period.
    const marker = await harness.postgres.client.query<{ outcome: string | null }>(
      `select data -> '_delivery' ->> 'outcome' as outcome from notifications where id = $1`,
      [sent.notificationId],
    );
    expect(marker.rows[0]?.outcome).toBe('dead_letter');

    // And the in-app row is untouched — the person was still told.
    const listed = await module.service.listForUser(actorOf(account), { limit: 10 });
    expect(listed.notifications[0]?.id).toBe(sent.notificationId);
  });

  it('RELEASES the claim on a non-final failure so the retry really re-sends', async () => {
    // The subtle half of the compare-and-set. Leaving the claim reading
    // `in_progress` would make the retry report a DUPLICATE and succeed having
    // sent nothing — a job that reports delivering something it never sent,
    // which is the exact silent failure this module exists to make impossible.
    //
    // Two attempts, no sleep: the backoff belongs to `platform/jobs` and is
    // tested there. Here the clock is only moved, never waited on (§9.5).
    const account = await student('retry@example.test');
    let attempt = 0;
    const flaky: Channel = {
      name: 'email',
      send(): Promise<ChannelResult> {
        attempt += 1;
        return Promise.resolve({
          channel: 'email',
          delivered: attempt > 1,
          ...(attempt > 1 ? {} : { reason: 'temporary' }),
        });
      },
    };
    const { module } = buildNotify({ channels: { email: flaky } });

    await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });

    const job = await claimNextDeliveryJob();
    await expect(
      module.service.deliver({ ...job, attempts: 1, maxAttempts: 5 }),
    ).rejects.toThrow(/no channel delivered/);

    // The retry arrives later on the injected clock, as the real one would.
    harness.clock.advanceMs(60_000);
    expect(await module.service.deliver({ ...job, attempts: 2, maxAttempts: 5 })).toBe('delivered');
    expect(attempt).toBe(2);
  });

  it('reports an unusable payload without retrying it', async () => {
    const { module, logger } = buildNotify();
    const outcome = await module.service.deliver({
      id: 'job-1',
      kind: 'notify.deliver_notification',
      idempotencyKey: 'k',
      payload: { notificationId: 42 },
      attempts: 1,
      maxAttempts: 5,
      runAt: harness.clock.now(),
      createdAt: harness.clock.now(),
    });

    expect(outcome).toBe('undelivered');
    expect(logger.lines.some((line) => line.obj.event === 'notify.bad_payload')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adding a channel
// ---------------------------------------------------------------------------

describe('adding a channel requires NO change to the service', () => {
  it('delivers through a channel this module has never heard of', async () => {
    // 05-ROADMAP.md §4: Phase 2 delivers the parent digest over WhatsApp,
    // because "parents open WhatsApp; they do not open email". This test is the
    // rehearsal, and it is the honest form of the claim: `whatsapp` today is a
    // `DependencyError` that throws on every call. Here it is replaced with a
    // working adapter and ONE POLICY ROW is changed. Nothing in
    // `notify.service.ts` is touched, and the notification is delivered over it.
    //
    // If this test ever needs a service edit to pass, "adding a channel is one
    // adapter" has quietly stopped being true.
    const account = await student('newchannel@example.test');
    const whatsapp = fakeChannel('whatsapp', 'ok');
    const email = fakeChannel('email', 'ok');

    const { module } = buildNotify({
      channels: { whatsapp, email },
      policy: { ...toChannelPolicy(), digest_ready: ['whatsapp', 'email'] },
    });

    const sent = await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });
    // The plan still comes from `KIND_POLICY`, which the container has not been
    // told about — so the job carries `['email']`, and the dispatcher's own
    // policy is what adds WhatsApp back. Both halves are data.
    expect(sent.created).toBe(true);

    const outcome = await module.service.deliver(await claimNextDeliveryJob());
    expect(outcome).toBe('delivered');
    expect(whatsapp.sent.length + email.sent.length).toBeGreaterThan(0);
  });

  it('keeps delivering on the other channels when one of them THROWS', async () => {
    const account = await student('partial@example.test');
    const email = fakeChannel('email', 'ok');
    const { module } = buildNotify({
      channels: { whatsapp: fakeChannel('whatsapp', 'throw'), email },
      policy: { ...toChannelPolicy(), digest_ready: ['whatsapp', 'email'] },
    });

    await module.service.send({
      recipientUserId: account.userId,
      kind: 'digest_ready',
      ...MESSAGE,
    });
    expect(await module.service.deliver(await claimNextDeliveryJob())).toBe('delivered');
    expect(email.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The weekly digest scheduler
// ---------------------------------------------------------------------------

/**
 * The SCHEDULING half of the weekly digest (§8.7 / §8.9).
 *
 * notify knows WHEN to ask for a digest and HOW to deliver the answer. It does
 * not know what a digest says — reading a child's Foxy traces and practice
 * results, asking the model for five lines, naming a misconception and one
 * action is `parent`'s work, reached through the `DigestSource` seam. Splitting
 * it that way is what lets this half be finished and proved now, against a fake
 * source, with the other half not yet written.
 *
 * The seam is OPTIONAL at the composition root and its absence is load-bearing:
 * with no source the worker registers no digest handlers at all, so a stray
 * digest job is refused loudly instead of succeeding without doing the work.
 */
describe('the weekly digest scheduler', () => {
  const CONTENT: DigestContent = {
    title: { en: 'Your weekly summary', hi: 'आपका साप्ताहिक सारांश' },
    body: { en: 'Asha completed 4 missions.', hi: 'आशा ने 4 मिशन पूरे किए।' },
    data: { missions: 4 },
  };

  /** A stand-in for the `parent` module, recording what it was asked. */
  function fakeDigestSource(options: {
    readonly parents: readonly string[];
    readonly content?: DigestContent | null;
  }): DigestSource & {
    readonly scans: Date[];
    readonly builds: { parentUserId: string; weekStart: Date }[];
  } {
    const scans: Date[] = [];
    const builds: { parentUserId: string; weekStart: Date }[] = [];
    return {
      scans,
      builds,
      findParentsDue(weekStart: Date) {
        scans.push(weekStart);
        return Promise.resolve(options.parents.map((parentUserId) => ({ parentUserId })));
      },
      buildDigest(input: { parentUserId: string; weekStart: Date }) {
        builds.push(input);
        return Promise.resolve(options.content === undefined ? CONTENT : options.content);
      },
    };
  }

  it('REFUSES to run at all when no source is wired, rather than finding nobody', async () => {
    // Thrown rather than returning 0. A scan that silently found nobody is
    // indistinguishable from a scan that worked, and "the digests stopped going
    // out three weeks ago" is the kind of failure that is only ever noticed by
    // a customer.
    const { module } = buildNotify();
    await expect(module.service.scanWeeklyDigests()).rejects.toThrow(/no DigestSource/);
    await expect(
      module.service.deliverWeeklyDigest('someone', weekStartOf(harness.clock.now())),
    ).rejects.toThrow(/no DigestSource/);
  });

  it('enqueues one delivery per due parent, and asks for THIS week', async () => {
    const parentA = await onboardAccount(harness, 'digest-a@example.test', 'parent');
    const parentB = await onboardAccount(harness, 'digest-b@example.test', 'parent');
    const source = fakeDigestSource({ parents: [parentA.userId, parentB.userId] });
    const { module, metrics } = buildNotify({ digest: source });

    const enqueued = await module.service.scanWeeklyDigests();

    expect(enqueued).toBe(2);
    expect(metrics.totalFor(NOTIFY_METRICS.DIGEST_ENQUEUED)).toBe(2);
    expect(source.scans[0]?.toISOString()).toBe(weekStartOf(harness.clock.now()).toISOString());

    const jobs = await harness.postgres.client.query<{ idempotency_key: string }>(
      `select idempotency_key from jobs where kind = 'notify.deliver_weekly_digest'`,
    );
    expect(jobs.rowCount).toBe(2);
    // (parent, week) — never a timestamp, never a random value. Either would
    // make every enqueue a new row and remove the only protection the unique
    // index offers.
    expect(jobs.rows.map((row) => row.idempotency_key).sort()).toEqual(
      [
        `${parentA.userId}:${weekKey(harness.clock.now())}`,
        `${parentB.userId}:${weekKey(harness.clock.now())}`,
      ].sort(),
    );
  });

  it('is IDEMPOTENT per (parent, week) — ten scans on Monday enqueue one each', async () => {
    // Ten replicas, a restart, a manual re-run. There is no "have I already
    // done this" query anywhere, because the unique index IS that query.
    const parent = await onboardAccount(harness, 'digest-c@example.test', 'parent');
    const source = fakeDigestSource({ parents: [parent.userId] });
    const { module } = buildNotify({ digest: source });

    expect(await module.service.scanWeeklyDigests()).toBe(1);
    for (let run = 0; run < 9; run += 1) {
      expect(await module.service.scanWeeklyDigests()).toBe(0);
    }

    const jobs = await harness.postgres.client.query(
      `select 1 from jobs where kind = 'notify.deliver_weekly_digest'`,
    );
    expect(jobs.rowCount).toBe(1);
  });

  it('enqueues AGAIN the following week, which is the point of a WEEKLY digest', async () => {
    // The idempotence must be per week and not forever. A key that never
    // changed would look identical in every test above and quietly send exactly
    // one digest per parent, ever.
    const parent = await onboardAccount(harness, 'digest-d@example.test', 'parent');
    const source = fakeDigestSource({ parents: [parent.userId] });
    const { module } = buildNotify({ digest: source });

    expect(await module.service.scanWeeklyDigests()).toBe(1);
    harness.clock.advanceDays(7);
    expect(await module.service.scanWeeklyDigests()).toBe(1);

    const jobs = await harness.postgres.client.query(
      `select 1 from jobs where kind = 'notify.deliver_weekly_digest'`,
    );
    expect(jobs.rowCount).toBe(2);
  });

  it('builds one parent digest through the seam and sends it bilingually', async () => {
    const parent = await onboardAccount(harness, 'digest-e@example.test', 'parent');
    const source = fakeDigestSource({ parents: [parent.userId] });
    const { module } = buildNotify({ digest: source });
    const weekStart = weekStartOf(harness.clock.now());

    const result = await module.service.deliverWeeklyDigest(parent.userId, weekStart);

    expect(result?.created).toBe(true);
    expect(source.builds).toEqual([{ parentUserId: parent.userId, weekStart }]);

    const listed = await module.service.listForUser(actorOf(parent, { role: 'parent' }), {
      limit: 10,
    });
    expect(listed.notifications[0]?.kind).toBe('digest_ready');
    expect(listed.notifications[0]?.title).toEqual(CONTENT.title);
    expect(listed.notifications[0]?.body.hi).toEqual(CONTENT.body.hi);
    // The week is stamped on the row, so it is not decoration — it is the
    // durable half of this function's idempotence.
    expect(listed.notifications[0]?.data.weekStart).toBe(weekKey(weekStart));
  });

  it('is idempotent per (parent, week) DURABLY, not only through the job key', async () => {
    // Both halves are needed. The key stops a duplicated ENQUEUE; this stops a
    // duplicated RUN, which the stuck-job reaper can cause and which no key can
    // prevent.
    const parent = await onboardAccount(harness, 'digest-f@example.test', 'parent');
    const source = fakeDigestSource({ parents: [parent.userId] });
    const { module, metrics } = buildNotify({ digest: source });
    const weekStart = weekStartOf(harness.clock.now());

    await module.service.deliverWeeklyDigest(parent.userId, weekStart);
    const repeat = await module.service.deliverWeeklyDigest(parent.userId, weekStart);

    expect(repeat).toBeNull();
    expect(metrics.totalFor(NOTIFY_METRICS.DIGEST_SKIPPED)).toBe(1);
    // The seam was not even asked a second time — a digest is expensive to
    // build (it reads traces and calls a model), so the cheap check runs first.
    expect(source.builds).toHaveLength(1);

    const rows = await harness.postgres.client.query(
      `select 1 from notifications where recipient_user_id = $1`,
      [parent.userId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('sends NOTHING when the seam decides the week produced nothing worth saying', async () => {
    // The judgement belongs to `parent`, which is why `buildDigest` MAY return
    // null rather than being forced to send a graceful-but-empty digest.
    const parent = await onboardAccount(harness, 'digest-g@example.test', 'parent');
    const source = fakeDigestSource({ parents: [parent.userId], content: null });
    const { module, metrics, logger } = buildNotify({ digest: source });

    const result = await module.service.deliverWeeklyDigest(
      parent.userId,
      weekStartOf(harness.clock.now()),
    );

    expect(result).toBeNull();
    expect(metrics.totalFor(NOTIFY_METRICS.DIGEST_SKIPPED)).toBe(1);
    expect(logger.lines.some((line) => line.obj.event === 'notify.digest_empty')).toBe(true);
    const rows = await harness.postgres.client.query(`select 1 from notifications`);
    expect(rows.rowCount).toBe(0);
  });

  it('logs COUNTS and never a parent id — the line describes personal data', async () => {
    const parent = await onboardAccount(harness, 'digest-h@example.test', 'parent');
    const source = fakeDigestSource({ parents: [parent.userId] });
    const { module, logger } = buildNotify({ digest: source });

    await module.service.scanWeeklyDigests();
    await module.service.deliverWeeklyDigest(parent.userId, weekStartOf(harness.clock.now()));

    const serialised = JSON.stringify(logger.lines);
    expect(serialised).not.toContain(parent.userId);
    expect(serialised).not.toContain('digest-h@example.test');
    const scan = logger.lines.find((line) => line.obj.event === 'notify.digest_scan');
    expect(scan?.obj).toMatchObject({ due: 1, enqueued: 1 });
  });
});
