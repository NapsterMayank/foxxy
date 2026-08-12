'use client';

import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { ApiError } from '@/lib/api/errors';
import type {
  ForgotPasswordRequest,
  LoginRequest,
  LoginResponse,
  OkResponse,
  ResendVerificationRequest,
  ResetPasswordRequest,
  SignupRequest,
  SignupResponse,
} from '@/lib/api/generated/contracts/identity.contract';
import { sessionKeys } from '@/lib/api/query-keys';
import {
  forgotPassword,
  login,
  resendVerification,
  resetPassword,
  signup,
  verifyEmail,
} from '../api/auth-requests';

/**
 * ===========================================================================
 * THE AUTH MUTATIONS — build-order steps 7-8.
 *
 * Thin on purpose. Everything that is the same for every mutation in the
 * product — no automatic retry, a 401 ending the session — is already decided
 * once in `providers.tsx`, and re-deciding it here is how two screens end up
 * with different rules.
 * ===========================================================================
 */

/**
 * Sign-in, and the cache write that makes the redirect safe.
 *
 * ---------------------------------------------------------------------------
 * `setQueryData` FIRST, THEN A BACKGROUND INVALIDATE.
 *
 * The login response and `GET /auth/me` are THE SAME SHAPE — the contract
 * aliases one to the other in as many words, "so the refresh path cannot drift
 * from the sign-in path". That makes the response a complete, already-validated
 * answer to "who am I", so seeding it is not an optimisation.
 *
 * It is a correctness fix: navigating on success while the bootstrap still
 * holds its 401 sends an authenticated person to a route whose session gate
 * reads `unauthenticated` and bounces them back to login. Invalidating alone
 * leaves that window open for the length of a round trip. Seeding closes it,
 * and the invalidate afterwards still refetches in the background so the
 * canonical answer wins if it ever differs.
 */
export function useLogin(): UseMutationResult<LoginResponse, ApiError, LoginRequest> {
  const queryClient = useQueryClient();

  return useMutation<LoginResponse, ApiError, LoginRequest>({
    mutationFn: login,
    onSuccess: (data) => {
      queryClient.setQueryData(sessionKeys.currentUser, data);
      void queryClient.invalidateQueries({ queryKey: sessionKeys.currentUser });
    },
  });
}

export function useSignup(): UseMutationResult<SignupResponse, ApiError, SignupRequest> {
  return useMutation<SignupResponse, ApiError, SignupRequest>({ mutationFn: signup });
}

export function useVerifyEmail(): UseMutationResult<OkResponse, ApiError, string> {
  return useMutation<OkResponse, ApiError, string>({ mutationFn: verifyEmail });
}

export function useResendVerification(): UseMutationResult<
  OkResponse,
  ApiError,
  ResendVerificationRequest
> {
  return useMutation<OkResponse, ApiError, ResendVerificationRequest>({
    mutationFn: resendVerification,
  });
}

export function useForgotPassword(): UseMutationResult<
  OkResponse,
  ApiError,
  ForgotPasswordRequest
> {
  return useMutation<OkResponse, ApiError, ForgotPasswordRequest>({ mutationFn: forgotPassword });
}

export function useResetPassword(): UseMutationResult<OkResponse, ApiError, ResetPasswordRequest> {
  return useMutation<OkResponse, ApiError, ResetPasswordRequest>({ mutationFn: resetPassword });
}
