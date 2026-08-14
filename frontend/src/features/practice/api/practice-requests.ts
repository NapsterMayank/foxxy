import { z } from 'zod';
import { apiRequest } from '@/lib/api/client';
import {
  answerResultSchema,
  missionResponseSchema,
  practiceSessionResponseSchema,
  startSessionRequestSchema,
  submissionResponseSchema,
  submitAnswerRequestSchema,
  type AnswerResult,
  type MissionResponse,
  type PracticeSessionResponse,
  type StartSessionRequest,
  type SubmissionResponse,
  type SubmitAnswerRequest,
} from '@/lib/api/generated/contracts/practice.contract';
import { practicePaths } from '@/lib/api/paths';

/**
 * ===========================================================================
 * THE PRACTICE WIRE CALLS — build-order step 10.
 *
 * Every response has a GENERATED Zod schema here, unlike Foxy's — the practice
 * contract defines its responses as schemas rather than interfaces, so nothing
 * is written by hand and nothing needs a `satisfies` pin.
 *
 * `/practice/progress` and `/practice/history` are NOT here. They are read by the
 * progress screen and by nothing in this feature, so they live in
 * `features/progress/api` — ownership follows the caller, not the URL prefix.
 *
 * `startSessionRequestSchema` and `submitAnswerRequestSchema` are PARSED on the
 * way out, not merely used as types. Both carry `.default()` — `questionCount`
 * and `hintLevelUsed` — so parsing is what fills them in; sending the object
 * unparsed would omit fields the backend then defaults differently one day.
 * ===========================================================================
 */

export function getMission(): Promise<MissionResponse> {
  return apiRequest({ path: practicePaths.mission, schema: missionResponseSchema });
}

export function startPracticeSession(
  input: StartSessionRequest,
): Promise<PracticeSessionResponse> {
  return apiRequest({
    path: practicePaths.sessions,
    method: 'POST',
    body: startSessionRequestSchema.parse(input),
    schema: practiceSessionResponseSchema,
  });
}

export function getPracticeSession(sessionId: string): Promise<PracticeSessionResponse> {
  return apiRequest({
    path: practicePaths.session(sessionId),
    schema: practiceSessionResponseSchema,
  });
}

/**
 * One answer, and the answer key that comes back with it.
 *
 * THE RESPONSE IS THE DISCLOSURE. `correctPresentationIndex` and `explanation`
 * arrive here and nowhere earlier — the session shape carries no field from
 * which the answer can be derived, deliberately, because this folder is
 * imported by the browser. A second answer to the same question is a 409
 * (D-281), which is what makes disclosing the key at this moment defensible.
 */
export function submitPracticeAnswer(
  sessionId: string,
  input: SubmitAnswerRequest,
): Promise<AnswerResult> {
  return apiRequest({
    path: practicePaths.answers(sessionId),
    method: 'POST',
    body: submitAnswerRequestSchema.parse(input),
    /*
     * The ONE envelope the contract does not export. `submissionResponseSchema`
     * exists for `/submit`; the per-answer route sends `{ result }` inline and
     * has no named response schema, so the envelope is built here from the
     * generated `answerResultSchema` — the part that matters is still generated,
     * and a field change there fails at build time.
     */
    schema: z.object({ result: answerResultSchema }),
  }).then((body) => body.result);
}

export function submitPracticeSession(sessionId: string): Promise<SubmissionResponse> {
  return apiRequest({
    path: practicePaths.submit(sessionId),
    method: 'POST',
    schema: submissionResponseSchema,
  });
}
