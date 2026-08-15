import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { ERROR_CODES } from '@/lib/api/generated/error-codes';
import { createTranslator } from '@/lib/i18n/translate';
import { billingErrorMessage } from '../lib/billing-messages';

const t = createTranslator('en');

function error(init: Partial<ConstructorParameters<typeof ApiError>[0]> = {}): ApiError {
  return new ApiError({
    status: 500,
    code: 'UNKNOWN',
    message: 'operator sentence, never rendered',
    method: 'POST',
    ...init,
  });
}

describe('billing error copy', () => {
  it('never renders the backend message', () => {
    expect(billingErrorMessage(error(), t)).not.toContain('operator sentence');
  });

  /*
   * THE ONE THAT COSTS MONEY IF IT IS WORDED CARELESSLY. A 409 means the
   * customer ALREADY HAS what they were trying to buy — a second tab, or a back
   * button after a completed checkout. "Try again" would send them back into a
   * payment they have already made.
   */
  it('tells a customer with a live plan that they already have it', () => {
    const message = billingErrorMessage(error({ status: 409, code: ERROR_CODES.CONFLICT }), t);

    expect(message).toBe('You already have an active plan. Reload this page to see it.');
    expect(message).not.toContain('Try again');
  });

  /*
   * The plan code came from the SERVED catalogue, so a 400 means the plan was
   * retired between the page loading and the button being pressed. Reloading is
   * the actual fix.
   */
  it('reads a rejected plan code as a retired plan, not as a typo', () => {
    const message = billingErrorMessage(error({ status: 400, code: ERROR_CODES.VALIDATION }), t);

    expect(message).toContain('no longer available');
  });

  /*
   * "Something went wrong" makes a customer wonder whether they were charged.
   * Naming the payment service and saying to try again shortly does not.
   */
  it('names the payment service when it is the payment service', () => {
    const message = billingErrorMessage(error({ status: 503, code: ERROR_CODES.DEPENDENCY }), t);

    expect(message).toBe('The payment service is unavailable right now. Try again shortly.');
  });

  it('says there is nothing to change when there is no subscription', () => {
    expect(billingErrorMessage(error({ status: 404, code: ERROR_CODES.NOT_FOUND }), t)).toBe(
      'There is no plan to change.',
    );
  });

  it('names the wait when the backend gave one', () => {
    expect(
      billingErrorMessage(error({ status: 429, code: ERROR_CODES.RATE_LIMIT, retryAfterSeconds: 15 }), t),
    ).toContain('15');
  });

  it('waits without a number when the header was absent', () => {
    expect(billingErrorMessage(error({ status: 429, code: ERROR_CODES.RATE_LIMIT }), t)).toBe(
      'Too many attempts. Wait a moment and try again.',
    );
  });

  it('reads a refused state change as a stale page', () => {
    expect(billingErrorMessage(error({ status: 403, code: ERROR_CODES.FORBIDDEN }), t)).toBe(
      'That request was refused. Reload the page and try again.',
    );
  });

  it('reads a 403 on a GET as generic rather than as a refused action', () => {
    expect(
      billingErrorMessage(error({ status: 403, code: ERROR_CODES.FORBIDDEN, method: 'GET' }), t),
    ).toBe('Something went wrong. Try again.');
  });

  it('renders rather than throwing on an expiring session', () => {
    expect(billingErrorMessage(error({ status: 401, code: ERROR_CODES.UNAUTHENTICATED }), t)).toBe(
      'Something went wrong. Try again.',
    );
  });

  /* A failed checkout must say that nothing was charged. */
  it('uses the caller’s sentence for a failed checkout', () => {
    const message = billingErrorMessage(error(), t, { fallback: 'billing.errorCheckoutFailed' });

    expect(message).toContain('Nothing has been charged.');
  });
});
