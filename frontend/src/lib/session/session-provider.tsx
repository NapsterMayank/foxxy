'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
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

/**
 * Routes where being signed out is the NORMAL state.
 *
 * A 401 from the bootstrap on the login page is the expected answer, not an
 * expiry, and redirecting to login from login is at best a wasted navigation.
 * Listed rather than inferred from the route group, because the route group is
 * a build-time fact and this runs in the browser.
 */
const PUBLIC_PATHS: readonly string[] = [
  '/',
  '/login',
  '/signup',
  '/verify',
  '/forgot-password',
  '/reset-password',
];

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

  /**
   * ==========================================================================
   * THE LOOP GUARD, AND WHY IT IS NOT OPTIONAL.
   *
   * `expire` used to call `queryClient.clear()`, which removes the BOOTSTRAP
   * QUERY ITSELF. That query has a live observer — this component — so removing
   * it makes TanStack Query refetch immediately, the refetch 401s, the 401
   * publishes again, and the whole thing runs until the tab is closed. A
   * browser test caught it doing exactly that: thirty-odd `/auth/me` requests
   * and a login page that never painted, because every navigation was
   * superseded by the next one.
   *
   * The jsdom test did not catch it — it asserted "fetched once" and settled
   * before the second cycle. That is the difference between a fake router and a
   * real one, and it is why the gate has browser tests at all.
   * ==========================================================================
   */
  const expiredRef = useRef(false);

  const expire = useCallback(() => {
    if (expiredRef.current) return;
    expiredRef.current = true;

    /*
     * EVERY QUERY EXCEPT THE SESSION ONE. The cross-user leak §5.5 names is
     * about a previous user's PROFILE, PRACTICE HISTORY and DIGEST surviving in
     * cache on a shared family device — none of which is the bootstrap. Leaving
     * the bootstrap in place also preserves its 401, which is the answer that
     * makes `status` read `unauthenticated` rather than flipping back to
     * `loading`.
     *
     * Removed BEFORE the navigation: the login route may render synchronously,
     * and anything mounted underneath would otherwise read the stale cache.
     */
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] !== sessionKeys.currentUser[0],
    });

    // On a public route, being signed out is the expected state — there is
    // nothing to redirect away from.
    if (pathname !== null && PUBLIC_PATHS.includes(pathname)) return;

    const next = pathname === null ? null : pathname;
    const target = next === null ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
    router.replace(target);
  }, [pathname, queryClient, router]);

  /*
   * Any 401, from any request in the application. See `session-events.ts` for
   * why this arrives as a published fact rather than a direct call.
   */
  useEffect(() => onUnauthenticated(expire), [expire]);

  /*
   * A NEW SIGN-IN RE-ARMS THE GUARD. The provider is not remounted by logging
   * in — the same instance sees the bootstrap succeed — so without this, the
   * second expiry of a browser session would clear nothing and redirect
   * nowhere.
   */
  useEffect(() => {
    if (query.data !== undefined) expiredRef.current = false;
  }, [query.data]);

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
