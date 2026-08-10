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
import { REQUEST_ID_HEADER } from '../plugins/request-id';

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
