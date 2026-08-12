import { AUDIT_RESOURCES, type AuditPort } from '@/platform/audit/index';
import { createAccessGuard } from '@/platform/authz/index';
import type { Clock } from '@/platform/clock/index';
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '@/platform/errors/index';
import type { Logger } from '@/platform/logger/index';
import type { PaymentsPort, WebhookDelivery } from '@/platform/payments/index';
import type { RateLimiter } from '@/platform/rate-limit/index';
import type { TransactionToken } from '@/platform/tx/index';
import type { RateLimitRule } from '@/shared/constants/rate-limits';
import type {
  BillingStatusResponse,
  Entitlements,
  SubscriptionStatus,
} from '@/shared/contracts/billing.contract';
import { freeEntitlements, resolveEntitlements } from './domain/entitlements';
import { findPlan } from './domain/plans';
import { applyPaymentEvent, effectiveStatus } from './domain/subscription-status';
import type { BillingRepository } from './billing.repository';
import type {
  BillingActor,
  PayerResolver,
  SubscriptionRecord,
  TenantReader,
  WebhookOutcome,
} from './billing.types';

/**
 * ============================================================================
 * THE BILLING USE-CASES — 01-BACKEND-IMPLEMENTATION-PLAN.md §8.8.
 *
 * FIVE OF THEM. Four are authorised through `platform/authz`; the fifth —
 * `handleWebhook` — has NO ACTOR AT ALL, and that asymmetry is the single most
 * important thing to understand about this file.
 *
 * ============================================================================
 * THE WEBHOOK IS AN UNAUTHENTICATED PUBLIC ENDPOINT. IT IS AUTHORISED BY A
 * SIGNATURE AND BY NOTHING ELSE.
 *
 * `app/plugins/origin-check.ts` exempts `/api/v1/webhooks/` from the CSRF
 * origin check, because a payment provider POSTs server-to-server and sends no
 * browser `Origin`. That exemption is only defensible because the HMAC replaces
 * it, and the HMAC is only a defence if it runs FIRST. So the order in
 * `handleWebhook` below is not a style choice — it is §8.8's four rules, in
 * order, and each one is annotated where it happens:
 *
 *   1. VERIFY THE SIGNATURE BEFORE PARSING ANYTHING.
 *   2. INSERT INTO `payment_events` KEYED BY THE PROVIDER'S EVENT ID. A unique
 *      violation means duplicate: answer 200 and stop.
 *   3. UPDATE THE SUBSCRIPTION IN THE SAME TRANSACTION AS THE EVENT ROW.
 *   4. ON FAILURE, 5XX SO THE PROVIDER RETRIES. Never swallow and return 200.
 *
 * Rule 4 is why there is no `try { … } catch { return ok }` anywhere below.
 * Every error propagates to the error handler, which renders a 5xx, which makes
 * the provider retry — and rule 2 makes that retry harmless.
 *
 * ============================================================================
 * NOTHING IN THIS FILE ASSUMES A PARENT PAYS.
 *
 * The payer arrives from an injected `PayerResolver`. In B2C it returns the
 * actor; in a B2B school pilot it returns the subject's school and the actor is
 * never billed at all. This module constructs no payer of its own, so it cannot
 * accidentally hard-code one.
 *
 * ============================================================================
 * THE RESOURCE TENANT IS READ FROM `users`, NEVER ECHOED OFF THE ACTOR (D-091).
 *
 * `authoriseSubscription` resolves it through the injected `TenantReader`.
 * Passing `actor.tenantId` would type-check perfectly and make
 * `assertTenantMatch` compare a value with itself. That defect has been found
 * FIVE times in this codebase — most recently in `parent.authoriseSelf`, where
 * it survived an entire suite because the only caller's ownership rule was
 * trivially true. `billing.authz-mutation.test.ts` installs it deliberately and
 * proves a cross-tenant read then succeeds.
 * ============================================================================
 *
 * The clock is injected. There is no `new Date()` in this file and there must
 * never be one — every entitlement decision depends on it.
 */

/**
 * ============================================================================
 * THE WEBHOOK'S REJECTION BUDGET — D-258.
 *
 * `POST /api/v1/webhooks/billing` is the one endpoint in the product that is
 * unauthenticated by design, exempt from the CSRF origin check, and reachable
 * by anybody on the internet. Until this constant existed it was also
 * UNRATE-LIMITED, and every delivery whose signature failed wrote a durable
 * `audit_log` row. So a forged-signature flood was an append-only table growing
 * at the attacker's chosen rate, consuming database capacity and disk on an
 * endpoint that costs them nothing to call. The audit row is there to report
 * probing; at volume it becomes the payload.
 *
 * ----------------------------------------------------------------------------
 * THE KEY IS A CONSTANT, AND THAT IS THE POINT.
 *
 * NOT the client IP, NOT the `x-razorpay-event-id` header, NOT anything else in
 * the request — every one of those is chosen by the caller, so limiting on them
 * limits nobody: an attacker rotates the value and gets a fresh budget, while
 * the one caller who cannot rotate anything is the genuine provider behind a
 * stable egress address. A single global counter is the only key in this
 * request that the attacker does not control.
 *
 * ----------------------------------------------------------------------------
 * IT IS SPENT ONLY BY REJECTED DELIVERIES, WHICH IS WHY A FLOOD CANNOT STARVE
 * THE PROVIDER.
 *
 * The obvious design — one budget for the whole endpoint — has a nasty edge: a
 * shared counter keyed globally means an attacker's traffic exhausts the budget
 * that Razorpay's genuine, bursty retries need, and the visible failure is
 * subscriptions that never activate. Charging only the REJECTED path removes
 * that entirely. A verified delivery never touches the limiter and can never be
 * throttled, no matter what else is arriving; a forged one spends from a budget
 * it shares with every other forgery.
 *
 * Exceeding it suppresses the AUDIT WRITE and nothing else. The response is
 * unchanged — still a contentless 400 — so the endpoint reveals nothing new,
 * and the log line still fires because a warn line is bounded by the log
 * pipeline where an unbounded table is not.
 *
 * 30 A MINUTE is far above any plausible rate of genuine signature failure (a
 * rotated secret produces a handful of retries, not thirty a minute) and far
 * below a rate at which the table is a capacity problem. The first rejection in
 * a window is always audited, so a single probe is never invisible.
 * ============================================================================
 */
export const WEBHOOK_REJECTION_RATE_LIMIT: RateLimitRule = { limit: 30, windowSeconds: 60 };

/** The one, constant, caller-independent counter key. See the block above. */
export const WEBHOOK_REJECTION_RATE_LIMIT_KEY = 'billing:webhook:rejected';

/** `audit_log.action` values this module writes. Dotted and past tense. */
export const BILLING_AUDIT_ACTIONS = {
  SUBSCRIPTION_CREATED: 'billing.subscription_created',
  SUBSCRIPTION_CANCELLED: 'billing.subscription_cancelled',
  /** A delivery whose signature did not verify. The one that matters. */
  WEBHOOK_REJECTED: 'billing.webhook_rejected',
} as const;

export interface BillingServiceDeps {
  readonly repository: BillingRepository;
  readonly payments: PaymentsPort;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The RESOURCE side of the tenant comparison, read from `users` (D-091). */
  readonly readTenantOfUser: TenantReader;
  /** WHO PAYS. The B2C/B2B seam — see `PayerResolver`. */
  readonly resolvePayer: PayerResolver;
  readonly audit: AuditPort;
  /**
   * The budget spent by REJECTED webhook deliveries — D-258.
   *
   * REQUIRED, not optional with a permissive default. An absent limiter here
   * would restore exactly the defect: an unauthenticated endpoint writing
   * durable rows at a rate the caller picks. A construction site that has not
   * supplied one must fail to compile rather than fail open.
   */
  readonly rateLimiter: RateLimiter;
}

export interface BillingService {
  /** §8.8 — start a checkout. Never grants access; the webhook does that. */
  createSubscription(
    actor: BillingActor,
    planCode: string,
  ): Promise<{ subscription: SubscriptionRecord; checkoutUrl: string }>;
  /** §8.8 — the provider's callback. NO ACTOR. Authorised by signature alone. */
  handleWebhook(delivery: WebhookDelivery): Promise<WebhookOutcome>;
  /** §8.8 — what this user may do RIGHT NOW. Never cached. */
  getEntitlements(actor: BillingActor, subjectUserId: string): Promise<Entitlements>;
  /** §8.8 — stop the renewal. Access continues to the end of the paid period. */
  cancelSubscription(actor: BillingActor, subjectUserId: string): Promise<SubscriptionRecord>;
  /** §8.8 — status AND entitlements, read from one row at one instant. */
  getSubscriptionStatus(actor: BillingActor, subjectUserId: string): Promise<BillingStatusResponse>;
}

export function createBillingService(deps: BillingServiceDeps): BillingService {
  const { repository, clock, logger } = deps;

  /**
   * Authorises one operation against one user's billing. THE ONLY DOOR.
   *
   * `kind: 'subscription'`, which `platform/authz` grants on OWNERSHIP alone —
   * so for a self-check the ownership rule is trivially true and THE TENANT
   * COMPARISON IS THE ONLY THING THIS FUNCTION DOES. That is exactly the shape
   * that made `parent.authoriseSelf` an unenforced guard (D-125), so the tenant
   * is read from `users` here and the mutation test proves the read is
   * load-bearing.
   *
   * An unknown user resolves to `''`, which the guard treats as "no tenant" and
   * DENIES — routed through the guard rather than short-circuited with a 404,
   * so "no such user" and "a user in another tenant" produce byte-identical
   * output. A distinct 404 would be an account-existence oracle.
   *
   * Returns the tenant that was checked, so anything written afterwards is
   * filed under the tenant the check passed on rather than the claimed one.
   */
  async function authoriseSubscription(
    actor: BillingActor,
    subjectUserId: string,
    action: 'read' | 'write',
  ): Promise<string> {
    const tenantId = (await deps.readTenantOfUser(subjectUserId)) ?? '';
    // The link reader is irrelevant to `kind: 'subscription'` and is wired to
    // deny, so a future rule cannot accidentally reach a link status this
    // module never fetched.
    const guard = createAccessGuard({ readLinkStatus: () => null });
    guard.assertCanAccess(actor, action, {
      kind: 'subscription',
      ownerUserId: subjectUserId,
      tenantId,
    });
    return tenantId;
  }

  /**
   * Whether this rejected delivery may still write an audit row — D-258.
   *
   * TRUE means "spend one and audit"; FALSE means "we are being flooded, keep
   * the log line and skip the durable write".
   *
   * A `RateLimitError` is the ONLY thing treated as "no budget". Anything else
   * — a cache outage that the limiter's own in-process fallback could not
   * absorb, say — propagates, becomes a 5xx and makes the provider retry, which
   * is §8.8 rule 4. Swallowing it would mean a broken limiter silently reverted
   * to unlimited auditing, which is the defect this function exists to close.
   */
  async function rejectionBudgetAvailable(): Promise<boolean> {
    try {
      await deps.rateLimiter.consume(
        WEBHOOK_REJECTION_RATE_LIMIT_KEY,
        WEBHOOK_REJECTION_RATE_LIMIT,
      );
      return true;
    } catch (error) {
      if (error instanceof RateLimitError) return false;
      throw error;
    }
  }

  /** The stored row for a beneficiary, plus the entitlements it currently grants. */
  async function readState(
    subjectUserId: string,
  ): Promise<{ subscription: SubscriptionRecord | null; entitlements: Entitlements }> {
    const subscription = await repository.findLatestForSubject(subjectUserId);
    if (subscription === null) {
      return { subscription: null, entitlements: freeEntitlements() };
    }
    return {
      subscription,
      entitlements: resolveEntitlements({
        subscription: {
          status: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelledAt: subscription.cancelledAt,
          planCode: subscription.planCode,
        },
        now: clock.now(),
      }),
    };
  }

  return {
    /**
     * §8.8 — CREATE A SUBSCRIPTION.
     *
     * THE ROW IS WRITTEN `pending` AND GRANTS NOTHING. Access begins when a
     * signed webhook says money arrived — "never grant plan access without
     * verified payment" is structural here rather than remembered, because
     * `createSubscription` has no code path that writes any other status.
     *
     * The local row is written BEFORE the provider is called. That ordering
     * costs an orphan `pending` row when the provider then fails, and buys the
     * thing that actually matters: a crash between "charge created at Razorpay"
     * and "row written here" would otherwise leave money moving against a
     * subscription we have no record of and no webhook can reconcile. An orphan
     * pending row is a support ticket; an unreconcilable charge is a refund and
     * a lost customer.
     */
    async createSubscription(
      actor: BillingActor,
      planCode: string,
    ): Promise<{ subscription: SubscriptionRecord; checkoutUrl: string }> {
      // Billing yourself is a WRITE. `platform/authz` grants `subscription` on
      // ownership for either action, but naming the action honestly is what
      // keeps the day somebody adds a support-agent rule from silently letting
      // an agent start a charge on a parent's card.
      const tenantId = await authoriseSubscription(actor, actor.userId, 'write');

      /**
       * `findPlan`, NOT `planOrFree`. A misspelt plan code must fail, never
       * silently sell the free plan — that takes somebody's money for nothing.
       * The entitlement path deliberately does the opposite.
       */
      const plan = findPlan(planCode);
      if (!plan?.purchasable) {
        throw new ValidationError('That plan is not available.', {
          message: `billing.createSubscription: plan "${planCode}" is unknown or not purchasable`,
        });
      }

      const existing = await repository.findLiveForSubject(actor.userId);
      if (existing !== null) {
        // A 409 rather than a second row. `subscriptions_one_live_idx` would
        // refuse it anyway; catching it here turns a constraint violation into
        // an answer the client can render.
        throw new ConflictError('There is already a subscription for this account.', {
          message: 'billing.createSubscription: a live subscription already exists',
        });
      }

      /**
       * WHO PAYS — resolved, never assumed. See `PayerResolver`.
       *
       * Null means nobody can be billed for this beneficiary (a school seat
       * with no school). Refused rather than falling back to charging the
       * actor, which is the exact assumption this module exists not to make.
       */
      const payer = await deps.resolvePayer(actor.userId, actor);
      if (payer === null) {
        throw new ValidationError('No payer is configured for this account.', {
          message: 'billing.createSubscription: the payer resolver returned null',
        });
      }

      const now = clock.now();
      const subscription = await repository.createSubscription({
        subjectUserId: actor.userId,
        payerKind: payer.kind,
        payerUserId: payer.kind === 'user' ? payer.id : null,
        payerSchoolId: payer.kind === 'school' ? payer.id : null,
        planCode: plan.code,
        // WHICH PROVIDER, from the port itself rather than from a constant
        // here. See `PaymentsPort.name`: a row written under one name and
        // reconciled under another is simply not found, and the symptom is a
        // payment that arrives and grants nothing.
        provider: deps.payments.name,
        providerSubscriptionId: null,
        amountMinorUnits: plan.amountMinorUnits,
        currency: plan.currency,
        tenantId,
        now,
      });

      const created = await deps.payments.createSubscription({
        planCode: plan.code,
        payer,
        subjectUserId: actor.userId,
        amountMinorUnits: plan.amountMinorUnits,
        currency: plan.currency,
        // OUR id as the key. A retry anywhere — a proxy, an operator, a client
        // double-tap — collapses at the provider instead of opening a second
        // subscription. Nothing retries this call in the first place (§4).
        idempotencyKey: subscription.id,
      });

      await repository.attachProviderId(subscription.id, created.providerSubscriptionId, now);

      await deps.audit.record({
        actor: { userId: actor.userId, role: actor.role, tenantId: actor.tenantId },
        action: BILLING_AUDIT_ACTIONS.SUBSCRIPTION_CREATED,
        resourceType: AUDIT_RESOURCES.USER,
        resourceId: actor.userId,
        // IDENTIFIERS AND AMOUNTS ONLY. Never a card, never a name, never an
        // email — a record OF a payment must not itself become payment data.
        metadata: {
          planCode: plan.code,
          payerKind: payer.kind,
          amountMinorUnits: plan.amountMinorUnits,
        },
      });

      // COUNTS AND CODES ONLY. No user id, no provider id, no checkout url —
      // a checkout url in a log is a payment page anybody with log access can
      // complete.
      logger.info(
        { event: 'billing.subscription_created', planCode: plan.code, payerKind: payer.kind },
        'a subscription was created and is awaiting payment',
      );

      return {
        subscription: { ...subscription, providerSubscriptionId: created.providerSubscriptionId },
        checkoutUrl: created.checkoutUrl,
      };
    },

    /**
     * §8.8 — THE WEBHOOK. Rules 1-4, in order, annotated inline.
     *
     * NO ACTOR. There is nothing to authorise against except the signature, so
     * `assertCanAccess` is deliberately absent — and its absence is why every
     * other line here is written defensively.
     */
    async handleWebhook(delivery: WebhookDelivery): Promise<WebhookOutcome> {
      // =====================================================================
      // RULE 1: VERIFY THE SIGNATURE BEFORE PARSING ANYTHING.
      //
      // This is the first statement of the method. Nothing above it reads,
      // parses, logs or branches on the body. Until this returns non-null the
      // bytes are attacker-controlled input, and a JSON parser is a large
      // surface to point at unauthenticated bytes.
      // =====================================================================
      const verified = deps.payments.verifyWebhook(delivery);
      if (verified === null) {
        /**
         * D-258 — THE BUDGET IS SPENT HERE AND NOWHERE ELSE.
         *
         * After the signature has failed, so a genuine delivery never reaches
         * this line and can never be throttled by an attacker's volume; and
         * BEFORE the audit write, because the audit write is the resource being
         * protected. On a constant key, because every key the request carries is
         * chosen by the caller. See `WEBHOOK_REJECTION_RATE_LIMIT`.
         */
        if (await rejectionBudgetAvailable()) {
          // A REJECTION IS AUDITED, because it is the one signal that somebody
          // is probing the endpoint. Metadata only: the body is
          // attacker-controlled and echoing it into an audit row is how log
          // injection starts.
          await deps.audit.record({
            actor: { userId: null, role: null, tenantId: null },
            action: BILLING_AUDIT_ACTIONS.WEBHOOK_REJECTED,
            resourceType: AUDIT_RESOURCES.USER,
            resourceId: null,
            metadata: { bodyBytes: delivery.rawBody.length },
          });
        }
        // OUTSIDE the budget check, deliberately. Suppressing the durable row
        // must not also suppress the signal — a log line is bounded by the log
        // pipeline, an append-only table is not, and "we stopped auditing
        // because we are being flooded" is itself the thing an operator needs
        // to see.
        logger.warn(
          { event: 'billing.webhook_rejected' },
          'a webhook was rejected: the signature did not verify',
        );
        // THE RESPONSE IS UNCHANGED whether the budget was available or not.
        // A different outcome under load would tell an attacker they had found
        // the threshold, and would tell the provider something untrue.
        return { result: 'rejected' };
      }

      const now = clock.now();

      // =====================================================================
      // RULES 2 AND 3 SHARE ONE TRANSACTION. That sharing IS rule 3: the event
      // row and the subscription update land together or neither does.
      //
      // Nothing below is wrapped in a try/catch. Rule 4: a failure must reach
      // the error handler, become a 5xx, and be retried by the provider — and
      // rule 2 is what makes that retry a no-op rather than a double
      // application.
      // =====================================================================
      return repository.withTransaction(async (tx: TransactionToken): Promise<WebhookOutcome> => {
        /**
         * The lookup precedes the insert, and the ORDER IS DELIBERATE even
         * though §8.8 lists the insert first.
         *
         * The event row carries `subscription_id` and `tenant_id`, and both
         * come from the subscription — D-084's "resolve the tenant from the
         * row" rather than leaning on a column default. So the row has to be
         * read before the event can be written completely.
         *
         * What rule 2 actually requires is that the INSERT is the thing that
         * detects a duplicate and that NOTHING IS MUTATED before it. Both hold:
         * the only statement before the insert is a `SELECT … FOR UPDATE`,
         * which changes nothing and additionally serialises concurrent
         * deliveries for this subscription.
         */
        const subscription =
          verified.providerSubscriptionId === null
            ? null
            : await repository.lockByProviderId(
                tx,
                // Looked up by the provider that issued it: the unique key is
                // (provider, provider_subscription_id), because two providers
                // could legitimately mint the same id string.
                deps.payments.name,
                verified.providerSubscriptionId,
              );

        // ===================================================================
        // RULE 2: THE DEDUPLICATION. `ON CONFLICT DO NOTHING` — the check and
        // the write are one statement, so two concurrent deliveries of the
        // same event cannot both pass. A duplicate answers 200 and STOPS: the
        // subscription is not touched, because it was already updated the
        // first time.
        // ===================================================================
        const inserted = await repository.insertPaymentEvent(tx, {
          // The provider that SIGNED this delivery — known even when nothing
          // matched, which is exactly the case worth being able to query.
          provider: deps.payments.name,
          providerEventId: verified.providerEventId,
          kind: verified.kind,
          providerEventName: verified.providerEventName,
          subscriptionId: subscription?.id ?? null,
          payload: asObject(verified.payload),
          // NULL when nothing matched. An event that matches no subscription
          // genuinely has no tenant, and filling it from the default would file
          // cross-tenant noise under whichever tenant happens to be first.
          tenantId: subscription?.tenantId ?? null,
          now,
        });

        if (!inserted) {
          logger.info(
            { event: 'billing.webhook_duplicate', kind: verified.kind },
            'a webhook was already processed; nothing was applied',
          );
          return { result: 'duplicate' };
        }

        if (subscription === null) {
          /**
           * RECORDED AND NOT ACTED ON — and NOT an error.
           *
           * An event for a subscription id we have never seen is the signal
           * that our records and the provider's have diverged; the row is the
           * only evidence of it. Raising a 5xx would make the provider retry a
           * message that can never succeed, forever.
           */
          logger.warn(
            { event: 'billing.webhook_unmatched', kind: verified.kind },
            'a verified webhook referenced a subscription this system does not hold',
          );
          return { result: 'processed', changed: false };
        }

        const plan = findPlan(subscription.planCode);
        const transition = applyPaymentEvent(
          {
            status: subscription.status,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelledAt: subscription.cancelledAt,
          },
          {
            kind: verified.kind,
            currentPeriodEnd: verified.currentPeriodEnd,
            now,
            periodDays: plan?.periodDays ?? 0,
          },
        );

        if (transition === null) {
          // A deliberate no-change: an unimplemented event type, or one that
          // cannot move a terminal subscription. The event row still exists, so
          // the history is complete.
          return { result: 'processed', changed: false };
        }

        // ===================================================================
        // RULE 3: THE SAME TRANSACTION as the event row above. A status change
        // and its payment record are atomic; there is no arrangement of
        // failures that produces one without the other.
        // ===================================================================
        await repository.updateSubscriptionState(tx, subscription.id, {
          status: transition.status,
          currentPeriodEnd: transition.currentPeriodEnd,
          cancelledAt: transition.cancelledAt,
          now,
        });

        logger.info(
          { event: 'billing.webhook_applied', kind: verified.kind, status: transition.status },
          'a payment event moved a subscription',
        );
        return { result: 'processed', changed: true };
      });
    },

    /**
     * §8.8 — ENTITLEMENTS, READ AT REQUEST TIME.
     *
     * Nothing here is cached and nothing may be. The reasoning is the same as
     * parent-child link revocation (§7 rule 3): a permission that lives on a
     * session survives its own revocation until the user logs out. A halted
     * subscription, a cancelled card and a lapsed period must all take effect
     * on the very next request.
     */
    async getEntitlements(actor: BillingActor, subjectUserId: string): Promise<Entitlements> {
      await authoriseSubscription(actor, subjectUserId, 'read');
      const { entitlements } = await readState(subjectUserId);
      return entitlements;
    },

    /**
     * §8.8 — CANCEL.
     *
     * ACCESS CONTINUES TO `current_period_end`. They paid for the period;
     * revoking it at the moment of cancellation is theft dressed as a state
     * machine — and it is also what makes people cancel on day one rather than
     * day twenty-eight.
     *
     * The provider is told FIRST. If that call fails the local row is
     * unchanged, so the user sees an error and can retry; the reverse ordering
     * would show "cancelled" while the card kept being charged, which is the
     * one billing bug that turns into a chargeback.
     */
    async cancelSubscription(
      actor: BillingActor,
      subjectUserId: string,
    ): Promise<SubscriptionRecord> {
      await authoriseSubscription(actor, subjectUserId, 'write');

      const subscription = await repository.findLiveForSubject(subjectUserId);
      if (subscription === null) {
        // A 404 here is safe and is NOT the enumeration oracle `parent` guards
        // against: the guard above has already confirmed the caller owns this
        // account, so the only fact disclosed is one about themselves.
        throw new NotFoundError('There is no active subscription to cancel.', {
          message: 'billing.cancelSubscription: no live subscription',
        });
      }

      if (subscription.providerSubscriptionId !== null) {
        await deps.payments.cancelSubscription(subscription.providerSubscriptionId);
      }

      const now = clock.now();
      // Cancelling something that never activated ends it now — there is no
      // paid period to honour, and the database CHECK refuses a terminal row
      // with a null period end.
      const accessUntil = subscription.currentPeriodEnd ?? now;
      const status: SubscriptionStatus = 'cancelled';

      await repository.withTransaction((tx) =>
        repository.updateSubscriptionState(tx, subscription.id, {
          status,
          currentPeriodEnd: accessUntil,
          cancelledAt: subscription.cancelledAt ?? now,
          now,
        }),
      );

      await deps.audit.record({
        actor: { userId: actor.userId, role: actor.role, tenantId: actor.tenantId },
        action: BILLING_AUDIT_ACTIONS.SUBSCRIPTION_CANCELLED,
        resourceType: AUDIT_RESOURCES.USER,
        resourceId: subjectUserId,
        metadata: { planCode: subscription.planCode, payerKind: subscription.payer.kind },
      });

      return {
        ...subscription,
        status,
        currentPeriodEnd: accessUntil,
        cancelledAt: subscription.cancelledAt ?? now,
      };
    },

    /**
     * §8.8 — STATUS AND ENTITLEMENTS TOGETHER, from one row at one instant.
     *
     * Two endpoints would let a client hold a status from one moment and
     * entitlements from another, and the disagreement shows up as a paid
     * feature flickering on and off.
     *
     * The status reported is the EFFECTIVE one: a stored `active` whose period
     * ended yesterday is reported `expired`, because that is what it is.
     */
    async getSubscriptionStatus(
      actor: BillingActor,
      subjectUserId: string,
    ): Promise<BillingStatusResponse> {
      await authoriseSubscription(actor, subjectUserId, 'read');
      const { subscription, entitlements } = await readState(subjectUserId);

      if (subscription === null) return { subscription: null, entitlements };

      return {
        subscription: {
          id: subscription.id,
          planCode: subscription.planCode,
          status: effectiveStatus(subscription, clock.now()),
          payer: { kind: subscription.payer.kind },
          currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
          cancelledAt: subscription.cancelledAt?.toISOString() ?? null,
        },
        entitlements,
      };
    },
  };
}

/**
 * `payment_events.payload` is `jsonb` with a CHECK that it is an OBJECT.
 *
 * A provider that sent a bare array or a scalar would otherwise fail the CHECK
 * and turn into a 5xx retried forever. Wrapping it keeps the evidence and keeps
 * the constraint honest — the value is preserved under `value`, so nothing is
 * discarded.
 */
function asObject(payload: unknown): Record<string, unknown> {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { value: payload };
}
