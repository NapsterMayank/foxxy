import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MemoryCache } from '../../platform/cache/index';
import { FixedClock } from '../../platform/clock/index';
import { parseConfig } from '../../platform/config/load-config';
import { CounterIdGen } from '../../platform/id-gen/index';
import { FakeLogger } from '../../platform/logger/index';
import { RecordingMail } from '../../platform/mail/index';
import { hashIp } from '../../modules/identity/domain/token';
import { createContainer, type Container } from '../container';
import { createServer } from '../server';

/**
 * =============================================================================
 * WHOSE `X-Forwarded-For` WE BELIEVE — D-227.
 *
 * WHAT WAS WRONG. `server.ts` passed `trustProxy: true` to Fastify. That means
 * "believe the `X-Forwarded-For` header from ANYONE", and Fastify then reports
 * the leftmost address of a CLIENT-SUPPLIED header as `request.ip`.
 *
 * `request.ip` is what every IP-keyed rate limit is hashed from:
 *
 *     signup            3 per hour
 *     login             5 per 15 minutes
 *     forgot-password   3 per hour
 *
 * A caller that sends a different forged header on each request therefore lands
 * in a DIFFERENT BUCKET on each request. All three limits collapse to no limit
 * at all — with no error, no log line and no metric, because the limiter is
 * still installed and still counting. It is counting a fresh key every time.
 * That is the ninth instance of this codebase's recurring shape: enforcement
 * that looks present and enforces nothing.
 *
 * THE ASSERTION THAT MATTERS is not "request.ip is correct" — it is that the
 * RATE-LIMIT KEY does not move when an attacker rotates the header. That is
 * what this file measures, through the real `hashIp`.
 * =============================================================================
 */

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://foxxy:pw@127.0.0.1:1/foxxy',
  REDIS_URL: 'redis://localhost:6379',
  CORS_READ_ORIGINS: 'http://localhost:3000',
  CORS_WRITE_ORIGINS: 'http://localhost:3000',
  SESSION_COOKIE_NAME: 'foxxy_session',
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:4000',
  DATABASE_POOL_AUTH_MAX: '2',
};

const SALT = 'test-ip-hash-salt';

/** The addresses an attacker rotates through to get a fresh bucket each time. */
const FORGED = ['203.0.113.7', '198.51.100.42', '192.0.2.11'];

let container: Container | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  await container?.shutdown();
  app = undefined;
  container = undefined;
});

/**
 * Builds the real server and reports the `request.ip` it derived per request.
 *
 * An `onRequest` hook rather than a purpose-built route: the value under test
 * is Fastify's own derivation from the server OPTIONS, and reading it through a
 * hook means no route in this file can accidentally be the thing being tested.
 */
async function ipsSeenFor(
  env: Record<string, string>,
  requests: readonly { readonly forwardedFor?: string }[],
): Promise<string[]> {
  const clock = new FixedClock('2026-08-09T09:00:00.000Z');
  container = createContainer(parseConfig({ ...BASE_ENV, ...env }), {
    clock,
    idGen: new CounterIdGen(),
    logger: new FakeLogger(),
    cache: new MemoryCache(clock),
    mail: new RecordingMail(),
  });
  const server = await createServer(container);
  app = server;

  const seen: string[] = [];
  server.addHook('onRequest', (request, _reply, done) => {
    seen.push(request.ip);
    done();
  });
  await server.ready();

  for (const request of requests) {
    await server.inject({
      method: 'GET',
      url: '/health/live',
      ...(request.forwardedFor === undefined
        ? {}
        : { headers: { 'x-forwarded-for': request.forwardedFor } }),
    });
  }
  return seen;
}

describe('unconfigured — the default trusts nobody', () => {
  it('a forged X-Forwarded-For does NOT change the rate-limit key', async () => {
    // THE DEFECT, stated as an assertion. Restore `trustProxy: true` and this
    // is the named test that goes red: the three hashes become three distinct
    // buckets and login's 5-per-15-minutes becomes unbounded.
    const ips = await ipsSeenFor(
      {},
      FORGED.map((forwardedFor) => ({ forwardedFor })),
    );

    const keys = new Set(ips.map((ip) => hashIp(ip, SALT)));
    expect(keys.size).toBe(1);
  });

  it('reports the socket address, not the header', async () => {
    const [ip] = await ipsSeenFor({}, [{ forwardedFor: '203.0.113.7' }]);

    expect(ip).not.toBe('203.0.113.7');
  });

  it('keys identically whether the header is present or absent', async () => {
    // Otherwise "send any X-Forwarded-For" would still be a way to leave your
    // own bucket, which is the same defect with one extra step.
    const [withHeader, without] = await ipsSeenFor({}, [
      { forwardedFor: '203.0.113.7' },
      {},
    ]);

    expect(hashIp(withHeader ?? '', SALT)).toBe(hashIp(without ?? '', SALT));
  });
});

describe('configured with a hop count', () => {
  /**
   * THE REAL TOPOLOGY, which is what makes a hop count mean anything.
   *
   * A proxy does not replace `X-Forwarded-For`; it APPENDS the address it
   * received the connection from. So a client that forges a value produces
   *
   *     X-Forwarded-For: <whatever the client chose>, <the client's real address>
   *
   * and `TRUSTED_PROXY_HOPS=1` says "one proxy sits in front, so take the
   * second-from-the-right entry" — the one the proxy wrote, which the client
   * cannot influence.
   *
   * Simulated rather than assumed: the previous version of this test sent a
   * single-entry header, which is what a client sees but NOT what the server
   * behind a proxy ever receives, and it measured Fastify answering a different
   * question.
   */
  const REAL_CLIENT = '10.1.2.3';

  it('ignores the entry the client forged and takes the one the proxy wrote', async () => {
    const ips = await ipsSeenFor(
      { TRUSTED_PROXY_HOPS: '1' },
      FORGED.map((forged) => ({ forwardedFor: `${forged}, ${REAL_CLIENT}` })),
    );

    expect(ips).toEqual([REAL_CLIENT, REAL_CLIENT, REAL_CLIENT]);
    // One bucket, however many addresses the attacker rotates through.
    expect(new Set(ips.map((ip) => hashIp(ip, SALT))).size).toBe(1);
  });

  it('a client adding EXTRA hops still cannot reach a fresh bucket', async () => {
    // The obvious follow-up attack: pad the chain so the trusted position lands
    // on an attacker-chosen entry. It does move the derived address — which is
    // why a CIDR list is the preferred configuration — but every request from
    // this client still keys to the SAME bucket, because the padding is fixed
    // by the hop count rather than by the attacker.
    const ips = await ipsSeenFor({ TRUSTED_PROXY_HOPS: '1' }, [
      { forwardedFor: `1.1.1.1, 2.2.2.2, ${REAL_CLIENT}` },
      { forwardedFor: `1.1.1.1, 2.2.2.2, ${REAL_CLIENT}` },
    ]);

    expect(new Set(ips).size).toBe(1);
  });
});

describe('the configuration cannot express "believe everyone"', () => {
  it('refuses TRUSTED_PROXY_CIDRS and TRUSTED_PROXY_HOPS together', () => {
    // Fastify takes ONE `trustProxy` value. Given both, this codebase would
    // have to pick, and whichever it picked would silently ignore the other —
    // an operator who set both would be running exactly one of them and could
    // not tell which.
    expect(() =>
      parseConfig({
        ...BASE_ENV,
        TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
        TRUSTED_PROXY_HOPS: '1',
      }),
    ).toThrow();
  });

  it('resolves to `false` when neither is set', () => {
    // Not `true`, ever. Unconfigured behind a proxy the whole fleet shares one
    // bucket, so the limits are too STRICT — a visible, complainable failure.
    // Trusting a forged header is an invisible one, and only one of those two
    // gets noticed.
    expect(parseConfig(BASE_ENV).http.trustProxy).toBe(false);
  });

  it('carries the CIDR list through as data, never as `true`', () => {
    const config = parseConfig({ ...BASE_ENV, TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 172.16.0.0/12' });

    expect(config.http.trustProxy).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
  });
});
