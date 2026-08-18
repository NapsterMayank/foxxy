import { apiRequest } from '@/lib/api/client';
import {
  profileResponseSchema,
  updateProfileRequestSchema,
  type ProfileResponse,
  type UpdateProfileRequest,
} from '@/lib/api/generated/contracts/learner.contract';
import { learnerPaths } from '@/lib/api/paths';

/**
 * ===========================================================================
 * THE PROFILE WIRE CALLS — `GET` and `PATCH /me/profile`.
 *
 * ---------------------------------------------------------------------------
 * THEY LIVE HERE AND NOT IN `features/onboarding`, WHICH ALSO WRITES A
 * PROFILE.
 *
 * Ownership follows the CALLER, not the resource — the rule D-356 settled and
 * `features/progress/api/progress-requests.ts` records at length. Onboarding
 * CREATES a profile once, as the last step of signing up, and never reads one
 * back. This screen reads and amends one, repeatedly, for years afterwards.
 * Two callers, two owners, and everything genuinely shared between them is
 * already shared: the path is in `lib/api/paths`, the schemas are generated,
 * and the cache key is in `lib/api/query-keys`.
 * ===========================================================================
 */

export function getMyProfile(): Promise<ProfileResponse> {
  return apiRequest({ path: learnerPaths.profile, schema: profileResponseSchema });
}

/**
 * A PARTIAL update — and the `parse` here is load-bearing twice.
 *
 * It strips anything the contract does not accept (`board` above all, which is
 * a syllabus migration rather than a profile edit), and it enforces the "at
 * least one field" refinement BEFORE the request leaves. An empty PATCH is a
 * 400 at the backend; catching it here turns a serialisation bug in a form
 * into a validation message beside the fields, rather than into a server error
 * the student can do nothing about.
 */
/*
 * `async` DELIBERATELY, even though the body is one `return`. `parse` throws
 * SYNCHRONOUSLY, and a mutation function that throws synchronously escapes the
 * caller's promise chain — the error arrives as an exception where every other
 * failure on this screen arrives as a rejected mutation. `async` makes the
 * validation failure the same shape as a 400 from the server.
 */
export async function updateMyProfile(input: UpdateProfileRequest): Promise<ProfileResponse> {
  return apiRequest({
    path: learnerPaths.profile,
    method: 'PATCH',
    body: updateProfileRequestSchema.parse(input),
    schema: profileResponseSchema,
  });
}
