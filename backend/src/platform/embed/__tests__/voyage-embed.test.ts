import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '../../../shared/constants/curriculum';
import { DependencyError, ValidationError } from '../../errors/index';
import type { HttpClient, HttpRequest, HttpResponse } from '../../http/index';
import { VOYAGE_MODEL, createVoyageEmbed } from '../voyage-embed';

/**
 * THE REAL ADAPTER, FULLY TESTED, WITH NO API KEY AND NO NETWORK.
 *
 * Every test here drives a recording `HttpClient`. Nothing in this file can
 * reach `api.voyageai.com`; if it ever could, the suite would start costing
 * money and would fail on a machine with no key — which is the state of every
 * machine today.
 */

interface Recorded {
  readonly requests: HttpRequest[];
}

function fakeHttp(
  respond: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): HttpClient & Recorded {
  const requests: HttpRequest[] = [];
  return {
    requests,
    async request(req: HttpRequest): Promise<HttpResponse> {
      requests.push(req);
      return await respond(req);
    },
  };
}

function okBody(dimensions = EMBEDDING_DIMENSIONS): string {
  return JSON.stringify({
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: unitVector(dimensions) }],
    model: VOYAGE_MODEL,
    usage: { total_tokens: 7 },
  });
}

function unitVector(dimensions: number): number[] {
  const value = 1 / Math.sqrt(dimensions);
  return new Array<number>(dimensions).fill(value);
}

const ok = (): HttpResponse => ({ status: 200, headers: {}, body: okBody() });

describe('the Voyage embedding adapter', () => {
  it('returns the 1024-dimension vector from a well-formed response', async () => {
    const http = fakeHttp(ok);
    const embed = createVoyageEmbed({ http, apiKey: 'test-key' });

    const vector = await embed.embedQuery('what is refraction');

    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(embed.model).toBe(VOYAGE_MODEL);
    expect(embed.dimensions).toBe(EMBEDDING_DIMENSIONS);
  });

  it('posts to /embeddings with the model and the query input type', async () => {
    const http = fakeHttp(ok);
    await createVoyageEmbed({ http, apiKey: 'test-key', baseUrl: 'https://voyage.test/v1/' })
      .embedQuery('what is refraction');

    const request = http.requests[0];
    expect(request?.method).toBe('POST');
    // The trailing slash on baseUrl is stripped — a doubled slash is a 404 on
    // some gateways and a silent redirect on others.
    expect(request?.url).toBe('https://voyage.test/v1/embeddings');
    expect(request?.body).toEqual({
      input: ['what is refraction'],
      model: VOYAGE_MODEL,
      input_type: 'query',
    });
  });

  it('sends the key as a bearer token', async () => {
    const http = fakeHttp(ok);
    await createVoyageEmbed({ http, apiKey: 'sk-abc' }).embedQuery('x');

    expect(http.requests[0]?.headers?.authorization).toBe('Bearer sk-abc');
  });

  it('marks the POST idempotent, so the retry budget is not silently zero', async () => {
    // `platform/http` derives idempotency from the METHOD and refuses to retry
    // a POST. Correct for a payment; wrong for embedding a string, which has
    // no side effect. Without this flag a single 503 becomes a failed answer.
    const http = fakeHttp(ok);
    await createVoyageEmbed({ http, apiKey: 'k' }).embedQuery('x');

    expect(http.requests[0]?.idempotent).toBe(true);
  });

  it('refuses to be constructed without a key, at BOOT rather than at first use', () => {
    const http = fakeHttp(ok);

    expect(() => createVoyageEmbed({ http, apiKey: '  ' })).toThrow(ValidationError);
  });

  it('refuses empty text rather than spending a call on it', async () => {
    const http = fakeHttp(ok);
    const embed = createVoyageEmbed({ http, apiKey: 'k' });

    await expect(embed.embedQuery('')).rejects.toBeInstanceOf(ValidationError);
    expect(http.requests).toHaveLength(0);
  });

  describe('every failure is a DependencyError, never a silent vector', () => {
    it('on a non-2xx status', async () => {
      const http = fakeHttp(() => ({ status: 401, headers: {}, body: 'unauthorized' }));

      await expect(createVoyageEmbed({ http, apiKey: 'k' }).embedQuery('x')).rejects.toBeInstanceOf(
        DependencyError,
      );
    });

    it('and the error carries the STATUS, never the body', async () => {
      // Some providers echo the submitted key back inside an auth error.
      const http = fakeHttp(() => ({
        status: 401,
        headers: {},
        body: 'invalid api key: sk-secret-value',
      }));

      await expect(
        createVoyageEmbed({ http, apiKey: 'sk-secret-value' }).embedQuery('x'),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DependencyError &&
          !JSON.stringify(error.details ?? {}).includes('sk-secret-value') &&
          !error.message.includes('sk-secret-value'),
      );
    });

    it('on a body that is not JSON', async () => {
      const http = fakeHttp(() => ({ status: 200, headers: {}, body: '<html>gateway</html>' }));

      await expect(createVoyageEmbed({ http, apiKey: 'k' }).embedQuery('x')).rejects.toBeInstanceOf(
        DependencyError,
      );
    });

    it('on a response with no data field', async () => {
      const http = fakeHttp(() => ({ status: 200, headers: {}, body: '{"model":"voyage-3"}' }));

      await expect(createVoyageEmbed({ http, apiKey: 'k' }).embedQuery('x')).rejects.toBeInstanceOf(
        DependencyError,
      );
    });

    it('on an empty data array', async () => {
      const http = fakeHttp(() => ({ status: 200, headers: {}, body: '{"data":[]}' }));

      await expect(createVoyageEmbed({ http, apiKey: 'k' }).embedQuery('x')).rejects.toBeInstanceOf(
        DependencyError,
      );
    });

    it('on an embedding that is not an array of numbers', async () => {
      const http = fakeHttp(() => ({
        status: 200,
        headers: {},
        body: '{"data":[{"embedding":["a","b"]}]}',
      }));

      await expect(createVoyageEmbed({ http, apiKey: 'k' }).embedQuery('x')).rejects.toBeInstanceOf(
        DependencyError,
      );
    });

    it('on the WRONG WIDTH — the one that would otherwise be silent', async () => {
      /**
       * The failure this whole file is built around. A 512-dimension vector is
       * a perfectly good vector in a DIFFERENT SPACE. pgvector would reject it
       * at the column, but only because the column is typed; if it were not,
       * every cosine distance would still compute and every answer would be
       * confidently wrong.
       */
      const http = fakeHttp(() => ({ status: 200, headers: {}, body: okBody(512) }));

      await expect(createVoyageEmbed({ http, apiKey: 'k' }).embedQuery('x')).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DependencyError && JSON.stringify(error.details) === '{"got":512,"expected":1024}',
      );
    });

    it('on a non-finite component, which Postgres turns into NULL distances', async () => {
      /**
       * The body is assembled as a STRING rather than through
       * `JSON.stringify`, and that detail is the test. `JSON.stringify` maps a
       * non-finite number to `null`, which would be caught one branch earlier
       * by the "array of numbers" check — so the stringified version would
       * pass while measuring something else entirely. `JSON.parse` of the
       * literal `1e400`, on the other hand, yields `Infinity`, which is
       * exactly what a provider overflowing a float sends on the wire.
       */
      const components = new Array<string>(EMBEDDING_DIMENSIONS).fill('0.01');
      components[EMBEDDING_DIMENSIONS - 1] = '1e400';
      const http = fakeHttp(() => ({
        status: 200,
        headers: {},
        body: `{"data":[{"embedding":[${components.join(',')}]}]}`,
      }));

      await expect(createVoyageEmbed({ http, apiKey: 'k' }).embedQuery('x')).rejects.toBeInstanceOf(
        DependencyError,
      );
    });

    it('when the transport itself fails', async () => {
      const http = fakeHttp(() => {
        throw new DependencyError('http', { message: 'connection reset' });
      });

      await expect(createVoyageEmbed({ http, apiKey: 'k' }).embedQuery('x')).rejects.toBeInstanceOf(
        DependencyError,
      );
    });
  });
});
