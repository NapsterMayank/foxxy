import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiRequest, toApiError } from '../client';
import { ApiError } from '../errors';

/**
 * THE TYPED CLIENT — plan §5.2.
 *
 * Four properties must hold of EVERY request, and each one fails invisibly:
 * a missing `credentials` presents as "randomly logged out", an unvalidated
 * response as `undefined` three components deep, an untyped error as a screen
 * with no treatment, and a swallowed abort as a cancelled request rendered as
 * a failed one.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers ?? {}),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const okSchema = z.object({ status: z.literal('ok') });

describe('the shape of every request', () => {
  it('prefixes the base URL and the version, and sends credentials', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'ok' }));

    await apiRequest({ path: '/auth/me', schema: okSchema });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/auth/me');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('GET');
  });

  it('sends a JSON body with its content type, and only when there is one', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'ok' }));

    await apiRequest({ path: '/auth/login', method: 'POST', body: { a: 1 }, schema: okSchema });
    const withBody = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(withBody.body).toBe('{"a":1}');
    // `content-type` and the D-401 visit id, which rides along on exactly the
    // requests that already carry a body. `objectContaining` rather than an
    // exact match so this assertion stays about the CONTENT TYPE — the visit
    // header has its own suite in `visit-id.test.ts`.
    expect(withBody.headers).toEqual(
      expect.objectContaining({ 'content-type': 'application/json' }),
    );

    fetchMock.mockClear();
    await apiRequest({ path: '/auth/logout', method: 'POST', schema: okSchema });
    const withoutBody = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(withoutBody.body).toBeUndefined();
    // No content type on a bodiless request: some proxies reject a declared
    // JSON body that is not there.
    expect(withoutBody.headers).toEqual({});
  });

  it('passes an abort signal through', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'ok' }));
    const controller = new AbortController();

    await apiRequest({ path: '/auth/me', schema: okSchema, signal: controller.signal });

    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);
  });
});

describe('responses are validated against the contract', () => {
  it('returns the parsed value on a match', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'ok', extra: 'ignored' }));
    await expect(apiRequest({ path: '/x', schema: okSchema })).resolves.toEqual({ status: 'ok' });
  });

  it('throws a typed error naming the offending field on a mismatch', async () => {
    // A 200 whose SHAPE is wrong. Loud on purpose: the alternative is the value
    // flowing on as `undefined` and failing somewhere unrelated to the cause.
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'not-ok' }));

    await expect(apiRequest({ path: '/x', schema: okSchema })).rejects.toThrow(/did not match/);
    await expect(apiRequest({ path: '/x', schema: okSchema })).rejects.toMatchObject({
      code: 'UNKNOWN',
    });
  });

  it('validates a bodiless 204 rather than assuming null is acceptable', async () => {
    fetchMock.mockResolvedValue(jsonResponse(204, undefined));

    await expect(apiRequest({ path: '/x', schema: z.null() })).resolves.toBeNull();
    // A schema that does not accept null means the endpoint promised a body.
    await expect(apiRequest({ path: '/x', schema: okSchema })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('failures become typed errors', () => {
  it('carries the backend code, message and reason', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: { code: 'FORBIDDEN', message: 'Forbidden.', reason: 'EMAIL_NOT_VERIFIED' },
      }),
    );

    const error = await apiRequest({ path: '/auth/login', method: 'POST', schema: okSchema }).catch(
      (thrown: unknown) => thrown as ApiError,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      reason: 'EMAIL_NOT_VERIFIED',
      method: 'POST',
    });
  });

  it('reads Retry-After when it is a number, and ignores it when it is not', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many.' } }, {
        'retry-after': '30',
      }),
    );
    await expect(apiRequest({ path: '/x', schema: okSchema })).rejects.toMatchObject({
      retryAfterSeconds: 30,
    });

    fetchMock.mockResolvedValue(
      jsonResponse(429, { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many.' } }, {
        // The HTTP-date form. Not read — a wrong countdown is worse than none.
        'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT',
      }),
    );
    await expect(apiRequest({ path: '/x', schema: okSchema })).rejects.toMatchObject({
      retryAfterSeconds: null,
    });
  });

  it('degrades a non-JSON error body to UNKNOWN instead of throwing', async () => {
    // A proxy's own HTML error page, or an empty body from a dropped upstream.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers(),
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as unknown as Response);

    await expect(apiRequest({ path: '/x', schema: okSchema })).rejects.toMatchObject({
      status: 502,
      code: 'UNKNOWN',
    });
  });

  it('degrades a JSON body that is not the error envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { oops: true }));

    await expect(apiRequest({ path: '/x', schema: okSchema })).rejects.toMatchObject({
      code: 'UNKNOWN',
    });
  });

  it('maps an unrecognised backend code to UNKNOWN rather than trusting it', async () => {
    // A code from a newer deployment than this bundle. §5.6 treats it
    // generically; what must not happen is it reaching the treatment switch as
    // a value the type system believes impossible.
    fetchMock.mockResolvedValue(jsonResponse(418, { error: { code: 'TEAPOT', message: 'no' } }));

    await expect(apiRequest({ path: '/x', schema: okSchema })).rejects.toMatchObject({
      code: 'UNKNOWN',
    });
  });

  it('turns a transport failure into a typed error with status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(apiRequest({ path: '/x', schema: okSchema })).rejects.toMatchObject({
      status: 0,
      code: 'UNKNOWN',
    });
  });

  it('re-throws an abort UNCHANGED', async () => {
    /*
     * TanStack Query and the streaming client both recognise `AbortError`. Wrap
     * it in an ApiError and a cancelled request renders as a failed one.
     */
    fetchMock.mockRejectedValue(new DOMException('The user aborted a request.', 'AbortError'));

    await expect(apiRequest({ path: '/x', schema: okSchema })).rejects.toBeInstanceOf(DOMException);
  });
});

describe('toApiError is shared with the streaming client', () => {
  it('produces the same typed error outside apiRequest', async () => {
    const error = await toApiError(
      jsonResponse(429, { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many.' } }),
      'POST',
    );

    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMIT_EXCEEDED', method: 'POST' });
  });
});
