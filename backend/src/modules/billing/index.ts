import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { createNoopAudit, type AuditPort } from '@/platform/audit/index';
import type { Clock } from '@/platform/clock/index';
import type { Logger } from '@/platform/logger/index';
import type { PaymentsPort } from '@/platform/payments/index';
import type { RateLimiter } from '@/platform/rate-limit/index';
import { createBillingRepository, type BillingDbHandle } from './billing.repository';
import { registerBillingRoutes } from './billing.routes';
import { createBillingService, type BillingService } from './billing.service';
import type { PayerResolver, TenantReader } from './billing.types';

/**
 * ============================================================================
 * billing — THE PUBLIC SURFACE.
 *
 * This is the only file another module may import (00-ARCHITECTURE.md,
 * Foundation 1, enforced by ESLint `no-restricted-imports`). Everything else in
 * this directory is private.
 *
 * Owns: `subscriptions`, `payment_events`, the plan catalogue and entitlement
 * resolution (plan §8.8). Calls no other module — the account tenant and the
 * payer both arrive as injected functions, so every cross-module edge lives in
 * `app/routes.ts` and nowhere else.
 * ============================================================================
 *
 * THE FIVE THINGS ABOUT THIS MODULE MOST LIKELY TO BE UNDONE BY ACCIDENT.
 *
 * 1. THE PAYER IS NOT THE BENEFICIARY. `subscriptions` carries `subject_user_id`
 *    (whose entitlements) and a payer (`user` or `school`) as INDEPENDENT
 *    facts, and a database CHECK makes any other combination unrepresentable.
 *    It is unresolved whether the product ships B2C or as a B2B school pilot;
 *    collapsing the two into one `user_id` would answer that question by
 *    accident and unanswering it later is a migration across live financial
 *    rows. `PayerResolver` is the one line that decides, and it is supplied at
 *    the composition root.
 *
 * 2. THE SIGNATURE IS VERIFIED BEFORE ANYTHING IS PARSED. It is the first
 *    statement of `handleWebhook`, and the webhook route receives a RAW body in
 *    an encapsulated Fastify scope so that nothing can parse it first. This is
 *    the compensating control for the CSRF exemption — the endpoint is
 *    unauthenticated, and the HMAC is the only thing standing on it.
 *
 * 3. THE EVENT ROW AND THE STATUS CHANGE ARE ONE TRANSACTION. `ON CONFLICT DO
 *    NOTHING` on `(provider, provider_event_id)` is the replay defence, and it
 *    is a single statement rather than a read-then-write because two concurrent
 *    deliveries both pass a read-then-write. A failure returns 5xx and the
 *    provider retries; the retry is a no-op because of the same constraint.
 *
 * 4. ENTITLEMENTS ARE READ AT REQUEST TIME AND NEVER CACHED IN THE SESSION.
 *    Identical reasoning to parent-child link revocation (§7 rule 3): a
 *    permission on a session survives its own revocation until logout. Expiry
 *    is COMPUTED against the injected clock, not swept by a job — a stored
 *    `active` whose period ended yesterday reports `expired`.
 *
 * 5. AN ENTITLEMENT IS A POSITIVE GRANT. The free tier is a real feature list,
 *    not "whatever was not denied". A bug that loses the grant therefore grants
 *    NOTHING, which is loud, rather than granting the free tier, which is
 *    silent — and which would keep giving away any feature that later became
 *    paid.
 */

export interface BillingModuleDeps {
  /** §3.1: billing is ordinary request traffic and gets the `core` pool. */
  readonly db: BillingDbHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Identity's session validator, passed in rather than imported. */
  readonly requireSession: preHandlerAsyncHookHandler;
  /** Already guarded at the composition root. Never a bare adapter. */
  readonly payments: PaymentsPort;
  /** `users.tenant_id`, read from the DATA and never off the actor (D-091). */
  readonly readTenantOfUser: TenantReader;
  /** WHO PAYS. The B2C/B2B seam — see `PayerResolver` in `billing.types.ts`. */
  readonly resolvePayer: PayerResolver;
  /**
   * Subscription creation, cancellation and rejected webhooks are audited.
   *
   * Defaults to the no-op so existing harnesses keep working; `app/routes.ts`
   * always supplies the real one and a test asserts that it does.
   */
  readonly audit?: AuditPort;
  /**
   * The counters behind the webhook's REJECTION BUDGET — D-258.
   *
   * The limiter is built at the composition root, from `platform/rate-limit`,
   * for the same reason `payments` and `audit` are: this module holds the
   * POLICY (which key, which rule, which branch spends it) and platform holds
   * the mechanism. Handing the built limiter in also keeps the fallback metric
   * name a deployment concern rather than a module constant.
   *
   * REQUIRED. An optional limiter with a permissive default would restore the
   * defect — an unauthenticated endpoint writing durable audit rows at whatever
   * rate the caller chooses — and would do it silently.
   */
  readonly rateLimiter: RateLimiter;
}

export interface BillingModule {
  readonly service: BillingService;
  /**
   * Registers the three `/billing/…` endpoints plus the webhook, under
   * `/api/v1`.
   *
   * ASYNC, unlike every other module's — the webhook needs its own
   * encapsulated Fastify scope for the raw-body parser, and `app.register`
   * returns a promise. `app/routes.ts` must `await` it, exactly as it already
   * awaits identity's.
   */
  registerRoutes(app: FastifyInstance): Promise<void>;
}

export function createBillingModule(deps: BillingModuleDeps): BillingModule {
  const service = createBillingService({
    repository: createBillingRepository(deps.db),
    payments: deps.payments,
    clock: deps.clock,
    logger: deps.logger,
    readTenantOfUser: deps.readTenantOfUser,
    resolvePayer: deps.resolvePayer,
    audit: deps.audit ?? createNoopAudit(),
    rateLimiter: deps.rateLimiter,
  });

  return {
    service,
    registerRoutes(app: FastifyInstance): Promise<void> {
      return registerBillingRoutes(app, { service, requireSession: deps.requireSession });
    },
  };
}

/**
 * ---------------------------------------------------------------------------
 * The use-cases, as named in §8.8.
 *
 *   createSubscription     Starts a checkout. Writes a `pending` row that
 *                          grants NOTHING and calls the provider. Access
 *                          begins when a verified webhook says money arrived.
 *   handleWebhook          Signature first, dedupe insert second, subscription
 *                          update third — all four rules, in order. No actor.
 *   getEntitlements        What this user may do RIGHT NOW. Never cached.
 *   cancelSubscription     Stops the renewal; access runs to the paid period's
 *                          end. The provider is told first.
 *   getSubscriptionStatus  The effective status and the entitlements, read from
 *                          one row at one instant.
 * ---------------------------------------------------------------------------
 */
export type { BillingService } from './billing.service';
export {
  BILLING_AUDIT_ACTIONS,
  WEBHOOK_REJECTION_RATE_LIMIT,
  WEBHOOK_REJECTION_RATE_LIMIT_KEY,
} from './billing.service';
export { BILLING_WEBHOOK_PATH } from './billing.routes';

/**
 * THE ENTITLEMENT SURFACE OTHER MODULES USE.
 *
 * `hasFeature(entitlements, 'foxy.unlimited')` is the ONLY shape a caller
 * should write. A call site that reads `entitlements.planCode === 'pro'`
 * hardcodes the catalogue in a place nobody edits when the catalogue changes.
 */
export { freeEntitlements, hasFeature, resolveEntitlements } from './domain/entitlements';
export {
  FREE_PLAN,
  FREE_PLAN_CODE,
  PLANS,
  findPlan,
  planOrFree,
  purchasablePlans,
} from './domain/plans';
export type { Plan } from './domain/plans';

/** The state machine, exported so the worker and tests can reason about it. */
export { applyPaymentEvent, effectiveStatus } from './domain/subscription-status';
export type {
  PaymentEventFacts,
  StatusTransition,
  SubscriptionState,
} from './domain/subscription-status';

/** The injected-dependency shapes `app/routes.ts` has to satisfy. */
export type {
  BillingActor,
  Payer,
  PayerKind,
  PayerResolver,
  SubscriptionRecord,
  TenantReader,
  WebhookOutcome,
} from './billing.types';
