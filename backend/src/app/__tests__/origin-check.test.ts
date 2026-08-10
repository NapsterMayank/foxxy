import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseConfig } from '../../platform/config/load-config';
import { FixedClock } from '../../platform/clock/index';
import { CounterIdGen } from '../../platform/id-gen/index';
import { FakeLogger } from '../../platform/logger/index';
import { MemoryCache } from '../../platform/cache/index';
import { RecordingMail } from '../../platform/mail/index';
import { createContainer, type Container } from '../container';
import { createServer } from '../server';
import { originOfRequest, WEBHOOK_PATH_PATTERN } from '../plugins/origin-check';

/**
 * The origin check — §6.10, "cross-site request forgery: sameSite=lax plus an
 * origin check on state-changing requests".
 *
 * `sameSite` is deliberately `lax` so that the emailed verification link
 * arrives authenticated, which means the session cookie IS sent on a top-level
 * cross-site request. This check is what stands between that and a forged
 * `<form>` POST from another site.
 */

const CONFIG = parseConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://foxxy:pw@localhost:5432/foxxy',
  REDIS_URL: 'redis://localhost:6379',
  // Two allowed origins that are NOT the same value, so the tests can tell
  // "read from config" apart from "happens to match APP_URL".
  CORS_READ_ORIGINS: 'http://localhost:3000',
  CORS_WRITE_ORIGINS: 'http://localhost:3000',
  SESSION_COOKIE_NAME: 'foxxy_session',
  APP_URL: 'https://app.foxxy.test',
  API_URL: 'https://api.foxxy.test',
});

const ALLOWED_APP_ORIGIN = 'https://app.foxxy.test';
const ALLOWED_CORS_ORIGIN = 'http://localhost:3000';
const FOREIGN_ORIGIN = 'https://evil.test';

let container: Container;
let app: FastifyInstance;
/** Set by the test routes — proves whether a handler was reached at all. */
let handlerRuns: number;

beforeEach(async () => {
  handlerRuns = 0;
  const clock = new FixedClock('2026-02-03T04:05:06.000Z');
  container = createContainer(CONFIG, {
    clock,
    idGen: new CounterIdGen(),
    logger: new FakeLogger(),
    cache: new MemoryCache(clock),
    mail: new RecordingMail(),
  });
  app = await createServer(container);

  for (const method of ['post', 'put', 'patch', 'delete'] as const) {
    app[method]('/api/v1/things', () => {
      handlerRuns += 1;
      return { status: 'ok' };
    });
  }
  app.get('/api/v1/things', () => {
    handlerRuns += 1;
    return { status: 'ok' };
  });
  app.post('/api/v1/webhooks/razorpay', () => {
    handlerRuns += 1;
    return { status: 'ok' };
  });

  await app.ready();
});

afterEach(async () => {
  await app.close();
  await container.shutdown();
});

describe('a state-changing request with NO Origin', () => {
  it('is REJECTED with a 403', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/things', payload: {} });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Forbidden.' } });
  });

  it('never reaches the route handler', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/things', payload: {} });
    expect(handlerRuns).toBe(0);
  });

  it('rejects the literal string "null", which a sandboxed frame sends', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things',
      headers: { origin: 'null' },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('a state-changing request from a FOREIGN Origin', () => {
  it('is REJECTED with a 403', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things',
      headers: { origin: FOREIGN_ORIGIN },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(handlerRuns).toBe(0);
  });

  it('rejects a foreign Referer just as firmly', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things',
      headers: { referer: `${FOREIGN_ORIGIN}/some/page` },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });

  it('does not echo the attacker-supplied origin into the response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things',
      headers: { origin: FOREIGN_ORIGIN },
      payload: {},
    });
    expect(response.body).not.toContain('evil.test');
  });
});

describe('a state-changing request from an ALLOWED origin', () => {
  it('SUCCEEDS from APP_URL', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things',
      headers: { origin: ALLOWED_APP_ORIGIN },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(handlerRuns).toBe(1);
  });

  it('succeeds from an origin on the CORS allow-list', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things',
      headers: { origin: ALLOWED_CORS_ORIGIN },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
  });

  it('accepts a Referer when the Origin header is absent', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things',
      headers: { referer: `${ALLOWED_APP_ORIGIN}/dashboard` },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
  });

  it('tolerates a trailing slash on the origin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things',
      headers: { origin: `${ALLOWED_APP_ORIGIN}/` },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
  });

  it.each(['PUT', 'PATCH', 'DELETE'] as const)('applies to %s as well as POST', async (method) => {
    const denied = await app.inject({ method, url: '/api/v1/things', payload: {} });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method,
      url: '/api/v1/things',
      headers: { origin: ALLOWED_APP_ORIGIN },
      payload: {},
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe('GET is unaffected', () => {
  it('succeeds with no Origin at all', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/things' });

    expect(response.statusCode).toBe(200);
    expect(handlerRuns).toBe(1);
  });

  it('succeeds even from a foreign origin — CORS governs what may be READ', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/things',
      headers: { origin: FOREIGN_ORIGIN },
    });
    expect(response.statusCode).toBe(200);
  });

  it('leaves the health probes reachable, which have no origin ever', async () => {
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });
});

describe('THE WEBHOOK EXEMPTION', () => {
  it('lets a provider POST with no Origin at all', async () => {
    // A payment provider posts server-to-server; there is no browser and no
    // Origin header. The compensating control is HMAC signature verification
    // inside the route — strictly stronger than an origin hint.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/razorpay',
      payload: { event: 'subscription.activated' },
    });

    expect(response.statusCode).toBe(200);
    expect(handlerRuns).toBe(1);
  });

  it('is a narrow prefix, not a wildcard', () => {
    expect(WEBHOOK_PATH_PATTERN.test('/api/v1/webhooks/razorpay')).toBe(true);
    expect(WEBHOOK_PATH_PATTERN.test('/api/v2/webhooks/anything')).toBe(true);

    // Everything that merely LOOKS like it should be exempt is not.
    expect(WEBHOOK_PATH_PATTERN.test('/api/v1/webhooks')).toBe(false);
    expect(WEBHOOK_PATH_PATTERN.test('/api/v1/auth/login')).toBe(false);
    expect(WEBHOOK_PATH_PATTERN.test('/webhooks/razorpay')).toBe(false);
    expect(WEBHOOK_PATH_PATTERN.test('/evil/api/v1/webhooks/razorpay')).toBe(false);
  });

  it('does not exempt a path that merely has the prefix in its query string', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things?next=/api/v1/webhooks/razorpay',
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('originOfRequest', () => {
  it('prefers the Origin header', () => {
    expect(originOfRequest({ origin: 'https://a.test', referer: 'https://b.test/x' })).toBe(
      'https://a.test',
    );
  });

  it('falls back to the origin part of the Referer', () => {
    expect(originOfRequest({ referer: 'https://b.test/deep/path?q=1' })).toBe('https://b.test');
  });

  it('returns null when neither header is present', () => {
    expect(originOfRequest({})).toBeNull();
  });

  it('returns null for an empty Origin', () => {
    expect(originOfRequest({ origin: '' })).toBeNull();
  });

  it('returns null for a Referer that is not a URL', () => {
    expect(originOfRequest({ referer: 'not a url' })).toBeNull();
  });

  it('takes the first value when a header arrives more than once', () => {
    expect(originOfRequest({ origin: ['https://a.test', 'https://evil.test'] })).toBe(
      'https://a.test',
    );
  });
});
