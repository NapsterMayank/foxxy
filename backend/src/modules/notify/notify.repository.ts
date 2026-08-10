import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { DbHandle } from '@/platform/db/index';
import { schema } from '@/platform/db/index';
import { isNotifyKind } from './domain/kinds';
import type { NotificationRecord } from './notify.types';

/**
 * ALL database access for the notify module — §7, rule 4.
 *
 * Enforced by ESLint: `@/platform/db` and `drizzle-orm` are importable only
 * from a `*.repository.ts` file. Without that rule someone eventually writes a
 * query that skips the authorization check.
 *
 * ===========================================================================
 * EVERY READ AND EVERY WRITE IS SCOPED BY RECIPIENT **AND** TENANT.
 *
 * Not by recipient alone. The service has already called `assertCanAccess`, so
 * the tenant predicate here is belt-and-braces — but it is the belt that
 * survives somebody adding a second call site and forgetting the guard, which
 * is precisely how the "enforced by remembering" failure mode that
 * `platform/authz` exists to close gets back in.
 *
 * ===========================================================================
 * `notifications.tenant_id` IS NULLABLE IN THE SCHEMA. THIS MODULE NEVER
 * WRITES A NULL, AND NEVER READS ONE.
 *
 * D-084 left the column nullable on the reasoning that the in-app channel "is
 * handed a recipient and nothing else" and therefore has no tenant to write —
 * and that a NOT NULL column whose only writer relies on the column default is
 * theatre. The mechanism it named as the fix is exactly what `notify.send` now
 * does: resolve the tenant FROM THE RECIPIENT before writing.
 *
 * So every row this module causes to exist carries a real tenant, and every
 * query below filters on one. A pre-existing null-tenant row (there are none in
 * production; nothing else writes this table) would simply be invisible, which
 * is the correct posture for a row nobody can attribute to a tenant.
 *
 * MAKING THE COLUMN NOT NULL IS A MIGRATION AND IS DELIBERATELY NOT DONE HERE —
 * it is reported as a follow-up rather than smuggled in.
 *
 * ===========================================================================
 * DELIVERY BOOKKEEPING LIVES UNDER `data._delivery`, AND THAT IS A COMPROMISE.
 *
 * `claimDelivery` is a compare-and-set: it writes the claim only if no claim is
 * present, in ONE statement, and reports whether it won. That is what makes the
 * delivery job idempotent — two workers, or one worker and the stuck-job
 * reaper, run the handler twice and exactly one of them sends.
 *
 * The honest home for this is a `notification_deliveries` table with one row
 * per attempt per channel. That needs a migration, so it is REPORTED rather
 * than written: see the module report. `data` is jsonb, already exists, and is
 * already the column the client reads — which is why every read path below
 * strips `_`-prefixed keys before the payload leaves this file. A client must
 * never see our bookkeeping, and a future `_`-prefixed key must not need a
 * second edit somewhere else to stay hidden.
 */

const { notifications } = schema;

/**
 * The database handle, re-exported under a module-local name.
 *
 * `index.ts` has to declare this as a dependency, and the ESLint boundary bans
 * `@/platform/db` outside a `*.repository.ts` — including type imports. Same
 * pattern, same reason, as `LearnerDbHandle`.
 */
export type NotifyDbHandle = DbHandle;

/** Where delivery bookkeeping lives inside `data`. See the header. */
const DELIVERY_KEY = '_delivery';

/**
 * How long a delivery claim is honoured before another worker may take it.
 *
 * Two minutes, matching `job-runner.ts`'s `DEFAULT_LOCK_TIMEOUT_MS`, and for
 * the same reason: a worker killed mid-delivery leaves an `in_progress` marker
 * that nobody will ever clear. Without this clause the stuck-job reaper would
 * hand the job back, the handler would find the stale claim, report a duplicate
 * and SUCCEED — a job that reports having delivered something it never sent,
 * which is the exact silent failure this module exists to make impossible.
 *
 * The trade is the documented at-least-once edge: a delivery that genuinely
 * takes longer than two minutes may be attempted twice. Two emails beats zero.
 */
const CLAIM_LOCK_MS = 120_000;

interface NotificationRow {
  id: string;
  recipientUserId: string;
  tenantId: string | null;
  kind: string;
  titleEn: string;
  titleHi: string;
  bodyEn: string;
  bodyHi: string;
  data: unknown;
  readAt: Date | null;
  createdAt: Date;
}

/**
 * Strips internal keys from a stored payload.
 *
 * Anything beginning `_` is ours: delivery claims today, whatever bookkeeping
 * comes next. A prefix rule rather than a list of known keys, so adding a
 * second internal key cannot accidentally leak it.
 */
function toClientData(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('_')) continue;
    out[key] = entry;
  }
  return out;
}

/**
 * Maps a row to a record.
 *
 * `kind` is validated rather than asserted, unlike `grade` in learner. There is
 * no CHECK constraint behind it — the column is open text because
 * `platform/notify-channel` predates this module and takes any kind string — so
 * a narrowing assertion here would be a claim nothing stands behind. A row with
 * an unrecognised kind is skipped by the caller instead.
 */
function toRecord(row: NotificationRow): NotificationRecord | null {
  if (!isNotifyKind(row.kind)) return null;
  if (row.tenantId === null) return null;

  return {
    id: row.id,
    recipientUserId: row.recipientUserId,
    tenantId: row.tenantId,
    kind: row.kind,
    title: { en: row.titleEn, hi: row.titleHi },
    body: { en: row.bodyEn, hi: row.bodyHi },
    data: toClientData(row.data),
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

export interface OwnerRef {
  readonly recipientUserId: string;
  /** The empty string when the row carries no tenant — the guard denies it. */
  readonly tenantId: string;
}

export interface ListInput {
  readonly recipientUserId: string;
  readonly tenantId: string;
  readonly limit: number;
  /** Keyset cursor: rows strictly older than this. */
  readonly before?: Date | undefined;
}

export interface ScopedInput {
  readonly recipientUserId: string;
  readonly tenantId: string;
}

export interface MarkReadInput extends ScopedInput {
  readonly notificationId: string;
  readonly now: Date;
}

export interface NotifyRepository {
  /**
   * The recipient and tenant of one row, for the access check — WITHOUT the
   * content.
   *
   * Deliberately separate from `find`. The guard must run before any payload is
   * loaded, so that a cross-user request cannot be answered from data that was
   * already in memory. Returns null for a row that does not exist, which the
   * service turns into the same contentless 403 as a row belonging to someone
   * else.
   */
  findOwner(notificationId: string): Promise<OwnerRef | null>;
  list(input: ListInput): Promise<NotificationRecord[]>;
  countUnread(input: ScopedInput): Promise<number>;
  /** Returns false when the row was already read, or matched nothing. */
  markRead(input: MarkReadInput): Promise<boolean>;
  markAllRead(input: ScopedInput & { readonly now: Date }): Promise<number>;
  /** The full row, for the delivery job. NOT access-checked — see the service. */
  findForDelivery(notificationId: string): Promise<NotificationRecord | null>;
  /**
   * Compare-and-set the delivery claim. True means this caller won and must
   * deliver; false means somebody already did.
   */
  claimDelivery(notificationId: string, now: Date): Promise<boolean>;
  /**
   * Whether this recipient already has a digest for this week.
   *
   * The DURABLE half of "a digest is sent once per parent per week". The job
   * key covers a duplicated ENQUEUE; this covers a duplicated RUN, which the
   * stuck-job reaper can cause and which no key can prevent.
   */
  hasDigestFor(recipientUserId: string, weekStartKey: string): Promise<boolean>;
  /** Records how delivery ended, for support and for the dead-letter trail. */
  recordDeliveryOutcome(notificationId: string, outcome: string, now: Date): Promise<void>;
  /** Test and support seam: what `_delivery` currently holds. */
  readDeliveryMarker(notificationId: string): Promise<Readonly<Record<string, unknown>> | null>;
}

export function createNotifyRepository(handle: NotifyDbHandle): NotifyRepository {
  const { db } = handle;

  const scopedTo = (recipientUserId: string, tenantId: string) =>
    and(
      eq(notifications.recipientUserId, recipientUserId),
      eq(notifications.tenantId, tenantId),
    );

  return {
    async findOwner(notificationId: string): Promise<OwnerRef | null> {
      const rows = await db
        .select({
          recipientUserId: notifications.recipientUserId,
          tenantId: notifications.tenantId,
        })
        .from(notifications)
        .where(eq(notifications.id, notificationId))
        .limit(1);

      const row = rows[0];
      if (row === undefined) return null;
      // A null tenant becomes the empty string, which `assertCanAccess` treats
      // as "no tenant" and DENIES. Routed through the guard rather than thrown
      // here so an unattributable row and a cross-tenant row produce
      // byte-identical output — which they only do if both take the same path.
      return { recipientUserId: row.recipientUserId, tenantId: row.tenantId ?? '' };
    },

    async list(input: ListInput): Promise<NotificationRecord[]> {
      const where =
        input.before === undefined
          ? scopedTo(input.recipientUserId, input.tenantId)
          : and(
              scopedTo(input.recipientUserId, input.tenantId),
              lt(notifications.createdAt, input.before),
            );

      // Newest first, which is the only order this list is ever read in and the
      // order `notifications_recipient_created_idx` is built for.
      const rows = await db
        .select()
        .from(notifications)
        .where(where)
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(input.limit);

      return rows.map(toRecord).filter((record): record is NotificationRecord => record !== null);
    },

    async countUnread(input: ScopedInput): Promise<number> {
      // `count(*)` over the partial index `notifications_unread_idx`, not a
      // fetch-and-length. The badge is polled on every screen; loading the rows
      // to count them would move a page of jsonb per poll.
      const rows = await db
        .select({ count: sql<string>`count(*)::text` })
        .from(notifications)
        .where(and(scopedTo(input.recipientUserId, input.tenantId), isNull(notifications.readAt)));

      return Number(rows[0]?.count ?? '0');
    },

    async markRead(input: MarkReadInput): Promise<boolean> {
      // `read_at is null` in the predicate rather than a read-then-write: two
      // taps on the same notification would otherwise race, and the second
      // would overwrite the first timestamp. It also makes the return value
      // mean "this call changed something", which is what the client is told.
      const rows = await db
        .update(notifications)
        .set({ readAt: input.now })
        .where(
          and(
            eq(notifications.id, input.notificationId),
            scopedTo(input.recipientUserId, input.tenantId),
            isNull(notifications.readAt),
          ),
        )
        .returning({ id: notifications.id });

      return rows.length > 0;
    },

    async markAllRead(input: ScopedInput & { readonly now: Date }): Promise<number> {
      const rows = await db
        .update(notifications)
        .set({ readAt: input.now })
        .where(and(scopedTo(input.recipientUserId, input.tenantId), isNull(notifications.readAt)))
        .returning({ id: notifications.id });

      return rows.length;
    },

    async findForDelivery(notificationId: string): Promise<NotificationRecord | null> {
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.id, notificationId))
        .limit(1);

      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },

    /**
     * ONE STATEMENT, and that is the whole point.
     *
     * `where ... and data -> '_delivery' is null` makes the read and the write
     * a single atomic act. The obvious alternative — select, check, update —
     * has a window between the check and the write in which a second worker
     * does the same thing, and the observable result is a duplicate email.
     * `returning id` reports who won.
     */
    async claimDelivery(notificationId: string, now: Date): Promise<boolean> {
      const claim = JSON.stringify({ claimedAt: now.toISOString(), outcome: 'in_progress' });
      const staleBefore = new Date(now.getTime() - CLAIM_LOCK_MS).toISOString();

      const result = await db.execute<{ id: string }>(sql`
        update notifications
        set data = jsonb_set(data, ${`{${DELIVERY_KEY}}`}, ${claim}::jsonb, true)
        where id = ${notificationId}
          and (
            (data -> ${DELIVERY_KEY}) is null
            or (data #>> ${`{${DELIVERY_KEY},outcome}`}) = 'failed'
            or (
              (data #>> ${`{${DELIVERY_KEY},outcome}`}) = 'in_progress'
              and (data #>> ${`{${DELIVERY_KEY},claimedAt}`}) < ${staleBefore}
            )
          )
        returning id
      `);

      return result.rows.length > 0;
    },

    async hasDigestFor(recipientUserId: string, weekStartKey: string): Promise<boolean> {
      const result = await db.execute<{ id: string }>(sql`
        select id from notifications
        where recipient_user_id = ${recipientUserId}
          and kind = 'digest_ready'
          and (data ->> 'weekStart') = ${weekStartKey}
        limit 1
      `);
      return result.rows.length > 0;
    },

    async recordDeliveryOutcome(
      notificationId: string,
      outcome: string,
      now: Date,
    ): Promise<void> {
      const marker = JSON.stringify({ settledAt: now.toISOString(), outcome });
      await db.execute(sql`
        update notifications
        set data = jsonb_set(
          data,
          ${`{${DELIVERY_KEY}}`},
          coalesce(data -> ${DELIVERY_KEY}, '{}'::jsonb) || ${marker}::jsonb,
          true
        )
        where id = ${notificationId}
      `);
    },

    async readDeliveryMarker(
      notificationId: string,
    ): Promise<Readonly<Record<string, unknown>> | null> {
      const result = await db.execute<{ marker: Record<string, unknown> | null }>(sql`
        select data -> ${DELIVERY_KEY} as marker
        from notifications
        where id = ${notificationId}
      `);
      return result.rows[0]?.marker ?? null;
    },
  };
}
