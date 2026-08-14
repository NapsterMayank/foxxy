import { apiRequest } from '@/lib/api/client';
import {
  startFoxySessionRequestSchema,
  type FoxyCapabilitiesResponse,
  type FoxySessionListResponse,
  type FoxySessionResponse,
  type StartFoxySessionRequest,
} from '@/lib/api/generated/contracts/foxy.contract';
import { foxyPaths } from '@/lib/api/paths';
import {
  foxyCapabilitiesResponseSchema,
  foxySessionListResponseSchema,
  foxySessionResponseSchema,
} from './foxy-responses';

/**
 * ===========================================================================
 * THE FOXY WIRE CALLS — build-order step 9.
 *
 * FOUR OF THE FIVE ENDPOINTS. The fifth — `POST /sessions/:id/messages` — is
 * absent by design: it is the SSE turn, and it belongs to `useFoxyStream`,
 * which reads a body rather than parsing one. Putting a `sendMessage` here that
 * called `apiRequest` would produce a second, buffered way to take a turn, and
 * the buffered one would look correct in every test that uses `app.inject`.
 *
 * The request schema is PARSED on the way out, for the reason `auth-requests`
 * gives: the backend applies the same schema at its own boundary, so an
 * unparsed value is a value the server silently changes.
 * ===========================================================================
 */

export function startFoxySession(input: StartFoxySessionRequest): Promise<FoxySessionResponse> {
  return apiRequest({
    path: foxyPaths.sessions,
    method: 'POST',
    body: startFoxySessionRequestSchema.parse(input),
    schema: foxySessionResponseSchema,
  });
}

/** One conversation and its full transcript. */
export function getFoxySession(sessionId: string): Promise<FoxySessionResponse> {
  return apiRequest({
    path: foxyPaths.session(sessionId),
    schema: foxySessionResponseSchema,
  });
}

export function listFoxySessions(): Promise<FoxySessionListResponse> {
  return apiRequest({ path: foxyPaths.sessions, schema: foxySessionListResponseSchema });
}

/**
 * The modes, the fixed action set and today's remaining allowance.
 *
 * The screen renders BUTTONS FROM THIS RESPONSE and never from a local list.
 * The contract is explicit about why: a client with its own copy eventually
 * shows a button the server does not implement, and that fails at the moment a
 * child presses it.
 */
export function getFoxyCapabilities(): Promise<FoxyCapabilitiesResponse> {
  return apiRequest({ path: foxyPaths.capabilities, schema: foxyCapabilitiesResponseSchema });
}
