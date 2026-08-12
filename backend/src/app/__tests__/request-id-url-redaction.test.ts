import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryCache } from '../../platform/cache/index';
import { FixedClock } from '../../platform/clock/index';
import { parseConfig } from '../../platform/config/load-config';
import { CounterIdGen } from '../../platform/id-gen/index';
import { createLogger, stripQueryString, type Logger } from '../../platform/logger/index';
import { RecordingMail } from '../../platform/mail/index';
import { createContainer, type Container } from '../container';
import { createServer } from '../server';

/**
 * D-178 — A LIVE SESSION CREDENTIAL WAS WRITTEN TO THE LOGS IN PLAINTEXT.
 *
 * `registerRequestId` bound `request.url` into the per-request child logger and
 * emitted one `info` line per response. For the one endpoint that carries a
 * credential in its query string —
 *
 *     GET /api/v1/auth/verify?token=hu06Wi4jXIIzTob9Hy_62bR1ywlxI9E6dpRRdOjhMeg
 *
 * — every request wrote a token that grants a session on redemption into
 * whatever collects stdout. The logger's redaction could not help: it censors
 * by KEY, and the secret was inside a VALUE.
 *
 * WHY THIS TEST IS AT THE HTTP LAYER, AND WHY THE EXISTING ONE COULD NOT CATCH
 * IT. `identity.security.test.ts` already asserts "no credential ever reaches a
 * log line" — by driving the identity SERVICE directly. `registerRequestId` is
 * a Fastify hook: with no HTTP request there is no hook, no child logger and no
 * `url` binding at all, so the leak lived entirely in the gap between what that
 * test exercised and what production runs. The assertion has to travel through
 * `app.inject`.
 *
 * The REAL pino logger is used, not `FakeLogger`. The fake does not redact, and
 * asserting redaction against it would prove a property of the fake. This
 * captures the bytes pino actually writes.
 */

const TOKEN = 'hu06Wi4jXIIzTob9Hy_62bR1ywlxI9E6dpRRdOjhMeg';
const VERIFY_PATH = '/api/v1/auth/verify';

const CONFIG = parseConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://foxxy:pw@localhost:5433/unused',
  REDIS_URL: 'redis://localhost:6379',
  CORS_READ_ORIGINS: 'http://localhost:3000',
  CORS_WRITE_ORIGINS: 'http://localhost:3000',
  SESSION_COOKIE_NAME: 'foxxy_session',
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:4000',
});

/** The subset of a pino line this test reads back. */
interface LogLine {
  readonly msg?: string;
  readonly url?: string;
  readonly method?: string;
  readonly requestId?: string;
}

/** Every byte pino wrote, one entry per line. */
let written: string[] = [];
let container: Container;
let app: FastifyInstance;

function captureLogger(): Logger {
  const destination = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
      written.push(chunk.toString('utf8'));
      done();
    },
  });
  return createLogger({ level: 'trace', env: 'test' }, destination);
}

beforeEach(async () => {
  written = [];
  const clock = new FixedClock('2026-02-03T04:05:06.000Z');
  container = createContainer(CONFIG, {
    clock,
    idGen: new CounterIdGen(),
    logger: captureLogger(),
    cache: new MemoryCache(clock),
    mail: new RecordingMail(),
  });
  app = await createServer(container);

  // Stands in for the identity module's real handler, which lives in another
  // module and needs a database. What is under test is the request-id hook and
  // what it binds, and that is upstream of any handler: the binding happens
  // `onRequest`, before routing has produced a response at all.
  app.get(VERIFY_PATH, (_request, reply) => reply.redirect('http://localhost:3000/verified', 302));

  await app.ready();
});

afterEach(async () => {
  await app.close();
  await container.shutdown();
});

describe('GET /api/v1/auth/verify?token=… — the request log line', () => {
  it('does not write the token anywhere in the captured log output', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${VERIFY_PATH}?token=${encodeURIComponent(TOKEN)}`,
    });

    // NEGATIVE CONTROL. If the route ever stops being reached, or the response
    // hook stops firing, this test would pass by writing nothing at all — which
    // is the failure mode of every "assert the secret is absent" test.
    expect(response.statusCode).toBe(302);
    expect(written.length).toBeGreaterThan(0);
    expect(written.join('')).toContain('request completed');

    expect(written.join('')).not.toContain(TOKEN);
  });

  it('keeps the path, which is what correlation actually needs', async () => {
    await app.inject({ method: 'GET', url: `${VERIFY_PATH}?token=${TOKEN}` });

    const completed = written.map((line) => JSON.parse(line) as LogLine);
    const line = completed.find((entry) => entry.msg === 'request completed');

    expect(line).toBeDefined();
    expect(line?.url).toBe(VERIFY_PATH);
    expect(line?.method).toBe('GET');
    expect(line?.requestId).toEqual(expect.any(String));
  });

  it('drops the query string whatever the parameter is called', async () => {
    // The fix is not an allow-list of parameter names — that is the same shape
    // as the redaction key list, and it fails the first time somebody calls the
    // parameter `t` or `k`. Nothing in a query string survives.
    await app.inject({ method: 'GET', url: `${VERIFY_PATH}?t=${TOKEN}&k=${TOKEN}` });

    expect(written.join('')).not.toContain(TOKEN);
  });
});

describe('stripQueryString', () => {
  it('removes the query string and the fragment, and leaves a bare path alone', () => {
    expect(stripQueryString('/api/v1/auth/verify?token=abc')).toBe('/api/v1/auth/verify');
    expect(stripQueryString('/api/v1/auth/verify#token=abc')).toBe('/api/v1/auth/verify');
    expect(stripQueryString('/api/v1/auth/verify?a=1#b=2')).toBe('/api/v1/auth/verify');
    expect(stripQueryString('/api/v1/auth/verify')).toBe('/api/v1/auth/verify');
    expect(stripQueryString('/')).toBe('/');
  });
});
