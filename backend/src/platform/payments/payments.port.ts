/**
 * platform/payments — the payment-gateway port. INTERFACE ONLY at this build
 * step; the Razorpay adapter lands with build step 13.
 *
 * `verifyWebhook` takes the RAW body, not a parsed object. The signature must
 * be verified before anything is parsed — an unverified webhook is
 * attacker-controlled input (§8.8, rule 1).
 */
export interface CreateSubscriptionRequest {
  readonly planCode: string;
  readonly userId: string;
}

export interface CreatedSubscription {
  readonly providerSubscriptionId: string;
  /** Where the browser is sent to complete payment. */
  readonly checkoutUrl: string;
}

export interface VerifiedWebhook {
  readonly providerEventId: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface PaymentsPort {
  createSubscription(req: CreateSubscriptionRequest): Promise<CreatedSubscription>;
  /** Returns null when the signature does not verify. Never throws on a
   *  forged signature — the caller answers 400 and logs it. */
  verifyWebhook(rawBody: string, signature: string): VerifiedWebhook | null;
}
