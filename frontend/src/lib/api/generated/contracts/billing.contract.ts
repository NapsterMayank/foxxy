/**
 * GENERATED — DO NOT EDIT.
 *
 * Source of truth: backend/src/shared/. Regenerate with
 * `npm run contracts:sync` from `frontend/`. `contracts-drift.test.ts`
 * fails when this file and its backend original disagree.
 */

import { z } from 'zod';

/**
 * ============================================================================
 * THE BILLING CONTRACT — plan §8.8.
 *
 * Shared with the frontend, which imports the INFERRED TYPES rather than
 * redeclaring them. One definition, two consumers; a route and its client
 * cannot drift apart without the compiler noticing.
 *
 * ============================================================================
 * NOTHING IN THIS FILE SAYS "A PARENT PAYS".
 *
 * The product may ship B2C (a parent subscribes) or as a B2B school pilot
 * (schools pay; per-parent subscriptions never exist). That is unresolved, so
 * the wire format carries a PAYER as a discriminated `{ kind, id }` pair and
 * never as a bare user id — and `payer` is deliberately NOT accepted on the
 * subscribe REQUEST. The client asks for a plan; the server decides who is
 * billed, from configuration and from the actor's school. A client-supplied
 * payer would be a client choosing who to charge.
 * ============================================================================
 */

/** Which entitlements exist. A closed set — the client renders from it. */
export const ENTITLEMENT_FEATURES = [
  'practice.basic',
  'practice.unlimited',
  'foxy.basic',
  'foxy.unlimited',
  'parent.digest',
] as const;

export const entitlementFeatureSchema = z.enum(ENTITLEMENT_FEATURES);
export type EntitlementFeature = z.infer<typeof entitlementFeatureSchema>;

export const subscriptionStatusSchema = z.enum([
  'pending',
  'active',
  'past_due',
  'cancelled',
  'expired',
]);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const payerKindSchema = z.enum(['user', 'school']);
export type PayerKind = z.infer<typeof payerKindSchema>;

/**
 * POST /api/v1/billing/subscribe
 *
 * A plan code and nothing else. See the header: the payer is resolved on the
 * server.
 */
export const subscribeRequestSchema = z.object({
  planCode: z.string().min(1).max(40),
});
export type SubscribeRequest = z.infer<typeof subscribeRequestSchema>;

export const subscribeResponseSchema = z.object({
  subscriptionId: z.string().uuid(),
  status: subscriptionStatusSchema,
  planCode: z.string(),
  /** Where the browser is sent to pay. */
  checkoutUrl: z.string(),
  /**
   * WHO IS BEING BILLED, echoed back so a school-paid seat renders honestly.
   *
   * A student on a school plan must not be shown "you will be charged ₹299";
   * without this field the client has no way to tell the two cases apart and
   * would have to guess from the role, which is the assumption this whole
   * design exists to avoid.
   */
  payer: z.object({ kind: payerKindSchema }),
});
export type SubscribeResponse = z.infer<typeof subscribeResponseSchema>;

/**
 * GET /api/v1/billing/status
 *
 * Status AND entitlements in one response, deliberately. They are read from the
 * same row at the same instant; two endpoints would let a client hold a status
 * from one moment and entitlements from another, and the disagreement would
 * surface as a paid feature flickering.
 */
export const entitlementsSchema = z.object({
  planCode: z.string(),
  /** True only while a paid grant is live. Never inferred from the plan alone. */
  isPaid: z.boolean(),
  /**
   * THE POSITIVE GRANT. A feature is available because it appears here, never
   * because nothing denied it — see the resolver's header. The free tier is a
   * real grant with real members, not an empty list.
   */
  features: z.array(entitlementFeatureSchema),
  /** When the current grant lapses. Null on the free tier, which never does. */
  activeUntil: z.string().datetime().nullable(),
});
export type Entitlements = z.infer<typeof entitlementsSchema>;

export const subscriptionSummarySchema = z.object({
  id: z.string().uuid(),
  planCode: z.string(),
  status: subscriptionStatusSchema,
  payer: z.object({ kind: payerKindSchema }),
  currentPeriodEnd: z.string().datetime().nullable(),
  cancelledAt: z.string().datetime().nullable(),
});
export type SubscriptionSummary = z.infer<typeof subscriptionSummarySchema>;

export const billingStatusResponseSchema = z.object({
  /** Null when this user has never subscribed. Not an error — it is the norm. */
  subscription: subscriptionSummarySchema.nullable(),
  entitlements: entitlementsSchema,
});
export type BillingStatusResponse = z.infer<typeof billingStatusResponseSchema>;

/** POST /api/v1/billing/cancel */
export const cancelResponseSchema = z.object({
  subscriptionId: z.string().uuid(),
  status: subscriptionStatusSchema,
  /** Access continues until here. They paid for the period. */
  accessUntil: z.string().datetime().nullable(),
});
export type CancelResponse = z.infer<typeof cancelResponseSchema>;

/**
 * POST /api/v1/webhooks/billing
 *
 * THE ONLY THING THE PROVIDER IS EVER TOLD is `{ received: true }`, and only
 * after the event has been durably recorded. No id, no status, no reason —
 * every deny and every duplicate look identical, because the caller is
 * unauthenticated by definition and a descriptive body would be a free oracle
 * for probing which subscription ids exist.
 */
export const webhookResponseSchema = z.object({ received: z.boolean() });
export type WebhookResponse = z.infer<typeof webhookResponseSchema>;

/**
 * GET /api/v1/billing/plans
 *
 * ===========================================================================
 * THE CATALOGUE IS SERVED BECAUSE A PRICE IS NOT A CLIENT'S TO KNOW.
 *
 * `PLANS` lives in `modules/billing/domain/plans.ts`, which the frontend cannot
 * import — so before this endpoint existed a billing screen had exactly two
 * options: hard-code "₹299 / month", or show nothing. The first is the reason
 * this route exists.
 *
 * A hard-coded price is not the same class of defect as a hard-coded button.
 * `GET /foxy/capabilities` is served so a client cannot offer an action the
 * server does not implement — a broken button. A client with its own copy of a
 * PRICE eventually advertises one figure and charges another, which is a
 * consumer-protection problem and a chargeback, not a UI bug. The checkout path
 * reads `findPlan` from this same table, so the number quoted and the number
 * charged cannot drift.
 *
 * `amountMinorUnits` — PAISE, not rupees, and an integer. Money in a float is
 * how ₹299.00 becomes ₹298.99999999999994; the client divides by 100 once, at
 * the point of display, and never stores the result.
 *
 * `free` IS ABSENT. The route serves `purchasablePlans()`, and the free tier is
 * `purchasable: false` — it is what somebody already has, not something to buy.
 * ===========================================================================
 */
export const planSummarySchema = z.object({
  code: z.string(),
  /** PAISE. Integer. See the header. */
  amountMinorUnits: z.number().int().min(0),
  currency: z.string(),
  periodDays: z.number().int().min(1),
  /** What the plan grants, so a screen can say what is being bought. */
  features: z.array(entitlementFeatureSchema),
});
export type PlanSummary = z.infer<typeof planSummarySchema>;

export const planCatalogueResponseSchema = z.object({
  plans: z.array(planSummarySchema),
});
export type PlanCatalogueResponse = z.infer<typeof planCatalogueResponseSchema>;
