import { treatmentFor, type ApiError } from '@/lib/api/errors';
import type { Translator } from '@/lib/i18n/translate';

/**
 * ===========================================================================
 * ERRORS → COPY, for the parent dashboard. §5.6's "NEVER render a server
 * message to a user".
 *
 * ---------------------------------------------------------------------------
 * `no-access` IS THE ONE THAT MATTERS HERE, AND IT IS NOT A FAILURE.
 *
 * A 403 on a GET means this parent may not read this child — most often because
 * the child revoked the link, which is a right the product gives the child and
 * the parent cannot override. The sentence therefore explains the STATE rather
 * than reporting a fault, and offers nothing to press: §5.6's own note says a
 * 403 will not become a 200, and a retry button here would invite a parent to
 * hammer a refusal their child chose.
 * ===========================================================================
 */
export function parentErrorMessage(error: ApiError, t: Translator): string {
  const treatment = treatmentFor(error);

  switch (treatment.kind) {
    case 'no-access':
      return t('parentDashboard.errorNoAccess');

    case 'not-found':
      return t('parentDashboard.errorNotFound');

    case 'rate-limited':
      return treatment.retryAfterSeconds === null
        ? t('parentDashboard.errorRateLimited')
        : t('parentDashboard.errorRateLimitedSeconds', { seconds: treatment.retryAfterSeconds });

    case 'degraded':
      return t('parentDashboard.errorDegraded');

    /*
     * `action-blocked` — a 403 on the revoke POST. It is NOT the same as
     * `no-access` above: the backend returns 403 before 401 on state-changing
     * requests because the CSRF verdict must not depend on who the caller
     * claims to be, so this one usually means a stale page rather than a
     * withdrawn permission.
     */
    case 'action-blocked':
      return t('parentDashboard.errorBlocked');

    case 'session-expired':
    case 'verify-email':
    case 'field-errors':
    case 'retry':
    case 'generic':
      return t('parentDashboard.errorGeneric');

    default: {
      const unreachable: never = treatment;
      throw new Error(`Unhandled treatment: ${String(unreachable)}`);
    }
  }
}
