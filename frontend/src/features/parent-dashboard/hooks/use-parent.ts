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
  ChildrenResponse,
  ConsentResponse,
  ConsentRevokeResponse,
  DigestResponse,
  SnapshotResponse,
  TranscriptResponse,
} from '@/lib/api/generated/contracts/parent.contract';
import { parentKeys } from '@/lib/api/query-keys';
import {
  getChildren,
  getConsent,
  getDigest,
  getSnapshot,
  getTranscript,
  revokeConsent,
} from '../api/parent-requests';

/**
 * ===========================================================================
 * PARENT DATA — build-order step 12.
 *
 * FOUR SEPARATE QUERIES PER CHILD, not one aggregate. They are four endpoints
 * because they answer four questions with different costs and different
 * failure modes: the snapshot is counts, the digest is prose that may not
 * exist, the transcript is a page of conversation, consent is a state.
 *
 * A screen that waited for all four would be as slow as the slowest and as
 * fragile as the weakest — and the transcript, which is the biggest and the
 * one a parent looks at least, would hold up the numbers they came for.
 * ===========================================================================
 */

export function useChildren(): UseQueryResult<ChildrenResponse, ApiError> {
  return useQuery<ChildrenResponse, ApiError>({
    queryKey: parentKeys.children(),
    queryFn: getChildren,
  });
}

export function useSnapshot(childId: string | null): UseQueryResult<SnapshotResponse, ApiError> {
  return useQuery<SnapshotResponse, ApiError>({
    queryKey: parentKeys.snapshot(childId ?? ''),
    queryFn: () => getSnapshot(childId ?? ''),
    enabled: childId !== null,
  });
}

export function useDigest(childId: string | null): UseQueryResult<DigestResponse, ApiError> {
  return useQuery<DigestResponse, ApiError>({
    queryKey: parentKeys.digest(childId ?? ''),
    queryFn: () => getDigest(childId ?? ''),
    enabled: childId !== null,
  });
}

export function useTranscript(childId: string | null): UseQueryResult<TranscriptResponse, ApiError> {
  return useQuery<TranscriptResponse, ApiError>({
    queryKey: parentKeys.transcript(childId ?? ''),
    queryFn: () => getTranscript(childId ?? ''),
    enabled: childId !== null,
  });
}

export function useConsent(childId: string | null): UseQueryResult<ConsentResponse, ApiError> {
  return useQuery<ConsentResponse, ApiError>({
    queryKey: parentKeys.consent(childId ?? ''),
    queryFn: () => getConsent(childId ?? ''),
    enabled: childId !== null,
  });
}

/**
 * Withdrawing access.
 *
 * IT INVALIDATES `children` AS WELL AS `consent`, because revoking does not
 * just change a flag — the link leaves the approved set, and a dashboard still
 * listing that child would offer a snapshot every subsequent request would
 * refuse. The child's own three queries are dropped from the cache rather than
 * refetched: they are exactly the data the parent just gave up, and refetching
 * them would fire three requests designed to 403.
 */
export function useRevokeConsent(): UseMutationResult<ConsentRevokeResponse, ApiError, string> {
  const queryClient = useQueryClient();

  return useMutation<ConsentRevokeResponse, ApiError, string>({
    mutationFn: revokeConsent,
    onSuccess: (_result, childId) => {
      queryClient.removeQueries({ queryKey: parentKeys.snapshot(childId) });
      queryClient.removeQueries({ queryKey: parentKeys.digest(childId) });
      queryClient.removeQueries({ queryKey: parentKeys.transcript(childId) });
      void queryClient.invalidateQueries({ queryKey: parentKeys.consent(childId) });
      void queryClient.invalidateQueries({ queryKey: parentKeys.children() });
    },
  });
}
