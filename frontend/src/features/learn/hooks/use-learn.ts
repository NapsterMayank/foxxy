'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api/client';
import type { ApiError } from '@/lib/api/errors';
import type {
  ChapterConceptsResponse,
  ChaptersResponse,
} from '@/lib/api/generated/contracts/content.contract';
import {
  profileResponseSchema,
  type ProfileResponse,
} from '@/lib/api/generated/contracts/learner.contract';
import { contentKeys, learnerKeys } from '@/lib/api/query-keys';
import { learnerPaths } from '@/lib/api/paths';
import { getChapterConcepts, getChapters } from '../api/learn-requests';

/**
 * ===========================================================================
 * THE STUDY BROWSER'S DATA — subject → chapter → concept.
 *
 * `staleTime: Infinity` on both content queries. A syllabus does not change
 * while somebody is reading it, and a refetch that reordered a chapter list
 * under a finger already moving towards a row is a worse outcome than showing
 * a list that is a few minutes old. The corpus changes on import, not on
 * window focus.
 * ===========================================================================
 */

/**
 * The student's own profile, for the grade.
 *
 * A SEPARATE QUERY RATHER THAN A PROP, because the grade is needed by two
 * screens that do not share a parent — the subject browser and the chapter
 * walkthrough, which is reachable by URL without passing through the browser
 * at all. One cached query answers both.
 */
export function useProfile(): UseQueryResult<ProfileResponse, ApiError> {
  return useQuery<ProfileResponse, ApiError>({
    queryKey: learnerKeys.profile(),
    queryFn: () => apiRequest({ path: learnerPaths.profile, schema: profileResponseSchema }),
    staleTime: Infinity,
  });
}

export function useChapters(
  grade: string | null,
  subject: string | null,
): UseQueryResult<ChaptersResponse, ApiError> {
  return useQuery<ChaptersResponse, ApiError>({
    queryKey: contentKeys.chapters({
      ...(grade === null ? {} : { grade }),
      ...(subject === null ? {} : { subject }),
    }),
    queryFn: () => getChapters(grade ?? '', subject ?? ''),
    // Both are needed, and the grade arrives from a second query — so this
    // stays disabled until the profile has answered rather than firing a
    // request that would 400.
    enabled: grade !== null && subject !== null,
    staleTime: Infinity,
  });
}

export function useChapterConcepts(
  chapterId: string | null,
): UseQueryResult<ChapterConceptsResponse, ApiError> {
  return useQuery<ChapterConceptsResponse, ApiError>({
    queryKey: contentKeys.concepts(chapterId ?? ''),
    queryFn: () => getChapterConcepts(chapterId ?? ''),
    enabled: chapterId !== null,
    staleTime: Infinity,
  });
}
