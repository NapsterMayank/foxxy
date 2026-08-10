import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MemoryCache } from '../../platform/cache/index';
import { FixedClock } from '../../platform/clock/index';
import { parseConfig } from '../../platform/config/load-config';
import { CounterIdGen } from '../../platform/id-gen/index';
import { FakeLogger } from '../../platform/logger/index';
import { RecordingMail } from '../../platform/mail/index';
import { createContainer, type Container } from '../container';
import { createServer } from '../server';

/**
 * THE READ / WRITE ORIGIN SPLIT — open item 1.
 *
 * ===========================================================================
 * THE FAILURE THIS CLOSES.
 *
 * There used to be one `CORS_ORIGINS`, serving BOTH the CORS allow-list and the
 * CSRF origin check. So adding a partner origin — say, a school MIS that wants
 * to GET a read-only progress report — also granted that origin the right to
 * POST, PUT, PATCH and DELETE anything in the API. Silently, in a commit whose
 * diff was one line and whose title said "read integration".
 *
 * Nothing about that was visible: the person adding the origin had no way to
 * express the smaller grant, and no reviewer looking at a list of origins could
 * tell which entries were meant to be able to write.
 *
 * There are now two lists. CORS reads the wider one; the origin check reads the
 * narrower one. `platform/config` validates that write is a SUBSET of read at
 * boot, because an origin allowed to POST must be able to read the response to
 * its POST — a write-without-read grant is not a stricter policy, it is a broken
 * one.
 *
 * ===========================================================================
 * WHY THESE TESTS DRIVE REAL HTTP RATHER THAN INSPECTING CONFIG.
 *
 * The property is not "two lists exist in an object". It is "a read origin
 * cannot change anything", and that is a claim about which plugin consumes which
 * list — precisely the wiring that a rename or a copy-paste in `server.ts`
 * would get wrong while every config assertion still passed.
 */

const READ_ONLY_PARTNER = 'https://partner.test';
const FULL_ACCESS_ORIGIN = 'http://localhost:3000';
const APP_ORIGIN = 'https://app.foxxy.test';
const UNKNOWN_ORIGIN = 'https://evil.test';

const CONFIG = parseConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://foxxy:pw@localhost:5432/foxxy',
  REDIS_URL: 'redis://localhost:6379',
  // The partner is READABLE and NOT WRITABLE. That asymmetry is the whole point
  // of the file, so it is stated here rather than buried in a helper.
  CORS_READ_ORIGINS: `${FULL_ACCESS_ORIGIN},${READ_ONLY_PARTNER}`,
  CORS_WRITE_ORIGINS: FULL_ACCESS_ORIGIN,
  SESSION_COOKIE_NAME: 'foxxy_session',
  APP_URL: APP_ORIGIN,
  API_URL: 'https://api.foxxy.test',
});

let container: Container;
let app: FastifyInstance;
/** Proves whether a handler was reached at all, not merely which status came back. */
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

  app.get('/api/v1/things', () => {
    handlerRuns += 1;
    return { status: 'ok' };
  });
  app.post('/api/v1/things', () => {
    handlerRuns += 1;
    return { status: 'ok' };
  });
  for (const method of ['put', 'patch', 'delete'] as const) {
    app[method]('/api/v1/other', () => {
      handlerRuns += 1;
      return { status: 'ok' };
    });
  }
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

const get = (origin: string): Promise<{ statusCode: number; headers: Record<string, string | number | string[] | undefined> }> =>
  app.inject({ method: 'GET', url: '/api/v1/things', headers: { origin } });

const post = (origin: string): Promise<{ statusCode: number; headers: Record<string, string | number | string[] | undefined> }> =>
  app.inject({ method: 'POST', url: '/api/v1/things', headers: { origin } });

describe('an origin on the READ list but not the WRITE list', () => {
  it('CAN GET', async () => {
    const response = await get(READ_ONLY_PARTNER);

    expect(response.statusCode).toBe(200);
    expect(handlerRuns).toBe(1);
  });

  it('is given CORS headers on that GET, so the browser will surface the answer', async () => {
    // A 200 the browser then discards is not a working read integration. The
    // header is what makes the read grant real.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/things',
      headers: { origin: READ_ONLY_PARTNER },
    });

    expect(response.headers['access-control-allow-origin']).toBe(READ_ONLY_PARTNER);
  });

  it('CANNOT POST — 403, and the handler is never reached', async () => {
    // THE TEST THIS FILE EXISTS FOR. Under the single list, this was a 200.
    const response = await post(READ_ONLY_PARTNER);

    expect(response.statusCode).toBe(403);
    expect(handlerRuns).toBe(0);
  });

  it('cannot PUT, PATCH or DELETE either', async () => {
    // The grant is about STATE CHANGE, not about one verb. Checking only POST
    // would leave the obvious workaround untested.
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: '/api/v1/other',
        headers: { origin: READ_ONLY_PARTNER },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(handlerRuns).toBe(0);
  });
});

describe('an origin on BOTH lists', () => {
  it('can GET', async () => {
    const response = await get(FULL_ACCESS_ORIGIN);

    expect(response.statusCode).toBe(200);
    expect(handlerRuns).toBe(1);
  });

  it('can POST', async () => {
    const response = await post(FULL_ACCESS_ORIGIN);

    expect(response.statusCode).toBe(200);
    expect(handlerRuns).toBe(1);
  });

  it('APP_URL can write even though it is on neither list', async () => {
    // `server.ts` adds `APP_URL` to the write set explicitly: the browser
    // application must be able to post to its own API even if somebody trims the
    // allow-list. Without this, a well-meaning tidy-up of CORS_WRITE_ORIGINS
    // takes the product down.
    const response = await post(APP_ORIGIN);

    expect(response.statusCode).toBe(200);
    expect(handlerRuns).toBe(1);
  });
});

describe('an unknown origin', () => {
  it('cannot POST', async () => {
    const response = await post(UNKNOWN_ORIGIN);

    expect(response.statusCode).toBe(403);
    expect(handlerRuns).toBe(0);
  });

  it('reaches the GET handler but is given no CORS header, so the browser blocks it', async () => {
    /**
     * Worth stating precisely, because the status code alone reads as a leak.
     *
     * CORS is enforced by the BROWSER, not by the server: a request from an
     * unknown origin still arrives and is still answered, and the browser then
     * refuses to hand the response to the page because the header is absent.
     * That is how CORS has always worked, and it is why CORS is not an
     * authorisation mechanism. Authorisation for reads is the session, checked
     * per route; the origin check is what stops CROSS-SITE WRITES, and it is
     * tested above.
     */
    const response = await get(UNKNOWN_ORIGIN);

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('the payment-webhook exemption survives the split', () => {
  it('still accepts a POST with NO Origin header at all', async () => {
    /**
     * Razorpay POSTs server-to-server. There is no browser and therefore no
     * `Origin` header, so an origin check would reject every real payment event
     * — a 403 the provider retries for hours while subscriptions silently fail
     * to activate.
     *
     * THE COMPENSATING CONTROL is HMAC signature verification, which is strictly
     * stronger here: the origin header is a hint from a browser, whereas the
     * signature proves possession of a shared secret.
     *
     * This test is in THIS file, not only in `origin-check.test.ts`, because the
     * split changed which list that hook reads — and an exemption that survives
     * one refactor of its neighbourhood and not the next is worth pinning where
     * the refactor happened.
     */
    const response = await app.inject({ method: 'POST', url: '/api/v1/webhooks/razorpay' });

    expect(response.statusCode).toBe(200);
    expect(handlerRuns).toBe(1);
  });

  it('is a PATH PREFIX and nothing wider', async () => {
    // A neighbouring path must not inherit the exemption. If a second
    // server-to-server endpoint appears it gets its own entry and its own
    // documented compensating control — never a loosened pattern.
    const response = await app.inject({ method: 'POST', url: '/api/v1/things' });

    expect(response.statusCode).toBe(403);
    expect(handlerRuns).toBe(0);
  });
});
