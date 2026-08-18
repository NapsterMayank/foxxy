import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMyProfile, updateMyProfile } from '../api/profile-requests';

/**
 * ===========================================================================
 * THE PROFILE WIRE CALLS.
 *
 * Two assertions carry weight here and the rest is plumbing:
 *
 *  1. THE PATCH SENDS ONLY WHAT IT WAS GIVEN. A form that posted every field
 *     on every save would rewrite a grade nobody touched, and the write would
 *     look identical in the log to one the student meant.
 *  2. AN EMPTY UPDATE NEVER REACHES THE NETWORK. The contract refuses it with
 *     a 400; sending it anyway spends a round trip to be told what the schema
 *     already knew, and reports it to the student as a server error.
 * ===========================================================================
 */

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const profile = {
  userId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Aarav',
  grade: '10',
  board: 'CBSE',
  preferredLanguage: 'en',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-12T09:00:00.000Z',
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getMyProfile', () => {
  it('reads /me/profile and returns the parsed profile', async () => {
    fetchMock.mockResolvedValueOnce(json({ profile }));

    await expect(getMyProfile()).resolves.toEqual({ profile });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/me/profile');
    expect(init.method).toBe('GET');
    // Cookie session — the single most consequential option on the request.
    expect(init.credentials).toBe('include');
  });
});

describe('updateMyProfile', () => {
  it('PATCHes only the fields it was given', async () => {
    fetchMock.mockResolvedValueOnce(json({ profile: { ...profile, displayName: 'Aarav K' } }));

    await updateMyProfile({ displayName: 'Aarav K' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/me/profile');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ displayName: 'Aarav K' });
  });

  it('refuses an empty update without calling the network', async () => {
    await expect(updateMyProfile({})).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a grade the syllabus does not have', async () => {
    await expect(updateMyProfile({ grade: '13' } as never)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
