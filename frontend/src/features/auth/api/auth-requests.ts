import { apiRequest } from '@/lib/api/client';
import {
  forgotPasswordRequestSchema,
  loginRequestSchema,
  loginResponseSchema,
  okResponseSchema,
  resendVerificationRequestSchema,
  resetPasswordRequestSchema,
  signupRequestSchema,
  signupResponseSchema,
  type ForgotPasswordRequest,
  type LoginRequest,
  type LoginResponse,
  type OkResponse,
  type ResendVerificationRequest,
  type ResetPasswordRequest,
  type SignupRequest,
  type SignupResponse,
} from '@/lib/api/generated/contracts/identity.contract';
import { authPaths } from '@/lib/api/paths';

/**
 * ===========================================================================
 * THE AUTH WIRE CALLS — build-order steps 7-8.
 *
 * One function per endpoint, each taking a value the GENERATED REQUEST SCHEMA
 * has already accepted and returning one the generated response schema has
 * validated. Nothing here builds a URL by hand, invents a body shape, or knows
 * anything about React.
 *
 * THE REQUEST SCHEMAS ARE PARSED HERE, NOT MERELY USED AS TYPES. `emailSchema`
 * trims and lowercases and `linkCodeSchema` upper-cases — transformations the
 * backend applies at its own boundary, which means an untransformed value sent
 * from here is a value the server silently changes. Parsing on the way out
 * makes the two sides agree on the bytes, and makes "the email had a trailing
 * space" stop being a class of bug at all.
 * ===========================================================================
 */

export function signup(input: SignupRequest): Promise<SignupResponse> {
  return apiRequest({
    path: authPaths.signup,
    method: 'POST',
    body: signupRequestSchema.parse(input),
    schema: signupResponseSchema,
  });
}

export function login(input: LoginRequest): Promise<LoginResponse> {
  return apiRequest({
    path: authPaths.login,
    method: 'POST',
    body: loginRequestSchema.parse(input),
    schema: loginResponseSchema,
  });
}

export function logout(): Promise<OkResponse> {
  return apiRequest({ path: authPaths.logout, method: 'POST', schema: okResponseSchema });
}

/**
 * `GET`, and the token travels in the QUERY STRING — the link in the email is
 * what the person clicks, so the request the browser makes is a navigation the
 * backend answers, not a form post. The six-digit-code form this screen used to
 * show was never an endpoint; `/auth/verify` has always taken `?token=`.
 */
export function verifyEmail(token: string): Promise<OkResponse> {
  return apiRequest({
    path: `${authPaths.verify}?token=${encodeURIComponent(token)}`,
    schema: okResponseSchema,
  });
}

export function resendVerification(input: ResendVerificationRequest): Promise<OkResponse> {
  return apiRequest({
    path: authPaths.resendVerification,
    method: 'POST',
    body: resendVerificationRequestSchema.parse(input),
    schema: okResponseSchema,
  });
}

export function forgotPassword(input: ForgotPasswordRequest): Promise<OkResponse> {
  return apiRequest({
    path: authPaths.forgotPassword,
    method: 'POST',
    body: forgotPasswordRequestSchema.parse(input),
    schema: okResponseSchema,
  });
}

export function resetPassword(input: ResetPasswordRequest): Promise<OkResponse> {
  return apiRequest({
    path: authPaths.resetPassword,
    method: 'POST',
    body: resetPasswordRequestSchema.parse(input),
    schema: okResponseSchema,
  });
}
