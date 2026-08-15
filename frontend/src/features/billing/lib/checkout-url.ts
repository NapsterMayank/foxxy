/**
 * ===========================================================================
 * THE ONE PLACE THIS PRODUCT SENDS A BROWSER SOMEWHERE IT DOES NOT CONTROL.
 *
 * `checkoutUrl` is a `z.string()` on the contract — not `z.string().url()` —
 * so the schema alone does not establish that it is safe to navigate to. Every
 * other external link in the product is a constant; this one arrives at
 * runtime, and it is followed with the customer's payment intent behind it.
 *
 * ---------------------------------------------------------------------------
 * ONLY `http:` AND `https:` ARE FOLLOWED.
 *
 * The value comes from our own server, so this is defence in depth rather than
 * a hole being closed — but the cost of the check is one function and the cost
 * of being wrong is a `javascript:` URL executing in the session of somebody
 * who just pressed a button labelled "pay". A provider response the backend
 * passed through, a misconfigured `RAZORPAY_PLAN_IDS`, or a future adapter that
 * builds this string differently are all ordinary ways for a non-http value to
 * arrive.
 *
 * Anything else is refused and the caller shows a failure. Silently doing
 * nothing would leave somebody pressing "pay" with no response at all.
 * ===========================================================================
 */
export function isFollowableCheckoutUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Not absolute. A relative checkout URL is meaningless — the payment page
    // is never on this origin — so it is a defect rather than something to
    // resolve against the current location.
    return false;
  }

  return parsed.protocol === 'https:' || parsed.protocol === 'http:';
}
