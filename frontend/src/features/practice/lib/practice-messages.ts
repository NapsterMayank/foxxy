import { treatmentFor, type ApiError } from '@/lib/api/errors';
import { ERROR_CODES } from '@/lib/api/generated/error-codes';
import type { TranslationKey, Translator } from '@/lib/i18n/translate';

/**
 * ===========================================================================
 * ERRORS → COPY, for practice. §5.6's "NEVER render a server message".
 *
 * ---------------------------------------------------------------------------
 * A 409 IS THE ONE THAT NEEDED THINKING ABOUT, and it means two different
 * things on two different requests.
 *
 * On `POST /answers` it is D-281 refusing a SECOND answer to a question already
 * answered — the thing that used to make a session answered entirely wrong
 * score 100%. On `POST /submit` it is a session already submitted, refused
 * rather than awarded twice.
 *
 * Both are the student's own screen having got ahead of the server — a double
 * tap, a stale tab — and neither is a fault they can fix by retrying. So each
 * gets a sentence that says what already happened, chosen by the CALLER, which
 * is the only thing that knows which request it made.
 * ===========================================================================
 */
export function practiceErrorMessage(
  error: ApiError,
  t: Translator,
  options: { readonly conflict?: TranslationKey; readonly fallback?: TranslationKey } = {},
): string {
  if (error.code === ERROR_CODES.CONFLICT) {
    return t(options.conflict ?? 'practice.errorConflict');
  }

  const treatment = treatmentFor(error);

  switch (treatment.kind) {
    case 'rate-limited':
      return treatment.retryAfterSeconds === null
        ? t('practice.errorRateLimited')
        : t('practice.errorRateLimitedSeconds', { seconds: treatment.retryAfterSeconds });

    case 'degraded':
      return t('practice.errorDegraded');

    case 'not-found':
      return t('practice.errorSessionGone');

    /*
     * A 400 here is a CONTRACT DRIFT, not a typo: the request was built from
     * the generated schema and parsed by it before leaving. There is nothing
     * for the student to correct, so it reads as generic rather than pointing
     * at a control.
     */
    case 'field-errors':
    case 'action-blocked':
    case 'no-access':
    case 'session-expired':
    case 'verify-email':
    case 'retry':
    case 'generic':
      return t(options.fallback ?? 'practice.errorGeneric');

    default: {
      const unreachable: never = treatment;
      throw new Error(`Unhandled treatment: ${String(unreachable)}`);
    }
  }
}

/**
 * Why an attempt was ruled invalid.
 *
 * ---------------------------------------------------------------------------
 * THE BACKEND'S REASON CODE IS NEVER RENDERED, AND AN UNKNOWN ONE STILL SAYS
 * SOMETHING.
 *
 * `invalidReason` is a `string` on the wire, not an enum — `ANTI_CHEAT_REASONS`
 * lives in the practice module and is not on the contract — so this table
 * cannot be exhaustive and must not pretend to be. A code it does not know
 * falls back to the general sentence, because §10.4 requires that "an invalid
 * attempt shows its reason" and showing a raw `too_fast_average` to a child is
 * not showing a reason.
 *
 * The tone is deliberate throughout. An invalid attempt is not an accusation;
 * it is XP withheld with an explanation of what to do differently.
 */
const invalidReasonKeys: Readonly<Record<string, TranslationKey>> = {
  // `ANTI_CHEAT_REASONS` as of 14 August, copied by hand because the union is
  // not on the wire. `response_count_mismatch` gets the general sentence
  // deliberately: it means the session and its answers disagree, which is a
  // defect on one side or the other and never something a student did.
  too_fast: 'practice.invalidTooFast',
  all_same_answer: 'practice.invalidSameAnswer',
};

export function invalidReasonMessage(reason: string | null, t: Translator): string {
  if (reason === null) return '';
  return t(invalidReasonKeys[reason] ?? 'practice.invalidGeneric');
}
