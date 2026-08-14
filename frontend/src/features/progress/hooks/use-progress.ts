'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ApiError } from '@/lib/api/errors';
import type {
  HistoryResponse,
  ProgressResponse,
} from '@/lib/api/generated/contracts/practice.contract';
import { practiceKeys } from '@/lib/api/query-keys';
import { getPracticeHistory, getPracticeProgress } from '../api/progress-requests';

/**
 * ===========================================================================
 * PROGRESS DATA — build-order step 11.
 *
 * The two queries this screen is: the ledger and the recent sessions. They are
 * SEPARATE QUERIES on purpose — the tiles must not wait on the history list,
 * and a failed history must not take the XP figures down with it.
 *
 * The cache keys are `practiceKeys`, shared through `lib/api/query-keys`, which
 * is how practice's submit mutation invalidates what this feature queries
 * without either feature importing the other.
 */

export function useProgress(): UseQueryResult<ProgressResponse, ApiError> {
  return useQuery<ProgressResponse, ApiError>({
    queryKey: practiceKeys.progress(),
    queryFn: getPracticeProgress,
  });
}

export function usePracticeHistory(): UseQueryResult<HistoryResponse, ApiError> {
  return useQuery<HistoryResponse, ApiError>({
    queryKey: practiceKeys.history(),
    queryFn: getPracticeHistory,
  });
}
