import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiRequest } from '../client';
import { currentVisitId } from '../visit-id';

/**
 * =============================================================================
 * D-401 — ONE ID PER OPEN OF THE APP, AND THE ONE PLACE IT IS SENT.
 *
 * Two properties, and the second is the one that would rot quietly:
 *
 *  1. The id is STABLE for the life of the tab. If it were re-minted per call,
 *     every request would be its own "visit" and the column would be noise that
 *     looks like data.
 *
 *  2. It rides ONLY on requests that already carry a body. A custom header is
 *     not CORS-simple, so putting it on the bodyless GETs — most of the app's
 *     traffic, currently preflight-free — would add an OPTIONS round trip to
 *     every read in the product to label a request that starts nothing.
 *
 * Property 2 has no symptom. Nothing breaks, no test fails, the app just gets
 * slower everywhere. It is pinned here because that is the only way it stays
 * true.
 * =============================================================================
 */

const KEY = 'foxxy.visitId';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fetchMock = vi.fn();

beforeEach(() => {
  window.sessionStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve({ ok: true }),
  } as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The headers the client actually sent on the most recent call. */
function sentHeaders(): Record<string, string> {
  return (fetchMock.mock.calls.at(-1)?.[1] as { headers: Record<string, string> }).headers;
}

const schema = z.object({ ok: z.boolean() });

describe('currentVisitId', () => {
  it('mints a uuid on first call', () => {
    expect(currentVisitId()).toMatch(UUID);
  });

  it('returns the same id for the life of the tab', () => {
    // A reload keeps `sessionStorage`, and the student never left — so the
    // second call must not open a second visit.
    expect(currentVisitId()).toBe(currentVisitId());
  });

  it('persists it where a reload can find it, and nowhere longer-lived', () => {
    const minted = currentVisitId();
    expect(window.sessionStorage.getItem(KEY)).toBe(minted);
    // NOT localStorage: that survives the tab, so every visit for the rest of
    // the device's life would share one id, which is precisely the bug.
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('returns null rather than throwing when storage is unavailable', () => {
    // Safari private mode throws on write; some webviews block storage outright.
    // A correlation label must never be the reason a screen fails to load.
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('SecurityError');
      });
    try {
      expect(currentVisitId()).toBeNull();
    } finally {
      getItem.mockRestore();
    }
  });
});

describe('apiRequest sends the visit id', () => {
  it('on a request with a body', async () => {
    await apiRequest({ path: '/practice/sessions', method: 'POST', body: {}, schema });

    const headers = sentHeaders();
    expect(headers['x-visit-id']).toBe(window.sessionStorage.getItem(KEY));
    expect(headers['content-type']).toBe('application/json');
  });

  it('and NOT on a bodyless GET — see property 2 in the header', async () => {
    await apiRequest({ path: '/practice/mission', schema });
    expect(sentHeaders()).toEqual({});
  });

  it('omitting the header entirely when no id could be minted', async () => {
    // Absent and "present but blank" would be the same fact wearing two shapes,
    // and the server would have to know about both.
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      await apiRequest({ path: '/practice/sessions', method: 'POST', body: {}, schema });
      expect(sentHeaders()).toEqual({ 'content-type': 'application/json' });
    } finally {
      getItem.mockRestore();
    }
  });
});
