import { describe, expect, it } from 'vitest';
import { DependencyError } from '../../errors/index';
import { backoffMs, createHttpClient, isRetryableStatus } from '../http-client';

/**
 * Builds a fetch stand-in that replays a scripted list of outcomes.
 *
 * Each outcome is a FACTORY, not a Response: a Response body can only be read
 * once, so replaying the same instance across retries fails for a reason that
 * has nothing to do with the code under test.
 */
type Outcome = () => Response | Error;

const ok =
  (body: string, init?: ResponseInit): Outcome =>
  () =>
    new Response(body, init);
const fails =
  (message: string): Outcome =>
  () =>
    new Error(message);

function scriptedFetch(outcomes: Outcome[]): {
  fetchImpl: typeof fetch;
  calls: number;
} {
  const state = { calls: 0 };
  const fetchImpl = ((): Promise<Response> => {
    const outcome = outcomes[Math.min(state.calls, outcomes.length - 1)];
    state.calls += 1;
    const value = outcome?.();
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value!);
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    get calls(): number {
      return state.calls;
    },
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('isRetryableStatus', () => {
  it.each([500, 502, 503, 599, 429])('retries on %i', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([200, 201, 301, 400, 401, 403, 404, 409, 499])('does not retry on %i', (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});

describe('backoffMs', () => {
  it('doubles from 100ms and caps at 2s', () => {
    expect(backoffMs(0)).toBe(100);
    expect(backoffMs(1)).toBe(200);
    expect(backoffMs(2)).toBe(400);
    expect(backoffMs(10)).toBe(2000);
  });
});

describe('createHttpClient', () => {
  it('returns the response on a first-attempt success', async () => {
    const script = scriptedFetch([ok('{"ok":true}', { status: 200 })]);
    const client = createHttpClient({
      timeoutMs: 1000,
      maxRetries: 2,
      fetchImpl: script.fetchImpl,
      sleep: noSleep,
    });
    const response = await client.request({ method: 'GET', url: 'https://example.test/x' });
    expect(response.status).toBe(200);
    expect(response.body).toBe('{"ok":true}');
    expect(script.calls).toBe(1);
  });

  it('exposes response headers', async () => {
    const script = scriptedFetch([ok('ok', { status: 200, headers: { 'x-trace': 'abc' } })]);
    const client = createHttpClient({
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: script.fetchImpl,
      sleep: noSleep,
    });
    const response = await client.request({ method: 'GET', url: 'https://example.test/x' });
    expect(response.headers['x-trace']).toBe('abc');
  });

  it('does not retry a 400 — that is our fault and will not change', async () => {
    const script = scriptedFetch([ok('bad', { status: 400 })]);
    const client = createHttpClient({
      timeoutMs: 1000,
      maxRetries: 3,
      fetchImpl: script.fetchImpl,
      sleep: noSleep,
    });
    const response = await client.request({ method: 'GET', url: 'https://example.test/x' });
    expect(response.status).toBe(400);
    expect(script.calls).toBe(1);
  });

  it('retries a 503 and succeeds on the second attempt', async () => {
    const script = scriptedFetch([ok('down', { status: 503 }), ok('up', { status: 200 })]);
    const client = createHttpClient({
      timeoutMs: 1000,
      maxRetries: 2,
      fetchImpl: script.fetchImpl,
      sleep: noSleep,
    });
    const response = await client.request({ method: 'GET', url: 'https://example.test/x' });
    expect(response.status).toBe(200);
    expect(script.calls).toBe(2);
  });

  it('gives up after maxRetries and throws DependencyError', async () => {
    const script = scriptedFetch([fails('ECONNREFUSED')]);
    const client = createHttpClient({
      timeoutMs: 1000,
      maxRetries: 2,
      fetchImpl: script.fetchImpl,
      sleep: noSleep,
    });
    await expect(
      client.request({ method: 'GET', url: 'https://example.test/x' }),
    ).rejects.toBeInstanceOf(DependencyError);
    expect(script.calls).toBe(3);
  });

  it('returns the last retryable response rather than throwing when attempts run out', async () => {
    const script = scriptedFetch([ok('still down', { status: 503 })]);
    const client = createHttpClient({
      timeoutMs: 1000,
      maxRetries: 1,
      fetchImpl: script.fetchImpl,
      sleep: noSleep,
    });
    const response = await client.request({ method: 'GET', url: 'https://example.test/x' });
    expect(response.status).toBe(503);
    expect(script.calls).toBe(2);
  });

  it('makes exactly one attempt when maxRetries is 0', async () => {
    const script = scriptedFetch([fails('boom')]);
    const client = createHttpClient({
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: script.fetchImpl,
      sleep: noSleep,
    });
    await expect(
      client.request({ method: 'GET', url: 'https://example.test/x' }),
    ).rejects.toBeInstanceOf(DependencyError);
    expect(script.calls).toBe(1);
  });

  it('honours a per-request maxRetries override', async () => {
    const script = scriptedFetch([fails('boom')]);
    const client = createHttpClient({
      timeoutMs: 1000,
      maxRetries: 5,
      fetchImpl: script.fetchImpl,
      sleep: noSleep,
    });
    await expect(
      client.request({ method: 'GET', url: 'https://example.test/x', maxRetries: 1 }),
    ).rejects.toBeInstanceOf(DependencyError);
    expect(script.calls).toBe(2);
  });

  it('aborts a request that exceeds its timeout', async () => {
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      })) as unknown as typeof fetch;

    const client = createHttpClient({
      timeoutMs: 5,
      maxRetries: 0,
      fetchImpl: hangingFetch,
      sleep: noSleep,
    });

    await expect(
      client.request({ method: 'GET', url: 'https://example.test/slow' }),
    ).rejects.toBeInstanceOf(DependencyError);
  });

  it('serialises a JSON body and sets the content type', async () => {
    let seenInit: RequestInit | undefined;
    const capturingFetch = ((_url: string, init?: RequestInit): Promise<Response> => {
      seenInit = init;
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch;

    const client = createHttpClient({
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: capturingFetch,
      sleep: noSleep,
    });
    await client.request({
      method: 'POST',
      url: 'https://example.test/x',
      body: { grade: '7' },
      headers: { 'x-custom': '1' },
    });

    expect(seenInit?.body).toBe('{"grade":"7"}');
    expect(seenInit?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-custom': '1',
    });
  });

  it('sends no body and no content-type on a GET', async () => {
    let seenInit: RequestInit | undefined;
    const capturingFetch = ((_url: string, init?: RequestInit): Promise<Response> => {
      seenInit = init;
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch;

    const client = createHttpClient({
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: capturingFetch,
      sleep: noSleep,
    });
    await client.request({ method: 'GET', url: 'https://example.test/x' });

    expect(seenInit?.body).toBeUndefined();
    expect(seenInit?.headers).not.toMatchObject({ 'content-type': 'application/json' });
  });

  it('names the dependency but tells the client nothing specific', async () => {
    const script = scriptedFetch([fails('ECONNREFUSED 10.0.0.4:443')]);
    const client = createHttpClient({
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: script.fetchImpl,
      sleep: noSleep,
    });
    try {
      await client.request({ method: 'GET', url: 'https://example.test/x' });
      expect.unreachable('expected a DependencyError');
    } catch (error) {
      const dependencyError = error as DependencyError;
      expect(dependencyError.dependency).toBe('http');
      expect(dependencyError.safeMessage).not.toContain('10.0.0.4');
    }
  });
});
