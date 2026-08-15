import { treatmentFor, type ApiError } from '@/lib/api/errors';
import { ERROR_CODES } from '@/lib/api/generated/error-codes';
import type { TranslationKey, Translator } from '@/lib/i18n/translate';

/**
 * ===========================================================================
 * ERRORS → COPY, for billing. §5.6's "NEVER render a server message to a user".
 *
 * ---------------------------------------------------------------------------
 * THE 409 IS THE ONE THAT COSTS MONEY IF IT IS WORDED CARELESSLY.
 *
 * `createSubscription` refuses when "a live subscription already exists". The
 * honest reading is that the customer ALREADY HAS what they were trying to buy
 * — usually a second tab, or a back button after a completed checkout. A
 * generic "something went wrong, try again" invites them to try again, and the
 * thing they are trying again is a payment.
 *
 * ---------------------------------------------------------------------------
 * A 400 IS NOT A TYPO EITHER. The plan code came from the SERVED catalogue, so
 * a rejection means the plan was retired between the page loading and the
 * button being pressed. Reloading is the actual fix, and the sentence says so
 * instead of pointing at a control the customer did not fill in.
 * ===========================================================================
 */
export function billingErrorMessage(
  error: ApiError,
  t: Translator,
  options: { readonly fallback?: TranslationKey } = {},
): string {
  if (error.code === ERROR_CODES.CONFLICT) return t('billing.errorAlreadySubscribed');
  if (error.code === ERROR_CODES.VALIDATION) return t('billing.errorPlanUnavailable');

  const treatment = treatmentFor(error);

  switch (treatment.kind) {
    case 'not-found':
      return t('billing.errorNoSubscription');

    case 'rate-limited':
      return treatment.retryAfterSeconds === null
        ? t('billing.errorRateLimited')
        : t('billing.errorRateLimitedSeconds', { seconds: treatment.retryAfterSeconds });

    /*
     * The payment provider being unreachable. NAMED AS THE PROVIDER rather than
     * as a general fault, because "try again shortly" is the correct advice and
     * "something went wrong" makes a customer wonder whether they were charged.
     */
    case 'degraded':
      return t('billing.errorProviderUnavailable');

    case 'action-blocked':
      return t('billing.errorBlocked');

    case 'no-access':
    case 'session-expired':
    case 'verify-email':
    case 'field-errors':
    case 'retry':
    case 'generic':
      return t(options.fallback ?? 'billing.errorGeneric');

    default: {
      const unreachable: never = treatment;
      throw new Error(`Unhandled treatment: ${String(unreachable)}`);
    }
  }
}
