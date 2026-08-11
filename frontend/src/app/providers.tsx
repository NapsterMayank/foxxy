'use client';

import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api/errors';
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
  if (error instanceof ApiError && error.status === 401) {
    notifyUnauthenticated();
  }
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

export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>{children}</SessionProvider>
    </QueryClientProvider>
  );
}
