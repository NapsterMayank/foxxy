import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DbExecutor, DbHandle } from '@/platform/db/index';
import { schema, unwrapExecutor, wrapExecutor } from '@/platform/db/index';
import type { TransactionToken } from '@/platform/tx/index';
import type { SubscriptionStatus } from '@/shared/contracts/billing.contract';
import type { SubscriptionRecord } from './billing.types';

/**
 * ALL database access for the billing module — §7, rule 4. Enforced by ESLint:
 * `@/platform/db` and `drizzle-orm` are importable only from a
 * `*.repository.ts` file.
 *
 * ===========================================================================
 * THIS REPOSITORY DOES NOT OPEN THE WEBHOOK TRANSACTION — the same shape as
 * `practice`, for a different reason.
 *
 * §8.8 rule 3 requires the `payment_events` insert and the `subscriptions`
 * update to land in ONE transaction. In between them sits a DECISION — the
 * state machine in `domain/subscription-status.ts` — and a decision belongs to
 * the service, not to a repository. So the repository exposes
 * `withTransaction`, hands back an opaque `TransactionToken`, and every write
 * takes it. The SERVICE owns the boundary and is the single place that can be
 * read to find out what is inside it.
 *
 * The alternative — one fat repository method doing lookup, insert, decide and
 * update — would put the product's most consequential branch in the layer that
 * is hardest to test and is forbidden from importing the domain.
 * ===========================================================================
 */

const { subscriptions, paymentEvents } = schema;

export type BillingDbHandle = DbHandle;

interface SubscriptionRow {
  id: string;
  subjectUserId: string;
  payerKind: string;
  payerUserId: string | null;
  payerSchoolId: string | null;
  planCode: string;
  status: string;
  provider: string;
  providerSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  cancelledAt: Date | null;
  amountMinorUnits: number;
  currency: string;
  tenantId: string;
}

/**
 * Maps a row.
 *
 * The payer is REASSEMBLED into `{ kind, id }` here, so that nothing above this
 * file ever sees the two nullable columns. A service holding `payerUserId` and
 * `payerSchoolId` separately would eventually write `payerUserId ?? ''`
 * somewhere, and the B2B case would silently become "the empty user".
 *
 * The database CHECK guarantees exactly one is present, so the `?? ''` below is
 * unreachable — and is written rather than asserted because a repository that
 * throws on a shape the database refuses to store adds a failure mode without
 * removing one.
 */
function toRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    subjectUserId: row.subjectUserId,
    payer: {
      kind: row.payerKind === 'school' ? 'school' : 'user',
      id: (row.payerKind === 'school' ? row.payerSchoolId : row.payerUserId) ?? '',
    },
    planCode: row.planCode,
    status: row.status as SubscriptionStatus,
    provider: row.provider,
    providerSubscriptionId: row.providerSubscriptionId,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelledAt: row.cancelledAt,
    amountMinorUnits: row.amountMinorUnits,
    currency: row.currency,
    tenantId: row.tenantId,
  };
}

/** The statuses `subscriptions_one_live_idx` treats as occupying the slot. */
const LIVE_STATUSES: readonly SubscriptionStatus[] = ['pending', 'active', 'past_due'];

export interface CreateSubscriptionRow {
  readonly subjectUserId: string;
  readonly payerKind: 'user' | 'school';
  readonly payerUserId: string | null;
  readonly payerSchoolId: string | null;
  readonly planCode: string;
  readonly provider: string;
  readonly providerSubscriptionId: string | null;
  readonly amountMinorUnits: number;
  readonly currency: string;
  readonly tenantId: string;
  readonly now: Date;
}

export interface SubscriptionStateUpdate {
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: Date | null;
  readonly cancelledAt: Date | null;
  readonly now: Date;
}

export interface PaymentEventRowInput {
  readonly provider: string;
  readonly providerEventId: string;
  readonly kind: string;
  readonly providerEventName: string;
  readonly subscriptionId: string | null;
  readonly payload: unknown;
  /** From the matched subscription, or null. D-084's mechanism, not a default. */
  readonly tenantId: string | null;
  readonly now: Date;
}

export interface BillingRepository {
  /** The service owns the boundary — see the header. */
  withTransaction<T>(fn: (tx: TransactionToken) => Promise<T>): Promise<T>;

  createSubscription(input: CreateSubscriptionRow): Promise<SubscriptionRecord>;
  /** Fills in the provider's id once it has answered. Same request, no job. */
  attachProviderId(id: string, providerSubscriptionId: string, now: Date): Promise<void>;

  /** The subscription occupying the live slot for this beneficiary, or null. */
  findLiveForSubject(subjectUserId: string): Promise<SubscriptionRecord | null>;
  /**
   * The most recent subscription for this beneficiary, live or not.
   *
   * What `/billing/status` reads: a user whose subscription lapsed last month
   * must still see it, with an expired status, rather than a blank page that
   * looks like they never subscribed.
   */
  findLatestForSubject(subjectUserId: string): Promise<SubscriptionRecord | null>;
  findById(id: string): Promise<SubscriptionRecord | null>;

  /**
   * Locks and returns the subscription a webhook is about — `SELECT … FOR
   * UPDATE`, inside the caller's transaction.
   *
   * THE LOCK IS NOT INCIDENTAL. Two deliveries of two different events for the
   * same subscription, arriving together, would otherwise both read the same
   * state, both compute a transition from it, and the second write would
   * silently discard the first. The lock serialises them so the second one
   * decides against the state the first one left behind.
   */
  lockByProviderId(
    tx: TransactionToken,
    provider: string,
    providerSubscriptionId: string,
  ): Promise<SubscriptionRecord | null>;

  /**
   * §8.8 RULE 2 — THE REPLAY DEFENCE.
   *
   * Returns false when this event has already been recorded. NOT a
   * read-then-write: `ON CONFLICT DO NOTHING` makes the check and the write one
   * statement, so two concurrent deliveries of the same event cannot both pass.
   */
  insertPaymentEvent(tx: TransactionToken, input: PaymentEventRowInput): Promise<boolean>;

  updateSubscriptionState(
    tx: TransactionToken,
    id: string,
    update: SubscriptionStateUpdate,
  ): Promise<void>;

  /** How many events have been recorded for a subscription. Support/forensics. */
  countEventsFor(subscriptionId: string): Promise<number>;
}

export function createBillingRepository(handle: BillingDbHandle): BillingRepository {
  const { db } = handle;

  function executorOf(tx: TransactionToken): DbExecutor {
    const executor = unwrapExecutor(tx);
    if (executor === undefined) {
      // Asserted rather than defaulted to `db`. Defaulting would turn "the
      // transaction was lost" into "it wrote anyway, outside the transaction" —
      // which is exactly the split-brain §8.8 rule 3 exists to prevent, and it
      // would be invisible.
      throw new Error('billing.repository: a write was called without a transaction');
    }
    return executor;
  }

  return {
    withTransaction<T>(fn: (tx: TransactionToken) => Promise<T>): Promise<T> {
      return handle.withTransaction((executor) => fn(wrapExecutor(executor)));
    },

    async createSubscription(input: CreateSubscriptionRow): Promise<SubscriptionRecord> {
      const rows = await db
        .insert(subscriptions)
        .values({
          subjectUserId: input.subjectUserId,
          payerKind: input.payerKind,
          payerUserId: input.payerUserId,
          payerSchoolId: input.payerSchoolId,
          planCode: input.planCode,
          // ALWAYS `pending`. A row is never born entitled — access begins when
          // a verified webhook says money arrived, and the status column is not
          // a parameter a caller can hand in.
          status: 'pending',
          provider: input.provider,
          providerSubscriptionId: input.providerSubscriptionId,
          amountMinorUnits: input.amountMinorUnits,
          currency: input.currency,
          // The tenant that `assertCanAccess` just passed on, never the column
          // default: a default cannot tell "not supplied" from "supplied and
          // equal to the default" (D-073).
          tenantId: input.tenantId,
          // From the INJECTED clock, never `defaultNow()`. Entitlements compare
          // `current_period_end` against application time, and mixing it with
          // database time is a comparison between two clocks that can differ.
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();

      const row = rows[0];
      if (row === undefined) throw new Error('billing.repository: createSubscription returned no row');
      return toRecord(row);
    },

    async attachProviderId(id: string, providerSubscriptionId: string, now: Date): Promise<void> {
      await db
        .update(subscriptions)
        .set({ providerSubscriptionId, updatedAt: now })
        .where(eq(subscriptions.id, id));
    },

    async findLiveForSubject(subjectUserId: string): Promise<SubscriptionRecord | null> {
      const rows = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.subjectUserId, subjectUserId),
            inArray(subscriptions.status, [...LIVE_STATUSES]),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async findLatestForSubject(subjectUserId: string): Promise<SubscriptionRecord | null> {
      const rows = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.subjectUserId, subjectUserId))
        .orderBy(desc(subscriptions.createdAt))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async findById(id: string): Promise<SubscriptionRecord | null> {
      const rows = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async lockByProviderId(
      tx: TransactionToken,
      provider: string,
      providerSubscriptionId: string,
    ): Promise<SubscriptionRecord | null> {
      const rows = await executorOf(tx)
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.provider, provider),
            eq(subscriptions.providerSubscriptionId, providerSubscriptionId),
          ),
        )
        .limit(1)
        .for('update');
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async insertPaymentEvent(tx: TransactionToken, input: PaymentEventRowInput): Promise<boolean> {
      const rows = await executorOf(tx)
        .insert(paymentEvents)
        .values({
          provider: input.provider,
          providerEventId: input.providerEventId,
          kind: input.kind,
          providerEventName: input.providerEventName,
          subscriptionId: input.subscriptionId,
          // The provider's own bytes, whole. The evidence, not our reading.
          payload: input.payload,
          tenantId: input.tenantId,
          receivedAt: input.now,
        })
        // THE DEDUPLICATION. One statement, no window.
        .onConflictDoNothing({
          target: [paymentEvents.provider, paymentEvents.providerEventId],
        })
        .returning({ id: paymentEvents.id });

      return rows.length > 0;
    },

    async updateSubscriptionState(
      tx: TransactionToken,
      id: string,
      update: SubscriptionStateUpdate,
    ): Promise<void> {
      await executorOf(tx)
        .update(subscriptions)
        .set({
          status: update.status,
          currentPeriodEnd: update.currentPeriodEnd,
          cancelledAt: update.cancelledAt,
          updatedAt: update.now,
        })
        .where(eq(subscriptions.id, id));
    },

    async countEventsFor(subscriptionId: string): Promise<number> {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(paymentEvents)
        .where(eq(paymentEvents.subscriptionId, subscriptionId));
      return rows[0]?.count ?? 0;
    },
  };
}
