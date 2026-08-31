import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { VISIT_ID_HEADER, readVisitId } from '../visit-id';

/**
 * =============================================================================
 * D-401 — `X-Visit-Id`, WHICH THE DATABASE MUST NEVER BE ASKED TO TRUST.
 *
 * This function's whole job is to be the boundary between a header a caller
 * controls completely and a `uuid` column. There is no authorisation to get
 * wrong here, because nothing is ever scoped by this value — the risk is the
 * opposite one: that a future edit makes the parse permissive "so the header
 * works for more clients", and the column starts holding whatever a caller
 * typed.
 *
 * So the cases below are mostly REFUSALS, and each one is a shape a real client
 * produces: the header omitted, sent twice, sent empty, or sent as an id from a
 * system that does not use uuids.
 * =============================================================================
 */

/** Just enough of a request. The function reads exactly one header. */
function requestWith(value: unknown): FastifyRequest {
  return { headers: { [VISIT_ID_HEADER]: value } } as unknown as FastifyRequest;
}

const VISIT = '018f4b2c-9d3a-7c21-8f6e-1a2b3c4d5e6f';

describe('readVisitId', () => {
  it('returns a well-formed uuid', () => {
    expect(readVisitId(requestWith(VISIT))).toBe(VISIT);
  });

  it('normalises case, so one visit is one string in the column', () => {
    // Two requests in the same visit that differ only in case would otherwise
    // group as two visits, which is the one thing this column exists to get
    // right.
    expect(readVisitId(requestWith(VISIT.toUpperCase()))).toBe(VISIT);
  });

  it('accepts a v4 as readily as a v7', () => {
    // The client mints v4 today. The pattern is deliberately not version-pinned
    // so that changing that is not a silent rejection of every id.
    const v4 = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
    expect(readVisitId(requestWith(v4))).toBe(v4);
  });

  it('returns null when the header is absent', () => {
    expect(readVisitId({ headers: {} } as unknown as FastifyRequest)).toBeNull();
  });

  it('returns null when the header is sent twice', () => {
    // Fastify hands back an array for a repeated header. A request that names
    // two visits names none — picking the first would be a guess that reads as
    // a fact once it is in the database.
    expect(readVisitId(requestWith([VISIT, VISIT]))).toBeNull();
  });

  it('returns null for an empty header', () => {
    expect(readVisitId(requestWith(''))).toBeNull();
  });

  it.each([
    ['not a uuid at all', 'visit-42'],
    ['a uuid with the dashes stripped', VISIT.replaceAll('-', '')],
    ['a uuid with trailing text', `${VISIT} `],
    ['a uuid with a non-hex character', VISIT.replace('a', 'z')],
    ['something that wants to be SQL', `' OR 1=1 --`],
  ])('returns null for %s', (_label, value) => {
    expect(readVisitId(requestWith(value))).toBeNull();
  });
});
