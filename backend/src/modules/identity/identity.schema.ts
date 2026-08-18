import { parseInput } from '@/platform/validation/index';
import {
  forgotPasswordRequestSchema,
  linkIdParamSchema,
  loginRequestSchema,
  resendVerificationRequestSchema,
  changePasswordRequestSchema,
  linkOtpRedeemSchema,
  linkOtpRequestSchema,
  resetPasswordRequestSchema,
  signupRequestSchema,
  submitLinkRequestSchema,
  verifyQuerySchema,
} from '@/shared/contracts/identity.contract';

/**
 * The module's validation boundary.
 *
 * The SHAPES live in `shared/contracts/identity.contract.ts` because the
 * frontend imports the inferred types from there — one definition, two
 * consumers. This file binds them to the module.
 *
 * `parseInput` used to live here as a private function. It moved to
 * `platform/validation` when `learner` and `content` landed and needed the
 * same helper (D-050) — the alternative was three copies of the rule deciding
 * what a client is told about a malformed request. It is re-exported so the
 * routes in this module still reach it through one import.
 */

export const identitySchemas = {
  signup: signupRequestSchema,
  resendVerification: resendVerificationRequestSchema,
  verify: verifyQuerySchema,
  login: loginRequestSchema,
  forgotPassword: forgotPasswordRequestSchema,
  changePassword: changePasswordRequestSchema,
  linkOtpRequest: linkOtpRequestSchema,
  linkOtpRedeem: linkOtpRedeemSchema,
  resetPassword: resetPasswordRequestSchema,
  submitLink: submitLinkRequestSchema,
  linkIdParam: linkIdParamSchema,
} as const;

/** The shared HTTP parse boundary. Lives in `platform/validation` — see D-050. */
export { parseInput };
