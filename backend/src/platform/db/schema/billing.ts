import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity';
import { schools } from './schools';
import { DEFAULT_TENANT_ID, tenants } from './tenants';

/**
 * ===========================================================================
 * THE BILLING TABLES — plan §8.8.
 *
 * TWO TABLES, AND THE SECOND ONE IS THE POINT. `subscriptions` is what the
 * product reads; `payment_events` is what makes it trustworthy. §8.8 rule 2
 * requires the provider's event id to be a UNIQUE KEY, and rule 3 requires the
 * subscription update to happen IN THE SAME TRANSACTION as the event insert.
 * Those two rules together are the whole idempotence and atomicity story, and
 * both of them are enforced HERE, in the database, rather than by a service
 * remembering to check first.
 *
 * ===========================================================================
 * THE PAYER IS NOT ASSUMED TO BE THE BENEFICIARY, AND THAT IS A SCHEMA
 * DECISION RATHER THAN A CODE ONE.
 *
 * It is unresolved whether this ships as a B2C parent subscription or as a B2B
 * SCHOOL PILOT in which schools pay and per-parent subscriptions never exist.
 * A `subscriptions.user_id` column would have answered that question by
 * accident, in the cheapest-looking way, and unanswering it later is a
 * migration across live financial rows.
 *
 * So there are two independent facts on every row:
 *
 *   subject_user_id   WHOSE ENTITLEMENTS this grants. Always a user.
 *   payer_kind + one  WHO PAYS. A user, or a school. Exactly one of
 *   of the payer ids  `payer_user_id` / `payer_school_id` is non-null, and the
 *                     CHECK below makes any other combination unrepresentable.
 *
 * In B2C the payer is a user and equals the subject. In B2B the payer is a
 * school and the subject is a student who has never seen a payment page. Both
 * are the same table, the same query, and the same entitlement resolution.
 * ===========================================================================
 */

/**
 * The subscription lifecycle. Five states, no sixth.
 *
 * `past_due` is the grace period — a charge failed and access CONTINUES while
 * the provider retries. Dropping someone to free on a single failed card is how
 * a billing system loses a customer it had already convinced.
 *
 * `cancelled` also retains access, until `current_period_end`: they paid for
 * the period, and taking it back at the moment of cancellation is theft dressed
 * as a state machine. `expired` is the terminal state where access is gone, and
 * it is reached by TIME rather than by an event — which is why entitlements are
 * resolved against the clock at request time and never cached.
 */
export const SUBSCRIPTION_STATUSES = [
  'pending',
  'active',
  'past_due',
  'cancelled',
  'expired',
] as const;

const statusList = sql.raw(SUBSCRIPTION_STATUSES.map((status) => `'${status}'`).join(', '));

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * WHOSE ENTITLEMENTS THIS GRANTS.
     *
     * RESTRICT, not CASCADE — and it is the only place in this schema that
     * differs from the surrounding convention on purpose. A subscription is a
     * FINANCIAL record: money moved, and a receipt that disappears because
     * somebody deleted an account is a reconciliation hole and, in India, a
     * GST-invoice hole. Deleting a user who has ever been billed must therefore
     * FAIL LOUDLY rather than silently destroy the record.
     *
     * The consequence is real and is accepted deliberately: account erasure for
     * a paying user becomes an ANONYMISE operation rather than a DELETE. That
     * work does not exist yet; it is recorded in the decision log rather than
     * pre-built, because writing it before there is a single subscription would
     * be guessing at a retention policy nobody has set.
     */
    subjectUserId: uuid('subject_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /** `'user'` or `'school'`. See the header. */
    payerKind: text('payer_kind').notNull(),
    payerUserId: uuid('payer_user_id').references(() => users.id, { onDelete: 'restrict' }),
    payerSchoolId: uuid('payer_school_id').references(() => schools.id, { onDelete: 'restrict' }),

    /** Our plan code, not the provider's plan id. `free` never gets a row. */
    planCode: text('plan_code').notNull(),
    status: text('status').notNull(),

    /** `razorpay`, `fake`, … Stored so a vendor migration stays legible. */
    provider: text('provider').notNull(),
    /**
     * NULLABLE, for exactly one moment: a row is written `pending` before the
     * provider has answered, so that a crash between "charge created" and "row
     * written" leaves a record rather than an orphaned charge. It is filled in
     * the same transaction whenever the create succeeds.
     */
    providerSubscriptionId: text('provider_subscription_id'),

    /**
     * The end of the period that has been PAID FOR.
     *
     * This single column is what makes "an expired subscription cannot access
     * paid features" a fact about data rather than a promise about a cron job.
     * Nothing has to run for access to lapse: the entitlement resolver compares
     * this to the clock on every request.
     */
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    /** Paise. An integer, because money is never a float. */
    amountMinorUnits: integer('amount_minor_units').notNull().default(0),
    currency: text('currency').notNull().default('INR'),

    tenantId: uuid('tenant_id')
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('subscriptions_status_check', sql`${table.status} in (${statusList})`),
    check('subscriptions_payer_kind_check', sql`${table.payerKind} in ('user', 'school')`),
    /**
     * EXACTLY ONE PAYER, ENFORCED BY THE DATABASE.
     *
     * The interesting half is the second disjunct: a `school` payer must have a
     * `payer_school_id` AND a NULL `payer_user_id`. Without the null half, a
     * B2B row could carry a stale user payer and a reconciliation query joining
     * on `payer_user_id` would bill the wrong party — which is the kind of
     * defect that is discovered by an angry parent rather than by a test.
     */
    check(
      'subscriptions_payer_exactly_one_check',
      sql`(${table.payerKind} = 'user' and ${table.payerUserId} is not null and ${table.payerSchoolId} is null)
          or (${table.payerKind} = 'school' and ${table.payerSchoolId} is not null and ${table.payerUserId} is null)`,
    ),
    check('subscriptions_plan_code_check', sql`length(btrim(${table.planCode})) > 0`),
    check('subscriptions_amount_check', sql`${table.amountMinorUnits} >= 0`),
    check('subscriptions_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    /**
     * A CANCELLED OR EXPIRED ROW MUST CARRY A PERIOD END.
     *
     * Access after cancellation runs until `current_period_end`, so a cancelled
     * row with a NULL end is a row that grants access FOREVER — the failure
     * mode being prevented is "cancelled, and still entitled in 2031".
     */
    check(
      'subscriptions_terminal_period_check',
      sql`${table.status} not in ('cancelled', 'expired') or ${table.currentPeriodEnd} is not null`,
    ),
    /**
     * The provider's id is unique PER PROVIDER. A webhook is reconciled by
     * looking a subscription up through this pair, so a duplicate would make
     * "which subscription is this event about" ambiguous at the worst moment.
     */
    unique('subscriptions_provider_key').on(table.provider, table.providerSubscriptionId),
    /**
     * ONE LIVE SUBSCRIPTION PER BENEFICIARY, as a PARTIAL unique index.
     *
     * Partial rather than total, because a user legitimately accumulates
     * cancelled and expired rows over years and a total constraint would make
     * re-subscribing impossible. What it prevents is the double-subscribe: two
     * checkout tabs, two `pending` rows, two charges, and an entitlement
     * resolver that has to guess which one is real.
     */
    uniqueIndex('subscriptions_one_live_idx')
      .on(table.subjectUserId)
      .where(sql`status in ('pending', 'active', 'past_due')`),
    index('subscriptions_subject_idx').on(table.subjectUserId),
    index('subscriptions_payer_user_idx').on(table.payerUserId),
    index('subscriptions_payer_school_idx').on(table.payerSchoolId),
    index('subscriptions_tenant_idx').on(table.tenantId),
  ],
);

/**
 * ===========================================================================
 * THE PROVIDER'S EVENT LOG — §8.8 rule 2, and the entire replay defence.
 *
 * `unique (provider, provider_event_id)` IS THE IDEMPOTENCE MECHANISM. Not a
 * "have I seen this?" SELECT before the write — two concurrent deliveries both
 * pass that, which is precisely the case a provider's retry storm produces.
 * The insert is attempted, the unique violation is caught, and the handler
 * answers 200 and stops. The check and the write are the same statement, so
 * there is no window between them.
 *
 * EVERY event is recorded, including ones whose `kind` is `unknown` and ones
 * that match no subscription. An event log with the confusing rows filtered out
 * is an event log that cannot explain the incident it was kept for.
 * ===========================================================================
 */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    /** The provider's id, or a digest of the raw body when it sends none. */
    providerEventId: text('provider_event_id').notNull(),
    /** Our canonical kind. `unknown` for an event type we do not implement. */
    kind: text('kind').notNull(),
    /** The provider's own name for it, before translation. */
    providerEventName: text('provider_event_name').notNull(),

    /**
     * The subscription this event moved, when it matched one.
     *
     * NULLABLE, and the null is meaningful: an event for a subscription id we
     * have never seen is exactly the signal that our records and the provider's
     * have diverged. Dropping such an event would erase the only evidence of
     * that. RESTRICT for the same reason `subject_user_id` is: a financial
     * record does not disappear because a row above it was deleted.
     */
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'restrict',
    }),

    /** Whatever the provider sent, whole. The evidence, not our reading of it. */
    payload: jsonb('payload').notNull(),

    /**
     * NULLABLE, and deliberately — the same reasoning as `audit_log` and
     * `notifications` (open item 8, D-084).
     *
     * The writer is an anonymous provider webhook. It has no actor and no
     * session, so there is no tenant to inherit; the only authoritative source
     * is the SUBSCRIPTION the event matched, and an event that matches nothing
     * genuinely has no tenant. A NOT NULL column filled from the column default
     * in that case would file cross-tenant noise under whichever tenant happens
     * to be first — a value that reads as a fact and is not one.
     *
     * So: stamped from the matched subscription when there is one, NULL when
     * there is not, which is D-084's named mechanism rather than an omission.
     */
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** §8.8 rule 2. THE replay defence. */
    unique('payment_events_provider_event_key').on(table.provider, table.providerEventId),
    check('payment_events_kind_check', sql`length(btrim(${table.kind})) > 0`),
    /**
     * A jsonb OBJECT, not a bare scalar. `payload: 4` is valid jsonb and is not
     * a payment event; the same CHECK `audit_log.details` carries.
     */
    check('payment_events_payload_object_check', sql`jsonb_typeof(${table.payload}) = 'object'`),
    index('payment_events_subscription_idx').on(table.subscriptionId, table.receivedAt.desc()),
    index('payment_events_received_idx').on(table.receivedAt.desc()),
  ],
);

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type NewSubscriptionRow = typeof subscriptions.$inferInsert;
export type PaymentEventRow = typeof paymentEvents.$inferSelect;
export type NewPaymentEventRow = typeof paymentEvents.$inferInsert;
