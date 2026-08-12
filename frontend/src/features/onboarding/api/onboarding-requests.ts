import { apiRequest } from '@/lib/api/client';
import {
  linkResponseSchema,
  submitLinkRequestSchema,
  type LinkResponse,
  type SubmitLinkRequest,
} from '@/lib/api/generated/contracts/identity.contract';
import {
  onboardingRequestSchema,
  onboardingResponseSchema,
  type OnboardingRequest,
  type OnboardingResponse,
} from '@/lib/api/generated/contracts/learner.contract';
import { learnerPaths, linkPaths } from '@/lib/api/paths';

/**
 * ===========================================================================
 * ONBOARDING — TWO ROLES, TWO ENDPOINTS, AND THEY ARE NOT VARIANTS.
 *
 * A STUDENT creates a learner profile: `POST /me/onboarding`, with a display
 * name, a grade and at least one subject.
 *
 * A PARENT does not have a learner profile at all. There is no parent profile
 * endpoint anywhere in the backend — the parent's onboarding step is claiming
 * the child's link code, `POST /links/submit`, which creates a link in
 * `pending` and grants nothing until the student approves it (§6.8).
 *
 * The presentational form asked a parent for their NAME. Nothing stores it, so
 * the field is gone rather than collected and dropped on the floor.
 * ===========================================================================
 */

export function completeStudentOnboarding(
  input: OnboardingRequest,
): Promise<OnboardingResponse> {
  return apiRequest({
    path: learnerPaths.onboarding,
    method: 'POST',
    body: onboardingRequestSchema.parse(input),
    schema: onboardingResponseSchema,
  });
}

export function submitLinkCode(input: SubmitLinkRequest): Promise<LinkResponse> {
  return apiRequest({
    path: linkPaths.submit,
    method: 'POST',
    // `linkCodeSchema` upper-cases and trims — a parent typing `ab12cd` sends
    // `AB12CD`, which is the only form the backend looks up.
    body: submitLinkRequestSchema.parse(input),
    schema: linkResponseSchema,
  });
}
