'use client';

import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import type { ApiError } from '@/lib/api/errors';
import type {
  FoxyCapabilitiesResponse,
  FoxySessionResponse,
  StartFoxySessionRequest,
} from '@/lib/api/generated/contracts/foxy.contract';
import { foxyKeys } from '@/lib/api/query-keys';
import { getFoxyCapabilities, getFoxySession, startFoxySession } from '../api/foxy-requests';
import { historyToMessages } from '../lib/transcript';
import type { FoxyStreamMessage } from './use-foxy-stream';

/**
 * ===========================================================================
 * THE NON-STREAMING HALF OF THE FOXY SCREEN — build-order step 9.
 *
 * Thin, like the auth mutations, and for the same reason: no-retry and the 401
 * rule are decided once in `providers.tsx`, and re-deciding them per feature is
 * how two screens end up with different rules.
 * ===========================================================================
 */

/**
 * The served capabilities — the six buttons and today's allowance.
 *
 * `staleTime` is deliberately short rather than infinite: `usage.remaining`
 * comes down with every turn, and a cached-forever allowance shows a student
 * "18 left" for an hour after it has run out. The action LIST barely changes;
 * the number beside it changes constantly, and they arrive together.
 */
export function useFoxyCapabilities(): UseQueryResult<FoxyCapabilitiesResponse, ApiError> {
  return useQuery<FoxyCapabilitiesResponse, ApiError>({
    queryKey: foxyKeys.capabilities(),
    queryFn: getFoxyCapabilities,
  });
}

export function useStartFoxySession(): UseMutationResult<
  FoxySessionResponse,
  ApiError,
  StartFoxySessionRequest
> {
  return useMutation<FoxySessionResponse, ApiError, StartFoxySessionRequest>({
    mutationFn: startFoxySession,
  });
}

export interface FoxyTranscript {
  /** The conversation as the server stored it. See `historyToMessages`. */
  readonly history: readonly FoxyStreamMessage[];
  readonly isLoading: boolean;
  readonly error: ApiError | null;
  readonly refetch: () => void;
}

/**
 * The conversation as the server has it, for the messages that arrived before
 * this screen was mounted.
 *
 * ---------------------------------------------------------------------------
 * DERIVED IN RENDER, WITH NO FREEZE, AND THAT TOOK A DETOUR WORTH RECORDING.
 *
 * The screen shows this list and the live one appended, so a refetch that
 * returns a turn the stream hook is still holding renders that answer twice —
 * and there is no key that could deduplicate them, because a user message
 * carries no server id at all.
 *
 * The instinct is to freeze the first load, in a ref or in state-plus-effect.
 * BOTH ARE LINT ERRORS AND BOTH RULES ARE RIGHT: `react-hooks/refs` refuses a
 * ref read during render, and `react-hooks/set-state-in-effect` refuses the
 * cascading render the effect version costs. A rule refusing both spellings of
 * an idea usually means the idea is in the wrong place.
 *
 * It was. The duplication came from `useFoxyStream` REFETCHING on completion,
 * so it is fixed there — the invalidation now carries `refetchType: 'none'`,
 * marking the cache stale without disturbing the mounted screen. Nothing here
 * needs to remember anything, and this hook is a pure read again.
 */
export function useFoxyTranscript(sessionId: string | null): FoxyTranscript {
  const query = useQuery<FoxySessionResponse, ApiError>({
    queryKey: foxyKeys.session(sessionId ?? ''),
    queryFn: () => getFoxySession(sessionId ?? ''),
    enabled: sessionId !== null,
  });

  return {
    history: historyToMessages(query.data?.messages ?? []),
    isLoading: sessionId !== null && query.isPending,
    error: query.error ?? null,
    refetch: () => {
      void query.refetch();
    },
  };
}
