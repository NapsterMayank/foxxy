'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { apiRequest } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { currentUserResponseSchema } from '@/lib/api/generated/contracts/identity.contract';
import type { UserProfile } from '@/lib/api/generated/contracts/identity.contract';
import { sessionKeys } from '@/lib/api/query-keys';
import { onUnauthenticated } from './session-events';

/**
 * ===========================================================================
 * SESSION STATE — 02-FRONTEND-IMPLEMENTATION-PLAN.md §5.5. Build-order step 0.
 *
 * The session is an httpOnly cookie, so THE FRONTEND CANNOT READ IT. Everything
 * here follows from that one fact.
 *
 * ONE bootstrap query — `GET /api/v1/auth/me` — is the only way the product
 * asks "am I signed in, and as whom". No component calls that endpoint; they
 * read this context. Two callers would be two answers, and the visible symptom
 * of two answers is auth flicker on every page load.
 *
 * ---------------------------------------------------------------------------
 * `loading` RENDERS A SKELETON AND NEVER A REDIRECT.
 *
 * §5.5 calls redirecting during bootstrap "the single most common bug in
 * cookie-session applications", and it is: the first render has no answer yet,
 * a redirect on "not yet authenticated" logs out every user on every refresh,
 * and it looks like a session bug rather than a rendering one. `status` has
 * three values for exactly this reason — `unauthenticated` is an ANSWER, not
 * the absence of one.
 *
 * ---------------------------------------------------------------------------
 * A 401 ANYWHERE CLEARS THE QUERY CACHE.
 *
 * Not tidiness. On a shared family device the next person to sign in would
 * otherwise see the previous user's cached profile, practice history and parent
 * digest — rendered from cache before their own first request returns. §5.5
 * requires the clear in the same sentence as the redirect, and both live in
 * `expire` below.
 * ===========================================================================
 */

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface SessionState {
  readonly status: SessionStatus;
  /** Present exactly when `status` is `authenticated`. */
  readonly user: UserProfile | null;
  /** Ends the session locally and sends the browser to login. Idempotent. */
  readonly expire: () => void;
}

const SessionContext = createContext<SessionState | null>(null);

/** Where an expired session lands, carrying where it came from. */
export const LOGIN_PATH = '/login';

function fetchCurrentUser(signal: AbortSignal): Promise<{ user: UserProfile }> {
  return apiRequest({
    path: '/auth/me',
    schema: currentUserResponseSchema,
    signal,
  });
}

export function SessionProvider({ children }: Readonly<{ children: ReactNode }>) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();

  const query = useQuery({
    queryKey: sessionKeys.currentUser,
    queryFn: ({ signal }) => fetchCurrentUser(signal),
    /*
     * A 401 IS AN ANSWER, NOT A FAILURE. Retrying it delays the login redirect
     * by the whole backoff schedule and hammers the auth pool with requests
     * whose outcome is already known. Anything else — a 502, a dropped
     * connection — is worth one retry, because the alternative is signing
     * somebody out because a load balancer blinked.
     */
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 401) && failureCount < 1,
    // The cookie can be revoked server-side (logout-all, a password reset), and
    // the only way to notice is to ask again on focus.
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  const expire = useCallback(() => {
    /*
     * ORDER MATTERS. The cache is cleared BEFORE the navigation: `router` may
     * render the login route synchronously, and a cache still holding the
     * previous user's data would be read by anything mounted underneath it.
     */
    queryClient.clear();

    const next = pathname === null || pathname === LOGIN_PATH ? null : pathname;
    const target =
      next === null ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
    router.replace(target);
  }, [pathname, queryClient, router]);

  /*
   * Any 401, from any request in the application. See `session-events.ts` for
   * why this arrives as a published fact rather than a direct call.
   */
  useEffect(() => onUnauthenticated(expire), [expire]);

  const value = useMemo<SessionState>(() => {
    if (query.isPending) return { status: 'loading', user: null, expire };
    if (query.isError || query.data === undefined) {
      return { status: 'unauthenticated', user: null, expire };
    }
    return { status: 'authenticated', user: query.data.user, expire };
  }, [expire, query.data, query.isError, query.isPending]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * Throws outside the provider rather than returning a default.
 *
 * A default would make an unwrapped subtree look `unauthenticated` — which is
 * indistinguishable from a real signed-out user, and would send a signed-in
 * person to login because of a missing provider three levels up.
 */
export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession must be used inside <SessionProvider>.');
  }
  return value;
}
