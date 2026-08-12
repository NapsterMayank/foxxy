import type { ZodIssue } from 'zod';
import { treatmentFor, type ApiError } from '@/lib/api/errors';
import type { TranslationKey, Translator } from '@/lib/i18n/translate';

/**
 * ===========================================================================
 * ERRORS → COPY, for the auth screens.
 *
 * Two functions, and neither of them ever renders a server string. §5.6 is
 * explicit: "NEVER render a server message to a user". The backend's messages
 * are `safeMessage` — safe to LOG, written for an operator, and untranslated.
 * ===========================================================================
 */

/**
 * A field's message, chosen from the Zod issue rather than from its text.
 *
 * The mapping is (field, issue kind) → key, so `too_small` on a password says
 * "use at least 10 characters" while `too_small` on an email says "enter a
 * valid email address" — which is what a person can act on, and what a shared
 * generic message could never be.
 */
export function authFieldMessage(field: string, issue: ZodIssue, t: Translator): string {
  // An absent value fails as a type error before any rule about its content
  // runs, and "fill this in" beats "enter a valid email address" for a field
  // the person simply has not reached yet.
  if (issue.code === 'invalid_type') return t('auth.errorRequired');

  switch (field) {
    case 'email':
      return t('auth.errorEmailInvalid');

    case 'password':
      return issue.code === 'too_big'
        ? t('auth.errorPasswordTooLong')
        : t('auth.errorPasswordTooShort');

    case 'token':
      return t('auth.verifyMissingToken');

    default:
      return t('auth.errorRequired');
  }
}

/**
 * The form-level message for a failed request.
 *
 * ---------------------------------------------------------------------------
 * THE LOGIN EXCEPTION IS THE WHOLE REASON THIS FUNCTION EXISTS.
 *
 * A wrong password is 401 UNAUTHENTICATED, which §5.6 maps to `session-expired`
 * — correct for every OTHER call in the product and wrong here, where there is
 * no session to expire and the person is one field away from fixing it. The
 * table is not wrong; it describes authenticated requests. The sign-in request
 * is the one call that can legitimately be rejected as a verdict on what was
 * typed, so the caller says so with `credentialVerdict`.
 */
export function authFormMessage(
  error: ApiError,
  t: Translator,
  options: { readonly credentialVerdict?: boolean } = {},
): string {
  const treatment = treatmentFor(error);

  switch (treatment.kind) {
    case 'session-expired':
      return options.credentialVerdict === true
        ? t('auth.errorInvalidCredentials')
        : t('auth.errorGeneric');

    case 'verify-email':
      return t('auth.verifyNeeded');

    case 'rate-limited':
      return treatment.retryAfterSeconds === null
        ? t('auth.errorRateLimited')
        : t('auth.errorRateLimitedSeconds', { seconds: treatment.retryAfterSeconds });

    case 'degraded':
      return t('auth.errorDegraded');

    case 'action-blocked':
      return t('auth.errorBlocked');

    /*
     * A 400 THAT SURVIVED CLIENT VALIDATION IS NOT A TYPO. The generated schema
     * already accepted this input, and it is the backend's own schema, so a
     * rejection means the two have drifted — a defect. There is no field to
     * point at and nothing the person can retype, so it reads as generic.
     *
     * `not-found` joins it for the recovery links: a consumed or expired reset
     * token is the only way an auth screen meets one, and "this link has
     * expired" is the sentence that actually helps.
     */
    case 'not-found':
      return t('auth.errorLinkInvalid');

    case 'field-errors':
    case 'no-access':
    case 'retry':
    case 'generic':
      return t('auth.errorGeneric');

    default: {
      /*
       * THE EXHAUSTIVENESS CHECK, AS AN ASSIGNMENT RATHER THAN A CALL.
       *
       * `treatment` is `never` here only while every kind above is handled, so
       * adding one to `ErrorTreatment` fails the build at this line — the same
       * guarantee `errors.ts` gives its own table. Written as an assignment
       * because a helper function would be a function no test can reach, and an
       * unreachable function drags the area below its coverage floor for a
       * branch whose whole purpose is to be impossible.
       */
      const unreachable: never = treatment;
      throw new Error(`Unhandled treatment: ${String(unreachable)}`);
    }
  }
}

/** The success line each kind of auth request shows when it resolves. */
export const authSuccessKeys = {
  signup: 'auth.signupSuccess',
  forgotPassword: 'auth.forgotSent',
  resetPassword: 'auth.resetSuccess',
  resendVerification: 'auth.resendSent',
} as const satisfies Readonly<Record<string, TranslationKey>>;
