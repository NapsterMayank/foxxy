'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { ApiError } from '@/lib/api/errors';
import type {
  ProfileResponse,
  UpdateProfileRequest,
} from '@/lib/api/generated/contracts/learner.contract';
import { learnerKeys } from '@/lib/api/query-keys';
import { getMyProfile, updateMyProfile } from '../api/profile-requests';

/**
 * ===========================================================================
 * PROFILE DATA.
 *
 * ONE QUERY, ONE MUTATION, AND THE MUTATION WRITES THE RESPONSE INTO THE
 * QUERY RATHER THAN INVALIDATING IT.
 *
 * `PATCH /me/profile` returns the whole updated profile — the same shape the
 * GET returns, from the same row, after the write. Invalidating would throw
 * that away and ask for it again, and the gap between the two is a screen
 * showing the OLD name for as long as the refetch takes, immediately after
 * telling the student it was saved. `setQueryData` has no such gap.
 *
 * The key is `learnerKeys.profile()` from `lib/api/query-keys`, which is how
 * the header identity re-renders with the new name without importing this
 * feature or knowing a save happened.
 * ===========================================================================
 */

export function useMyProfile(): UseQueryResult<ProfileResponse, ApiError> {
  return useQuery<ProfileResponse, ApiError>({
    queryKey: learnerKeys.profile(),
    queryFn: getMyProfile,
  });
}

export function useUpdateProfile(): UseMutationResult<
  ProfileResponse,
  ApiError,
  UpdateProfileRequest
> {
  const queryClient = useQueryClient();

  return useMutation<ProfileResponse, ApiError, UpdateProfileRequest>({
    mutationFn: updateMyProfile,
    onSuccess: (data) => {
      queryClient.setQueryData(learnerKeys.profile(), data);
    },
  });
}
