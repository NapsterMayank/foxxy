import { apiRequest } from '@/lib/api/client';
import {
  profileResponseSchema,
  type ProfileResponse,
} from '@/lib/api/generated/contracts/learner.contract';
import {
  missionResponseSchema,
  progressResponseSchema,
  type MissionResponse,
  type ProgressResponse,
} from '@/lib/api/generated/contracts/practice.contract';
import { learnerPaths, practicePaths } from '@/lib/api/paths';

/**
 * ===========================================================================
 * THE DASHBOARD WIRE CALLS.
 *
 * ---------------------------------------------------------------------------
 * THREE FUNCTIONS THAT ALSO EXIST IN OTHER FEATURES, DECLARED AGAIN HERE ON
 * PURPOSE.
 *
 * `no-cross-feature-imports` forbids this feature reaching into `practice`,
 * `progress` or `profile` for them, and that rule is right — it is the D-356
 * question, answered the same way every time: ownership follows the CALLER.
 * The dashboard reads a mission, a ledger and a name; practice starts sessions
 * and submits answers; the profile screen edits a profile. Three callers,
 * three owners.
 *
 * WHAT IS SHARED IS SHARED WHERE IT BELONGS. The paths are in `lib/api/paths`,
 * the schemas are generated from the backend contracts, and — the part that
 * makes the duplication cost nothing at runtime — the CACHE KEYS are in
 * `lib/api/query-keys`. This feature and the progress screen ask for
 * `practiceKeys.progress()`, so the second one to mount reads what the first
 * already fetched, and a submitted practice session invalidates both without
 * any feature importing another.
 * ===========================================================================
 */

export function getTodaysMission(): Promise<MissionResponse> {
  return apiRequest({ path: practicePaths.mission, schema: missionResponseSchema });
}

export function getPracticeProgress(): Promise<ProgressResponse> {
  return apiRequest({ path: practicePaths.progress, schema: progressResponseSchema });
}

export function getMyProfile(): Promise<ProfileResponse> {
  return apiRequest({ path: learnerPaths.profile, schema: profileResponseSchema });
}
