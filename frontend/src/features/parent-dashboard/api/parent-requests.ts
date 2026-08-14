import { apiRequest } from '@/lib/api/client';
import {
  childrenResponseSchema,
  consentResponseSchema,
  consentRevokeResponseSchema,
  digestResponseSchema,
  snapshotResponseSchema,
  transcriptResponseSchema,
  type ChildrenResponse,
  type ConsentResponse,
  type ConsentRevokeResponse,
  type DigestResponse,
  type SnapshotResponse,
  type TranscriptResponse,
} from '@/lib/api/generated/contracts/parent.contract';
import { parentPaths } from '@/lib/api/paths';

/**
 * ===========================================================================
 * THE PARENT WIRE CALLS — build-order step 12.
 *
 * Six calls, five of them reads. Every response schema is generated.
 *
 * ---------------------------------------------------------------------------
 * `week` IS PASSED THROUGH UNCOMPUTED, AND THAT IS DELIBERATE.
 *
 * The contract accepts ANY day in the week and normalises it to that week's
 * Monday on the server. A client that computed the Monday itself would be a
 * second implementation of the week boundary — in a different language, in a
 * different time zone — which is the drift the server-side pin exists to
 * prevent. So this layer offers the parameter and never derives it.
 * ===========================================================================
 */

export function getChildren(): Promise<ChildrenResponse> {
  return apiRequest({ path: parentPaths.children, schema: childrenResponseSchema });
}

export function getSnapshot(childId: string, week?: string): Promise<SnapshotResponse> {
  const query = week === undefined ? '' : `?week=${encodeURIComponent(week)}`;
  return apiRequest({ path: `${parentPaths.snapshot(childId)}${query}`, schema: snapshotResponseSchema });
}

export function getDigest(childId: string, week?: string): Promise<DigestResponse> {
  const query = week === undefined ? '' : `?week=${encodeURIComponent(week)}`;
  return apiRequest({ path: `${parentPaths.digest(childId)}${query}`, schema: digestResponseSchema });
}

export function getTranscript(childId: string): Promise<TranscriptResponse> {
  return apiRequest({ path: parentPaths.transcript(childId), schema: transcriptResponseSchema });
}

export function getConsent(childId: string): Promise<ConsentResponse> {
  return apiRequest({ path: parentPaths.consent(childId), schema: consentResponseSchema });
}

/** The parent withdrawing their own access. See the note on `parentPaths`. */
export function revokeConsent(childId: string): Promise<ConsentRevokeResponse> {
  return apiRequest({
    path: parentPaths.consentRevoke(childId),
    method: 'POST',
    schema: consentRevokeResponseSchema,
  });
}
