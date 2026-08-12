import { ERROR_CODES, type ErrorCode } from './generated/error-codes';

/**
 * ===========================================================================
 * THE ERROR TREATMENT TABLE — 02-FRONTEND-IMPLEMENTATION-PLAN.md §5.6.
 * Build-order step 0.
 *
 * Every backend error code has EXACTLY ONE treatment, decided here rather than
 * improvised per screen. Improvised is the default outcome: twelve screens each
 * decide what a 403 means, four of them decide it means "logged out", and a
 * parent gets signed out for clicking a button they were not permitted to press.
 *
 * The switch is EXHAUSTIVE over `ErrorCode`, which is generated from the
 * backend's own union. A code the backend adds and this file does not handle is
 * a TYPE ERROR at build time — see `assertNever` at the foot.
 * ===========================================================================
 */

/**
 * What the UI does. Deliberately a behaviour name, not a copy string: the copy
 * comes from the dictionary and differs per screen, the behaviour does not.
 */
export type ErrorTreatment =
  /** Clear session and query cache, redirect to login with `?next=`. */
  | { readonly kind: 'session-expired' }
  /**
   * A 403 on a state-changing request. MAY BE A CSRF ORIGIN REJECTION RATHER
   * THAN AN EXPIRED SESSION — the backend deliberately returns 403 before 401
   * on those, because the CSRF verdict must not depend on who the caller claims
   * to be. Treating it as a logout signs out a user whose session is fine.
   */
  | { readonly kind: 'action-blocked' }
  /** A 403 on a GET. Show a no-access state that reveals nothing about what exists. */
  | { readonly kind: 'no-access' }
  /** Correct password, unverified address. Offer to resend, do not say "login failed". */
  | { readonly kind: 'verify-email' }
  /** Expected and retryable — e.g. two link codes minted concurrently. */
  | { readonly kind: 'retry' }
  /** Show the wait and disable the trigger. NEVER retry automatically. */
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number | null }
  /** Name what is unavailable and what still works — resilience plan §6. */
  | { readonly kind: 'degraded' }
  /** Map onto the form. Never a page-level error. */
  | { readonly kind: 'field-errors' }
  /** The thing genuinely is not there. */
  | { readonly kind: 'not-found' }
  /** Generic state with retry. NEVER render a server message to a user. */
  | { readonly kind: 'generic' };

/** HTTP methods that change state, for the 403 fork above. */
const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A failed API call, carrying the backend's machine-readable code.
 *
 * `message` is NEVER rendered. It is the backend's `safeMessage` — safe to log,
 * not written for this screen, and not translated. Screens read `treatment` and
 * supply their own copy from the dictionary.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'UNKNOWN';
  /** The narrower reason the backend attaches where a specific recovery exists. */
  readonly reason: 'EMAIL_NOT_VERIFIED' | null;
  /** The request method, which the 403 fork depends on. */
  readonly method: string;
  readonly retryAfterSeconds: number | null;
  /**
   * The path BELOW the version prefix, e.g. `/auth/login`.
   *
   * Carried for exactly one reason, and it is not diagnostics: a 401 from
   * `POST /auth/login` is A CREDENTIAL VERDICT ABOUT A SESSION THAT NEVER
   * EXISTED, and every other 401 in the product is a session that has ended.
   * `providers.tsx` routes the second kind into `notifyUnauthenticated()` and
   * has nothing else to tell them apart by — status and code are identical.
   * Without this, entering a wrong password clears the query cache and reports
   * itself as an expired session.
   */
  readonly path: string;

  constructor(init: {
    status: number;
    code: ErrorCode | 'UNKNOWN';
    message: string;
    method: string;
    path?: string;
    reason?: 'EMAIL_NOT_VERIFIED' | null;
    retryAfterSeconds?: number | null;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.method = init.method.toUpperCase();
    this.path = init.path ?? '';
    this.reason = init.reason ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * The whole table, in one function.
 *
 * `reason` is checked BEFORE `code`: an unverified-email rejection arrives as a
 * 403 FORBIDDEN with a `reason`, and reading the code first would render it as
 * "you may not do that" on the one screen where the user is one click from
 * fixing it themselves.
 */
export function treatmentFor(error: ApiError): ErrorTreatment {
  if (error.reason === 'EMAIL_NOT_VERIFIED') return { kind: 'verify-email' };

  switch (error.code) {
    case ERROR_CODES.UNAUTHENTICATED:
      return { kind: 'session-expired' };

    case ERROR_CODES.FORBIDDEN:
      // See `ErrorTreatment.action-blocked`. The method is the only thing that
      // distinguishes a CSRF rejection from a genuine permission refusal.
      return UNSAFE_METHODS.has(error.method) ? { kind: 'action-blocked' } : { kind: 'no-access' };

    case ERROR_CODES.VALIDATION:
      return { kind: 'field-errors' };

    case ERROR_CODES.NOT_FOUND:
      return { kind: 'not-found' };

    case ERROR_CODES.CONFLICT:
      return { kind: 'retry' };

    case ERROR_CODES.RATE_LIMIT:
      return { kind: 'rate-limited', retryAfterSeconds: error.retryAfterSeconds };

    case ERROR_CODES.DEPENDENCY:
      return { kind: 'degraded' };

    case ERROR_CODES.INTERNAL:
      return { kind: 'generic' };

    /*
     * A transport failure, a proxy's own error page, or a code this build has
     * never heard of. Deliberately NOT part of the exhaustive switch: `UNKNOWN`
     * is the frontend's own value, and folding it into `ErrorCode` would let a
     * genuinely unhandled backend code pass the compiler.
     */
    case 'UNKNOWN':
      return { kind: 'generic' };

    default:
      return assertNever(error.code);
  }
}

/**
 * THE GATE. When the backend adds a code, `error.code` stops being `never`
 * here and the build fails — which is the entire point of generating the union
 * from the backend rather than writing it out (§5.6).
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled error code: ${String(value)}`);
}
