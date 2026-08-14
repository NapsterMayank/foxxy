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
  AnswerResult,
  MissionResponse,
  PracticeSessionResponse,
  StartSessionRequest,
  SubmissionResponse,
  SubmitAnswerRequest,
} from '@/lib/api/generated/contracts/practice.contract';
import { learnerKeys, practiceKeys } from '@/lib/api/query-keys';
import {
  getMission,
  getPracticeSession,
  startPracticeSession,
  submitPracticeAnswer,
  submitPracticeSession,
} from '../api/practice-requests';

/**
 * ===========================================================================
 * PRACTICE DATA — build-order step 10.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE IS OPTIMISTIC, AND THE PLAN SAYS WHY IN §5.4: "optimistic
 * updates only where the operation genuinely cannot fail — NOT on practice
 * submission, which can be rejected by anti-cheat."
 *
 * The same reasoning covers an answer. A rendered "correct!" that the server
 * then refuses with a 409 is worse than a moment's wait: it has already told a
 * child something about their learning that turned out not to be true.
 * ===========================================================================
 */

export function useMission(): UseQueryResult<MissionResponse, ApiError> {
  return useQuery<MissionResponse, ApiError>({
    queryKey: practiceKeys.mission(),
    queryFn: getMission,
  });
}

export function usePracticeSession(
  sessionId: string | null,
): UseQueryResult<PracticeSessionResponse, ApiError> {
  return useQuery<PracticeSessionResponse, ApiError>({
    queryKey: practiceKeys.session(sessionId ?? ''),
    queryFn: () => getPracticeSession(sessionId ?? ''),
    enabled: sessionId !== null,
    /*
     * NOT REFETCHED WHILE THE STUDENT WORKS. The session's question order is
     * frozen server-side for this attempt, so there is nothing new to learn
     * from it — and a refetch mid-question that re-rendered the option list
     * would move the answer under a finger already on its way down.
     */
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useStartPracticeSession(): UseMutationResult<
  PracticeSessionResponse,
  ApiError,
  StartSessionRequest
> {
  return useMutation<PracticeSessionResponse, ApiError, StartSessionRequest>({
    mutationFn: startPracticeSession,
  });
}

export interface AnswerInput {
  readonly sessionId: string;
  readonly answer: SubmitAnswerRequest;
}

export function useSubmitAnswer(): UseMutationResult<AnswerResult, ApiError, AnswerInput> {
  return useMutation<AnswerResult, ApiError, AnswerInput>({
    mutationFn: ({ answer, sessionId }) => submitPracticeAnswer(sessionId, answer),
  });
}

/**
 * Submission — the one call that writes XP, mastery and the retention schedule.
 *
 * It invalidates progress, history, the mission AND the learner's mastery,
 * because all four are downstream of this single transaction and a screen still
 * showing yesterday's mission after finishing it reads as the session not having
 * counted.
 */
export function useSubmitPracticeSession(): UseMutationResult<SubmissionResponse, ApiError, string> {
  const queryClient = useQueryClient();

  return useMutation<SubmissionResponse, ApiError, string>({
    mutationFn: submitPracticeSession,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: practiceKeys.progress() });
      void queryClient.invalidateQueries({ queryKey: practiceKeys.history() });
      void queryClient.invalidateQueries({ queryKey: practiceKeys.mission() });
      void queryClient.invalidateQueries({ queryKey: learnerKeys.mastery() });
    },
  });
}
