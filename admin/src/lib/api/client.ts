import type { ZodType } from 'zod';
import { apiBaseUrl, apiVersionPrefix } from '@/lib/config/env';

/**
 * =============================================================================
 * THE ADMIN CLIENT — deliberately NOT a copy of `frontend/src/lib/api/client.ts`.
 *
 * That one carries SSE coordination for Foxy's stream, abort-versus-failure
 * semantics, and a 401 contract with `SessionProvider`. None of it applies
 * here: this app has no streaming endpoint, no optimistic UI and no provider to
 * coordinate with. Copying two hundred lines to use forty of them would create
 * exactly the drift a shared file is supposed to prevent, in the direction
 * nobody notices — the copy stops being updated.
 *
 * What it keeps, because these are true of every request in every app:
 *
 *   1. `credentials: 'include'`. The session cookie is host-bound to the API.
 *      Omit it and the request is anonymous, which presents as "randomly
 *      logged out" because it only affects the calls somebody forgot.
 *   2. The response is VALIDATED against the backend's own Zod contract, so a
 *      backend change surfaces at the boundary rather than three components
 *      deep.
 *   3. A non-2xx becomes a typed error carrying the backend's code.
 *
 * -----------------------------------------------------------------------------
 * 404 IS THE INTERESTING STATUS ON THIS SURFACE.
 *
 * The admin gate answers 404 to anyone who is not a `super_admin` — a 403 would
 * confirm the route exists. So a 404 here means one of two things that look
 * identical on the wire: the resource is genuinely absent, or the caller is not
 * an operator. `ApiError.status` is preserved so a screen can say "not found or
 * not permitted" rather than guessing, which is the honest rendering of a
 * deliberately ambiguous answer.
 * =============================================================================
 */

export type ApiMethod = 'GET' | 'POST';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /**
   * True when the server declined to say whether this exists.
   *
   * See the header: on `/admin` a 404 is "absent, or you are not an operator",
   * and a screen that rendered it as plain "not found" would be asserting the
   * first without evidence.
   */
  get isAbsentOrForbidden(): boolean {
    return this.status === 404;
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown };
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'UNKNOWN';
  let message = `Request failed with status ${String(response.status)}`;
  try {
    const payload = (await response.json()) as ErrorBody;
    if (typeof payload.error?.code === 'string') code = payload.error.code;
    if (typeof payload.error?.message === 'string') message = payload.error.message;
  } catch {
    /* A proxy's HTML page or an empty body. The defaults above stand. */
  }
  return new ApiError(response.status, code, message);
}

export interface AdminRequest<T> {
  readonly path: string;
  readonly schema: ZodType<T>;
  readonly method?: ApiMethod;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export async function adminRequest<T>(request: AdminRequest<T>): Promise<T> {
  const method = request.method ?? 'GET';
  const url = `${apiBaseUrl}${apiVersionPrefix}${request.path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'include',
      headers: request.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      cache: 'no-store',
    });
  } catch (cause) {
    // An abort is re-thrown unchanged — a cancelled request must not render as
    // a failed one.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'UNKNOWN', 'The network request failed.');
  }

  if (!response.ok) throw await toApiError(response);

  const payload: unknown = response.status === 204 ? null : await response.json();
  const parsed = request.schema.safeParse(payload);
  if (!parsed.success) {
    /*
     * A 2xx whose SHAPE is wrong. Loud on purpose: the alternative is the value
     * flowing on as `undefined` and failing somewhere with no connection to its
     * cause. On a panel read during an incident, a screen that renders blank
     * for an unrelated reason is worse than one that says what broke.
     */
    throw new ApiError(response.status, 'CONTRACT_MISMATCH', `${request.path} did not match its contract.`);
  }
  return parsed.data;
}
