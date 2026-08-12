'use client';

import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api/errors';
import { authPaths } from '@/lib/api/paths';
import { I18nProvider } from '@/lib/i18n/i18n-provider';
import type { LanguageCode } from '@/lib/i18n/translate';
import { SessionProvider } from '@/lib/session/session-provider';
import { notifyUnauthenticated } from '@/lib/session/session-events';

/**
 * The application's providers — plan §6, build-order step 6.
 *
 * ===========================================================================
 * THE QUERY CLIENT IS CREATED IN STATE, NOT AT MODULE SCOPE.
 *
 * A module-scope client is shared by every request the Node server handles, so
 * one user's fetched profile is served out of cache to the next — the exact
 * cross-user leak §5.5 spends a paragraph on, arriving by a different door.
 * `useState` gives one client per browser session and one per server render.
 * ===========================================================================
 */

/**
 * Every 401, from every query and mutation, in one place.
 *
 * The caches see failures that no component is mounted to observe — a
 * background refetch, a mutation whose screen already unmounted — and §5.5
 * requires all of them to end the session. Putting the check on each hook would
 * make it a thing to remember, and the one that gets forgotten is the one that
 * leaves a dead session looking alive.
 */
function handleError(error: unknown): void {
  if (!(error instanceof ApiError) || error.status !== 401) return;

  /*
   * THE ONE EXCEPTION, AND IT IS NOT A SPECIAL CASE FOR CONVENIENCE.
   *
   * A wrong password returns 401 UNAUTHENTICATED — the same status and the same
   * code as an expired cookie, because the backend deliberately gives a failed
   * login one indistinguishable answer (identity.service.ts, LOGIN_FAILURE_
   * MESSAGE, so a wrong address and a wrong password cannot be told apart).
   *
   * Routing it here would end a session that never began: the cache is cleared
   * and the person is told they were signed out, on the screen where they are
   * trying to sign in. The path is the only thing that distinguishes the two.
   */
  if (error.path === authPaths.login) return;

  notifyUnauthenticated();
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: handleError }),
    mutationCache: new MutationCache({ onError: handleError }),
    defaultOptions: {
      queries: {
        /*
         * NO AUTOMATIC RETRY ON A 4xx. A 400, 403, 404 or 409 will not become a
         * different answer by being asked again; retrying delays the error
         * state the user needs to see and multiplies load exactly when
         * something is already wrong. 5xx and transport failures get one retry.
         */
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 1;
        },
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: {
        // A mutation is never retried automatically. Practice submission and
        // billing are not idempotent from the user's point of view, and a
        // silent second attempt is worse than a visible failure.
        retry: false,
      },
    },
  });
}

export function Providers({
  children,
  initialLanguage,
}: Readonly<{ children: ReactNode; initialLanguage: LanguageCode }>) {
  const [queryClient] = useState(createQueryClient);

  /*
   * ORDER: language OUTSIDE the session. The session gate's own skeleton and
   * its no-access state are translated, and they render while the bootstrap is
   * still in flight — so the translator has to exist before the session does.
   */
  return (
    <I18nProvider initialLanguage={initialLanguage}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>{children}</SessionProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}
