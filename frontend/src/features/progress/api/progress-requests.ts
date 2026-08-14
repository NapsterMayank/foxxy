import { apiRequest } from '@/lib/api/client';
import {
  historyResponseSchema,
  progressResponseSchema,
  type HistoryResponse,
  type ProgressResponse,
} from '@/lib/api/generated/contracts/practice.contract';
import { practicePaths } from '@/lib/api/paths';

/**
 * ===========================================================================
 * THE PROGRESS WIRE CALLS — build-order step 11.
 *
 * ---------------------------------------------------------------------------
 * THEY LIVE HERE AND NOT IN `features/practice/api`, EVEN THOUGH THE PATHS SAY
 * `/practice/…` AND THE CONTRACT IS PRACTICE'S.
 *
 * They were written there first, and `architecture/no-cross-feature-imports`
 * rejected this feature importing them — correctly, and the first instinct was
 * to argue with the gate in a comment. The gate was pointing at a real mistake:
 * ownership follows the CALLER, not the URL prefix. Practice's own screen calls
 * mission, session, answer and submit; it never reads progress or history. Two
 * screens read these, and both of them are this one.
 *
 * The shared parts are already shared: the paths are in `lib/api/paths`, the
 * schemas are generated, and the cache keys are in `lib/api/query-keys` — which
 * is how practice's submit mutation can invalidate what this feature queries
 * without either one importing the other.
 * ===========================================================================
 */

export function getPracticeProgress(): Promise<ProgressResponse> {
  return apiRequest({ path: practicePaths.progress, schema: progressResponseSchema });
}

export function getPracticeHistory(): Promise<HistoryResponse> {
  return apiRequest({ path: practicePaths.history, schema: historyResponseSchema });
}
