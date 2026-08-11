import type { ZodType } from 'zod';
import { apiBaseUrl, apiVersionPrefix } from '@/lib/config/env';
import { errorResponseSchema } from './generated/contracts/identity.contract';
import { ERROR_CODES, type ErrorCode } from './generated/error-codes';
import { ApiError } from './errors';

/**
 * ===========================================================================
 * THE ONE TYPED CLIENT — 02-FRONTEND-IMPLEMENTATION-PLAN.md §5.2.
 *
 * Every server interaction in the product goes through this function. Not
 * because a wrapper is tidy, but because four things must be true of EVERY
 * request and none of them survives being remembered per call site:
 *
 *   1. `credentials: 'include'`. The session cookie is host-bound to
 *      `api.<domain>` and the app runs on `app.<domain>`. Omit this and the
 *      request is anonymous — which presents as "randomly logged out", because
 *      it only affects the calls somebody forgot.
 *   2. The response is VALIDATED against the backend's own Zod contract. A
 *      backend change that breaks the frontend then surfaces as a clear error
 *      at the boundary, rather than `undefined is not a function` three
 *      components deep, on one screen, for some users.
 *   3. A non-2xx becomes a typed `ApiError` carrying the backend's CODE. §5.6
 *      maps codes to treatments; a client that threw a bare `Error` would make
 *      that table unreachable.
 *   4. JSON in, JSON out, with the content type set. The backend's origin check
 *      refuses state-changing requests from an unrecognised origin, and the
 *      browser supplies `Origin` itself — there is nothing to set here, and
 *      anything this file set would be stripped anyway.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: redirect on a 401. §5.2 words it as
 * "redirects to login on a 401", and the redirect lives in `SessionProvider`
 * instead — a module-scope `window.location` assignment is untestable, fires
 * during server rendering, and cannot clear the query cache, which §5.5 requires
 * in the same breath ("otherwise the next user on a shared device sees the
 * previous one's cached data"). The client throws; the provider reacts.
 * ===========================================================================
 */

export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiRequest<T> {
  /** Path BELOW the version prefix, e.g. `/auth/me`. Leading slash required. */
  readonly path: string;
  readonly method?: ApiMethod;
  /** Serialised as JSON. Omit for a request with no body. */
  readonly body?: unknown;
  /**
   * The contract the response must satisfy. REQUIRED — see point 2 above.
   * For an endpoint with no body, pass a schema for `null` and expect `null`.
   */
  readonly schema: ZodType<T>;
  readonly signal?: AbortSignal;
}

/** Every status that carries no body, per the HTTP spec. */
const BODILESS_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(ERROR_CODES));

function toErrorCode(value: string): ErrorCode | 'UNKNOWN' {
  return KNOWN_CODES.has(value) ? (value as ErrorCode) : 'UNKNOWN';
}

/**
 * `Retry-After` is seconds or an HTTP date. Only the numeric form is read: the
 * date form would need a clock comparison, and the backend sends seconds. A
 * value it cannot read becomes null, and §5.6's rate-limit treatment shows a
 * generic wait rather than a wrong countdown.
 */
function retryAfterFrom(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (raw === null) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Exported because the FOXY STREAM does not go through `apiRequest` — it reads
 * a body rather than parsing one — and its pre-stream rejections must become
 * the same typed errors as everything else. §5.6's table is only worth having
 * if there is one path to it.
 */
export async function toApiError(response: Response, method: ApiMethod): Promise<ApiError> {
  const base = {
    status: response.status,
    method,
    retryAfterSeconds: retryAfterFrom(response.headers),
  };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    /*
     * NOT the backend's envelope — a proxy's HTML error page, an empty body
     * from a dropped upstream, or a gateway timeout. Everything downstream
     * still needs a typed error, so it becomes `UNKNOWN`, which §5.6 treats
     * generically.
     */
    return new ApiError({
      ...base,
      code: 'UNKNOWN',
      message: `Request failed with status ${String(response.status)}`,
    });
  }

  const parsed = errorResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return new ApiError({
      ...base,
      code: 'UNKNOWN',
      message: `Request failed with status ${String(response.status)}`,
    });
  }

  return new ApiError({
    ...base,
    code: toErrorCode(parsed.data.error.code),
    message: parsed.data.error.message,
    reason: parsed.data.error.reason ?? null,
  });
}

export async function apiRequest<T>(request: ApiRequest<T>): Promise<T> {
  const method = request.method ?? 'GET';
  const url = `${apiBaseUrl}${apiVersionPrefix}${request.path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      // See point 1. The single most consequential line in this file.
      credentials: 'include',
      headers: request.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch (cause) {
    /*
     * The network itself failed, or the caller aborted. An abort is re-thrown
     * UNCHANGED: TanStack Query and the streaming client both recognise
     * `AbortError` and must not be handed something else, or a cancelled
     * request renders as a failed one.
     */
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError({
      status: 0,
      code: 'UNKNOWN',
      message: 'The network request failed.',
      method,
    });
  }

  if (!response.ok) throw await toApiError(response, method);

  if (BODILESS_STATUSES.has(response.status)) {
    // Validated anyway, so an endpoint that starts returning a body without
    // saying so does not silently become `null` at every call site.
    return request.schema.parse(null);
  }

  const payload: unknown = await response.json();
  const parsed = request.schema.safeParse(payload);
  if (!parsed.success) {
    /*
     * A 200 whose SHAPE is wrong. This is the case point 2 exists for, and it
     * is deliberately loud: the alternative is the value flowing on as
     * `undefined` and failing somewhere with no connection to the cause.
     */
    throw new ApiError({
      status: response.status,
      code: 'UNKNOWN',
      message: `The response did not match its contract: ${parsed.error.issues
        .map((issue) => issue.path.join('.') || '(root)')
        .join(', ')}`,
      method,
    });
  }

  return parsed.data;
}
