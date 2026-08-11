import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../generated/error-codes';
import { ApiError, treatmentFor } from '../errors';

/**
 * THE ERROR TREATMENT TABLE — plan §5.6.
 *
 * Every row of that table is a test here, because the table is only real if it
 * is enforced somewhere. Two rows carry a decision that is wrong in the obvious
 * direction and are asserted first: a 403 on a POST is NOT a logout, and an
 * abstention is NOT an error (asserted in the streaming tests, where it lives).
 */

function apiError(init: {
  status: number;
  code: string;
  method?: string;
  reason?: 'EMAIL_NOT_VERIFIED';
  retryAfterSeconds?: number;
}): ApiError {
  return new ApiError({
    status: init.status,
    code: init.code as never,
    message: 'safe message',
    method: init.method ?? 'GET',
    ...(init.reason === undefined ? {} : { reason: init.reason }),
    ...(init.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: init.retryAfterSeconds }),
  });
}

describe('the 403 fork — the row most likely to be got wrong', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'treats a 403 on a %s as a blocked action, never a logout',
    (method) => {
      /*
       * The backend returns 403 BEFORE 401 on state-changing requests, because
       * the CSRF verdict must not depend on who the caller claims to be. A
       * client that reads this as an expired session signs out a user whose
       * session is perfectly valid — on a request that was refused for an
       * entirely different reason.
       */
      expect(treatmentFor(apiError({ status: 403, code: ERROR_CODES.FORBIDDEN, method }))).toEqual({
        kind: 'action-blocked',
      });
    },
  );

  it('treats a 403 on a GET as no-access', () => {
    expect(treatmentFor(apiError({ status: 403, code: ERROR_CODES.FORBIDDEN }))).toEqual({
      kind: 'no-access',
    });
  });
});

describe('the reason field outranks the code', () => {
  it('offers verification rather than a permission error', () => {
    // An unverified login arrives as a 403 carrying `reason`. Read code-first
    // it renders as "you may not do that", on the one screen where the user is
    // a single click from fixing it themselves.
    expect(
      treatmentFor(
        apiError({
          status: 403,
          code: ERROR_CODES.FORBIDDEN,
          method: 'POST',
          reason: 'EMAIL_NOT_VERIFIED',
        }),
      ),
    ).toEqual({ kind: 'verify-email' });
  });
});

describe('every remaining code has exactly one treatment', () => {
  it.each([
    [ERROR_CODES.UNAUTHENTICATED, 'session-expired'],
    [ERROR_CODES.VALIDATION, 'field-errors'],
    [ERROR_CODES.NOT_FOUND, 'not-found'],
    [ERROR_CODES.CONFLICT, 'retry'],
    [ERROR_CODES.DEPENDENCY, 'degraded'],
    [ERROR_CODES.INTERNAL, 'generic'],
  ])('%s maps to %s', (code, kind) => {
    expect(treatmentFor(apiError({ status: 400, code })).kind).toBe(kind);
  });

  it('carries the wait through on a rate limit, and never retries', () => {
    expect(
      treatmentFor(
        apiError({ status: 429, code: ERROR_CODES.RATE_LIMIT, retryAfterSeconds: 42 }),
      ),
    ).toEqual({ kind: 'rate-limited', retryAfterSeconds: 42 });
  });

  it('degrades a code it has never heard of to a generic state', () => {
    // A proxy's own error page, or a backend code from a newer deployment than
    // this bundle. Generic, never a crash.
    expect(treatmentFor(apiError({ status: 500, code: 'UNKNOWN' })).kind).toBe('generic');
  });
});

describe('the codes the frontend handles are the codes the backend defines', () => {
  it('has a treatment for every generated code', () => {
    /*
     * The compile-time gate is `assertNever` in `errors.ts`. This is its
     * runtime companion: a generated code with no case would fall through to
     * `assertNever` and throw, so iterating the real union proves the switch is
     * total against the backend's list rather than against a list written here.
     */
    for (const code of Object.values(ERROR_CODES)) {
      expect(() => treatmentFor(apiError({ status: 400, code }))).not.toThrow();
    }
  });
});
