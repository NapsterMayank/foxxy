import { describe, expect, it } from 'vitest';
import { isFollowableCheckoutUrl } from '../lib/checkout-url';

/**
 * `checkoutUrl` is a plain `z.string()` on the contract, so the schema does not
 * establish that it is safe to navigate to — and this is the one place the
 * product sends a browser somewhere it does not control, with the customer's
 * payment intent behind it.
 */
describe('the checkout URL', () => {
  it('follows a real payment page', () => {
    expect(isFollowableCheckoutUrl('https://rzp.io/i/abc123')).toBe(true);
    expect(isFollowableCheckoutUrl('http://localhost:4000/fake-checkout/sub_1')).toBe(true);
  });

  /*
   * The cost of the check is one function; the cost of being wrong is a
   * `javascript:` URL executing in the session of somebody who just pressed a
   * button labelled "pay".
   */
  it('refuses a scheme that is not http or https', () => {
    expect(isFollowableCheckoutUrl('javascript:alert(1)')).toBe(false);
    expect(isFollowableCheckoutUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isFollowableCheckoutUrl('file:///etc/passwd')).toBe(false);
  });

  /*
   * A relative checkout URL is meaningless — the payment page is never on this
   * origin — so it is a defect rather than something to resolve against the
   * current location.
   */
  it('refuses anything that is not absolute', () => {
    expect(isFollowableCheckoutUrl('/checkout')).toBe(false);
    expect(isFollowableCheckoutUrl('')).toBe(false);
    expect(isFollowableCheckoutUrl('rzp.io/i/abc123')).toBe(false);
  });
});
