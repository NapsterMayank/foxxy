import { treatmentFor, type ApiError } from '@/lib/api/errors';
import type { TranslationKey, Translator } from '@/lib/i18n/translate';

/**
 * ===========================================================================
 * ERRORS → COPY, for the Foxy screen.
 *
 * Same rule as `auth-messages`: §5.6's "NEVER render a server message to a
 * user". `ApiError.message` is an operator's sentence, untranslated, and on
 * this screen it is worse than elsewhere — the reader is a child.
 *
 * ---------------------------------------------------------------------------
 * THE DAILY CAP IS NOT DETECTED HERE, AND THAT IS DELIBERATE.
 *
 * The backend raises the allowance refusal as a `RateLimitError`, the same
 * class as "you are asking too fast", so at this seam the two are one code with
 * one `retryAfterSeconds`. Guessing between them on the size of that number —
 * "more than an hour means the daily cap" — would be a heuristic that reads a
 * student their wrong ending on the boundary.
 *
 * The screen does not need the guess. `GET /foxy/capabilities` states
 * `usage.remaining` as a fact, so the composer is disabled with the exhausted
 * wording BEFORE a turn is attempted, and anything that still comes back
 * rate-limited genuinely is a pace limit.
 *
 * ---------------------------------------------------------------------------
 * `fallback` EXISTS BECAUSE THE SCREEN HAS TWO REQUESTS THAT CAN FAIL GENERICALLY
 * AND THEY ARE NOT THE SAME EVENT.
 *
 * A failed turn is "the answer stopped"; a failed `POST /foxy/sessions` is "the
 * conversation never opened", and there is no answer to have been interrupted.
 * The default wording of the first, shown for the second, tells a student
 * something did not finish when nothing had started — which is why the caller
 * names the sentence rather than this function guessing from the path.
 * ===========================================================================
 */
export function foxyErrorMessage(
  error: ApiError,
  t: Translator,
  options: { readonly fallback?: TranslationKey } = {},
): string {
  const treatment = treatmentFor(error);
  const fallback = options.fallback ?? 'foxy.errorGeneric';

  switch (treatment.kind) {
    case 'rate-limited':
      return treatment.retryAfterSeconds === null
        ? t('foxy.errorRateLimited')
        : t('foxy.errorRateLimitedSeconds', { seconds: treatment.retryAfterSeconds });

    case 'degraded':
      return t('foxy.errorDegraded');

    /*
     * A refused turn — the safety classifier, or a CSRF origin rejection.
     * "Try rewording it" is the honest instruction for the first and harmless
     * for the second, and the client cannot tell them apart: the backend
     * deliberately does not say which, because a refusal that explains itself
     * is a refusal somebody can work around.
     */
    case 'action-blocked':
      return t('foxy.errorBlocked');

    case 'not-found':
      return t('foxy.errorNotFound');

    /*
     * `session-expired` IS HANDLED AND STILL RENDERS GENERIC COPY. It is not
     * dead: `providers.tsx` owns the redirect for a 401, and this string is
     * what the screen shows for the frame or two before the route changes. A
     * `session-expired` case that threw would crash the screen on the way out.
     */
    case 'session-expired':
    case 'verify-email':
    case 'no-access':
    case 'field-errors':
    case 'retry':
    case 'generic':
      return t(fallback);

    default: {
      // Exhaustive over `ErrorTreatment`, as an assignment. See the identical
      // note in `auth-messages.ts` for why it is not a helper call.
      const unreachable: never = treatment;
      throw new Error(`Unhandled treatment: ${String(unreachable)}`);
    }
  }
}
