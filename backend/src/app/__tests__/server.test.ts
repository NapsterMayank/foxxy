import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
// Imported from load-config, not from the barrel: importing the barrel reads
// the real process environment and exits the process when it is incomplete.
// That eager check is the point of platform/config — it just means tests use
// the pure parser instead.
import { parseConfig } from '../../platform/config/load-config';
import { FixedClock } from '../../platform/clock/index';
import { CounterIdGen } from '../../platform/id-gen/index';
import { FakeLogger } from '../../platform/logger/index';
import { MemoryCache } from '../../platform/cache/index';
import { RecordingMail } from '../../platform/mail/index';
import { createContainer, type Container } from '../container';
import { createServer } from '../server';
import {
  REQUEST_ID_HEADER,
  MAX_REQUEST_ID_LENGTH,
  isAcceptableRequestId,
} from '../plugins/request-id';

const CONFIG = parseConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://foxxy:pw@localhost:5432/foxxy',
  REDIS_URL: 'redis://localhost:6379',
  CORS_READ_ORIGINS: 'http://localhost:3000',
  CORS_WRITE_ORIGINS: 'http://localhost:3000',
  SESSION_COOKIE_NAME: 'foxxy_session',
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:4000',
});

let container: Container;
let app: FastifyInstance;
let clock: FixedClock;

beforeEach(async () => {
  clock = new FixedClock('2026-02-03T04:05:06.000Z');
  container = createContainer(CONFIG, {
    clock,
    idGen: new CounterIdGen(),
    logger: new FakeLogger(),
    cache: new MemoryCache(clock),
    mail: new RecordingMail(),
  });
  app = await createServer(container);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await container.shutdown();
});

describe('GET /health', () => {
  it('returns 200', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });

  it('reports the environment and the injected clock', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.json()).toEqual({
      status: 'ok',
      env: 'test',
      time: '2026-02-03T04:05:06.000Z',
    });
  });

  it('does not require the database or the cache to be reachable', async () => {
    // The container above points at a database that is not running.
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });
});

describe('request id', () => {
  it('generates one and echoes it on the response', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers[REQUEST_ID_HEADER]).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('reuses an inbound request id from a proxy', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { [REQUEST_ID_HEADER]: 'upstream-42' },
    });
    expect(response.headers[REQUEST_ID_HEADER]).toBe('upstream-42');
  });

  /**
   * =======================================================================
   * D-266 — AN INBOUND REQUEST ID IS BOUNDED AND CHARACTER-CHECKED.
   *
   * It used to be taken verbatim with no limit of any kind, then bound into
   * the child logger for the request and echoed back on the response. It is
   * the one caller-controlled value that reaches EVERY log line a request
   * produces, which makes an 8 kB header a log-volume multiplier a caller
   * chooses, and a newline in it a log-injection primitive.
   *
   * Nothing failed while that was true, which is why it needed a test rather
   * than a bug report.
   * =======================================================================
   */
  it('REPLACES an over-long inbound id rather than logging 8 kB per line', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { [REQUEST_ID_HEADER]: 'x'.repeat(MAX_REQUEST_ID_LENGTH + 1) },
    });

    // Replaced, not refused: a broken upstream proxy must not be able to take
    // the API down over a correlation identifier.
    expect(response.statusCode).toBe(200);
    expect(response.headers[REQUEST_ID_HEADER]).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('accepts an id EXACTLY at the cap — the boundary is inclusive', async () => {
    const atCap = 'a'.repeat(MAX_REQUEST_ID_LENGTH);
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { [REQUEST_ID_HEADER]: atCap },
    });
    expect(response.headers[REQUEST_ID_HEADER]).toBe(atCap);
  });

  it.each([
    ['a newline — breaks line-oriented log shipping', 'abc\ndef'],
    ['a forged JSON log fragment', '1","level":"error","msg":"forged'],
    ['a carriage return — header injection on echo', 'abc\rdef'],
    ['an empty value', ''],
  ])('REPLACES an inbound id containing %s', async (_label, value) => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { [REQUEST_ID_HEADER]: value },
    });
    const echoed = response.headers[REQUEST_ID_HEADER];
    expect(echoed).not.toBe(value);
    expect(echoed).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('accepts the identifier formats real tracing actually emits', () => {
    // The allowlist has to be wide enough that this cap never silently breaks
    // correlation for a proxy that was doing everything right.
    expect(isAcceptableRequestId('00000000-0000-4000-8000-000000000001')).toBe(true); // UUID
    expect(isAcceptableRequestId('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBe(
      true,
    ); // W3C traceparent
    expect(isAcceptableRequestId('req_1a2b3c.4d5e')).toBe(true);
    expect(isAcceptableRequestId('svc:edge@1+2')).toBe(true);
  });

  it('binds the request id to the per-request logger', async () => {
    await app.inject({ method: 'GET', url: '/health' });
    const logger = container.logger as FakeLogger;
    expect(logger.lines.at(-1)?.bindings).toMatchObject({
      requestId: '00000000-0000-4000-8000-000000000001',
      method: 'GET',
      url: '/health',
    });
  });
});

describe('the error handler', () => {
  it('renders an unmatched route as a typed 404, not an HTML page', async () => {
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });

  it('converts an unexpected throw into a generic 500 with no internals', async () => {
    // Its own instance: a route cannot be added after the root has booted.
    const boomApp = await createServer(container);
    boomApp.get('/boom', () => {
      throw new Error('connection pool exhausted at pool.ts:41');
    });
    const response = await boomApp.inject({ method: 'GET', url: '/boom' });
    await boomApp.close();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
    });
    expect(response.body).not.toContain('pool.ts');
  });
});

describe('CORS', () => {
  it('allows the configured origin with credentials', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not reflect an origin that is not on the allow-list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://evil.test' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
