'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { ApiError } from '@/lib/api/errors';
import type {
  BillingStatusResponse,
  CancelResponse,
  SubscribeRequest,
  SubscribeResponse,
} from '@/lib/api/generated/contracts/billing.contract';
import type { TolerantPlanCatalogue } from '../api/billing-requests';
import { billingKeys, foxyKeys, practiceKeys } from '@/lib/api/query-keys';
import {
  cancelSubscription,
  getBillingStatus,
  getPlans,
  subscribe,
} from '../api/billing-requests';

/**
 * ===========================================================================
 * BILLING DATA — build-order step 13.
 * ===========================================================================
 */

/**
 * The catalogue.
 *
 * `staleTime: Infinity`. Prices do not change while somebody is looking at
 * them, and a refetch on window focus that moved a figure mid-purchase would be
 * the worst possible moment to update it.
 */
export function usePlans(): UseQueryResult<TolerantPlanCatalogue, ApiError> {
  return useQuery<TolerantPlanCatalogue, ApiError>({
    queryKey: billingKeys.plans(),
    queryFn: getPlans,
    staleTime: Infinity,
  });
}

export function useBillingStatus(): UseQueryResult<BillingStatusResponse, ApiError> {
  return useQuery<BillingStatusResponse, ApiError>({
    queryKey: billingKeys.status(),
    queryFn: getBillingStatus,
  });
}

/**
 * Starting a checkout.
 *
 * ---------------------------------------------------------------------------
 * IT INVALIDATES NOTHING ON SUCCESS, AND THAT IS THE POINT.
 *
 * A 201 here creates a subscription in `pending`, WHICH GRANTS NOTHING — the
 * route says so. The grant arrives later, by webhook, after the provider
 * confirms payment. Invalidating entitlements at this moment would refetch a
 * status that has not changed and invite the screen to look as though something
 * had been bought, seconds before the customer has even reached the payment
 * page.
 */
export function useSubscribe(): UseMutationResult<SubscribeResponse, ApiError, SubscribeRequest> {
  return useMutation<SubscribeResponse, ApiError, SubscribeRequest>({ mutationFn: subscribe });
}

/**
 * Cancelling.
 *
 * This one DOES invalidate, and widely: the status row changed, and so did
 * every cap derived from it. `foxy.capabilities` carries the daily message
 * allowance and `practice.progress` carries the XP cap, both resolved per
 * request from the entitlement — so a screen holding either would keep offering
 * a paid allowance the account no longer has.
 *
 * Access does NOT end here, though. `accessUntil` is what was paid for, and the
 * screen says so rather than implying the plan stopped the moment the button
 * was pressed.
 */
export function useCancelSubscription(): UseMutationResult<CancelResponse, ApiError, void> {
  const queryClient = useQueryClient();

  return useMutation<CancelResponse, ApiError, void>({
    mutationFn: cancelSubscription,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: billingKeys.status() });
      void queryClient.invalidateQueries({ queryKey: foxyKeys.capabilities() });
      void queryClient.invalidateQueries({ queryKey: practiceKeys.progress() });
    },
  });
}
