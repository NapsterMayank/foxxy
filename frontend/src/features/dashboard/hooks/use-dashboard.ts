'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ApiError } from '@/lib/api/errors';
import type { ProfileResponse } from '@/lib/api/generated/contracts/learner.contract';
import type {
  MissionResponse,
  ProgressResponse,
} from '@/lib/api/generated/contracts/practice.contract';
import { learnerKeys, practiceKeys } from '@/lib/api/query-keys';
import { getMyProfile, getPracticeProgress, getTodaysMission } from '../api/dashboard-requests';

/**
 * ===========================================================================
 * DASHBOARD DATA — THREE INDEPENDENT QUERIES, AND THE SCREEN WAITS FOR ONE.
 *
 * The mission is the only one the dashboard is *about*. A slow ledger must not
 * hold back "here is what to practise next", and a failed profile must not
 * take the whole screen down for the sake of a name in a greeting — the
 * greeting says "Hello" without one.
 *
 * Every key is shared (`practiceKeys`, `learnerKeys`), so nothing here is a
 * second fetch of something another screen already has.
 * ===========================================================================
 */

export function useMission(): UseQueryResult<MissionResponse, ApiError> {
  return useQuery<MissionResponse, ApiError>({
    queryKey: practiceKeys.mission(),
    queryFn: getTodaysMission,
  });
}

export function useDashboardProgress(): UseQueryResult<ProgressResponse, ApiError> {
  return useQuery<ProgressResponse, ApiError>({
    queryKey: practiceKeys.progress(),
    queryFn: getPracticeProgress,
  });
}

export function useDashboardProfile(): UseQueryResult<ProfileResponse, ApiError> {
  return useQuery<ProfileResponse, ApiError>({
    queryKey: learnerKeys.profile(),
    queryFn: getMyProfile,
  });
}
