import { z } from 'zod';
import { apiRequest } from '@/lib/api/client';
import {
  billingStatusResponseSchema,
  cancelResponseSchema,
  planCatalogueResponseSchema,
  planSummarySchema,
  subscribeRequestSchema,
  subscribeResponseSchema,
  type BillingStatusResponse,
  type CancelResponse,
  type SubscribeRequest,
  type SubscribeResponse,
} from '@/lib/api/generated/contracts/billing.contract';
import { billingPaths } from '@/lib/api/paths';

/**
 * ===========================================================================
 * THE BILLING WIRE CALLS — build-order step 13.
 *
 * ---------------------------------------------------------------------------
 * THE SUBSCRIBE REQUEST IS A PLAN CODE AND NOTHING ELSE.
 *
 * There is no `payer` field on the contract and this layer must never grow one:
 * "a client choosing who to charge is a client choosing whose card to use". The
 * server resolves the payer from configuration and from the actor's school, and
 * echoes the KIND back so a school-paid seat renders honestly.
 *
 * There is no subject either. Every one of these resolves the user from the
 * session, so there is no field a caller could set to subscribe somebody else.
 * ===========================================================================
 */

/**
 * ===========================================================================
 * THE CATALOGUE IS PARSED WITH A DELIBERATELY LOOSER `features` ARRAY.
 *
 * `planSummarySchema.features` is `z.array(entitlementFeatureSchema)` — a
 * closed enum — and validating the catalogue against it makes ONE unknown
 * feature reject the WHOLE RESPONSE. The pricing page then renders "plans could
 * not be loaded", and the cause is the backend having added an entitlement.
 * Found by a test that fed it `school.reporting`.
 *
 * That is the failure §7's frame parser already refuses for Foxy, in as many
 * words: an additive backend change must not become an outage for everyone who
 * has not reloaded. It matters more here — a client that cannot render the
 * catalogue cannot sell anything.
 *
 * So the FEATURE LIST is read as strings and `PlanCard` drops the ones it has
 * no words for. Everything that decides money — `amountMinorUnits`, `currency`,
 * `periodDays`, `code` — stays on the generated schema and stays strict, which
 * is the half that must never be lenient.
 * ===========================================================================
 */
const tolerantPlanCatalogueSchema = planCatalogueResponseSchema.extend({
  plans: z.array(planSummarySchema.extend({ features: z.array(z.string()) })),
});

export type TolerantPlanCatalogue = z.infer<typeof tolerantPlanCatalogueSchema>;
export type TolerantPlanSummary = TolerantPlanCatalogue['plans'][number];

/** The plans a customer may buy, and what each costs. Never a local copy. */
export function getPlans(): Promise<TolerantPlanCatalogue> {
  return apiRequest({ path: billingPaths.plans, schema: tolerantPlanCatalogueSchema });
}

export function getBillingStatus(): Promise<BillingStatusResponse> {
  return apiRequest({ path: billingPaths.status, schema: billingStatusResponseSchema });
}

export function subscribe(input: SubscribeRequest): Promise<SubscribeResponse> {
  return apiRequest({
    path: billingPaths.subscribe,
    method: 'POST',
    body: subscribeRequestSchema.parse(input),
    schema: subscribeResponseSchema,
  });
}

export function cancelSubscription(): Promise<CancelResponse> {
  return apiRequest({ path: billingPaths.cancel, method: 'POST', schema: cancelResponseSchema });
}
