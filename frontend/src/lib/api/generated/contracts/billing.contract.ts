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
