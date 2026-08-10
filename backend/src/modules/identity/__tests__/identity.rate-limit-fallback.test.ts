import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CachePort } from '@/platform/cache/index';
import { LOGIN_RATE_LIMIT } from '@/shared/constants/rate-limits';
import type { IdentityService } from '../identity.service';
import type { RequestContext } from '../identity.types';
import {
  TEST_COOKIE_NAME,
  TEST_TENANT_ID,
  startIdentityHarness,
  type IdentityHarness,
} from './harness';

/**
 * THE TEST 04-RESILIENCE-PLAN.md §11 NAMES BY NAME:
 *
 *   "Rate-limit fallback — make the cache unavailable; assert login still works
 *    under an in-process limiter."
 *
 * It is here rather than in the limiter's own unit file because the claim being
 * made is about LOGIN, not about a counter. Before the fallback existed,
 * `cache.incr` rejecting propagated out of `consume`, out of `login`, and out
 * of the route as a 500 — one unreachable cache container disabled
 * authentication for the entire product (§2, F5: "Login breaks if it fails
 * closed"). The circuit breaker added later made that failure fast. Fast
 * failure is still failure.
 */

/** A cache that is simply not there. Every call rejects, as ioredis would. */
class UnavailableCache implements CachePort {
  private fail(): Promise<never> {
    return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
  }

  get(): Promise<string | null> {
    return this.fail();
  }
  set(): Promise<void> {
    return this.fail();
  }
  del(): Promise<void> {
    return this.fail();
  }
  incr(): Promise<number> {
    return this.fail();
  }
  expire(): Promise<boolean> {
    return this.fail();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

let harness: IdentityHarness;
let service: IdentityService;

const CONTEXT: RequestContext = { ipHash: 'fallback-ip', userAgent: 'vitest' };
const GOOD_PASSWORD = 'vermillion-otter-49';
const ALLOWED_ORIGIN = 'http://app.test';

beforeAll(async () => {
  harness = await startIdentityHarness({ cache: new UnavailableCache() });
  service = harness.identity.service;
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

/** Signup and verify, both of which are themselves rate limited. */
async function onboard(email: string, context: RequestContext): Promise<string> {
  await service.signup({ email, password: GOOD_PASSWORD, role: 'student' }, context);
  const verifyUrl = harness.mail.sent.at(-1)?.data.verifyUrl ?? '';
  const token = new URL(verifyUrl).searchParams.get('token') ?? '';
  const result = await service.verifyEmail(token, context);
  return result.user.id;
}

describe('WITH THE CACHE UNAVAILABLE', () => {
  it('LOGIN STILL WORKS, under the in-process limiter', async () => {
    await onboard('degraded@example.test', CONTEXT);

    const result = await service.login(
      { email: 'degraded@example.test', password: GOOD_PASSWORD },
      { ipHash: 'fallback-login', userAgent: null },
    );

    expect(result.user.email).toBe('degraded@example.test');
    expect(result.session.token).not.toBe('');
  }, 90_000);

  it('signs up and verifies too — the whole funnel degrades rather than stopping', async () => {
    const userId = await onboard('funnel@example.test', {
      ipHash: 'fallback-funnel',
      userAgent: null,
    });
    expect(userId).not.toBe('');
  }, 90_000);

  it('THE LIMIT IS STILL ENFORCED within this instance', async () => {
    const context: RequestContext = { ipHash: 'fallback-brute', userAgent: null };

    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.limit; attempt += 1) {
      await expect(
        service.login({ email: 'nobody@example.test', password: 'wrong-password-11' }, context),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }

    await expect(
      service.login({ email: 'nobody@example.test', password: 'wrong-password-11' }, context),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  }, 90_000);

  it('the window still closes on the injected clock', async () => {
    const context: RequestContext = { ipHash: 'fallback-window', userAgent: null };
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.limit + 1; attempt += 1) {
      await service
        .login({ email: 'nobody@example.test', password: 'wrong-password-11' }, context)
        .catch(() => undefined);
    }

    harness.clock.advanceSeconds(LOGIN_RATE_LIMIT.windowSeconds);

    await expect(
      service.login({ email: 'nobody@example.test', password: 'wrong-password-11' }, context),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  }, 90_000);

  it('says so, loudly — a warn line per activation', async () => {
    await service
      .login({ email: 'nobody@example.test', password: 'wrong-password-11' }, CONTEXT)
      .catch(() => undefined);

    const warnings = harness.logger.lines.filter(
      (line) => line.level === 'warn' && line.obj.event === 'rate_limit.fallback_activated',
    );
    expect(warnings.length).toBeGreaterThan(0);
  }, 60_000);

  it('serves the whole HTTP login route, not just the service', async () => {
    await onboard('http@example.test', { ipHash: 'fallback-http', userAgent: null });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      payload: { email: 'http@example.test', password: GOOD_PASSWORD },
    });

    // The assertion that matters is "not 500". A 200 with a session cookie is
    // what a healthy login looks like, and it is what a cache outage must not
    // change.
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['set-cookie'])).toContain(`${TEST_COOKIE_NAME}=`);
  }, 90_000);

  it('ISSUES AND REDEEMS A LINK CODE — codes are rows, and rows do not need the cache', async () => {
    // The other half of the same story (D-012): with the codes in the cache,
    // this flow was impossible during an outage. With them in a table, the
    // cache is irrelevant to it.
    const student = await onboard('kid@example.test', { ipHash: 'fb-kid', userAgent: null });
    await service.signup(
      { email: 'mum@example.test', password: GOOD_PASSWORD, role: 'parent' },
      { ipHash: 'fb-mum', userAgent: null },
    );
    const verifyUrl = harness.mail.sent.at(-1)?.data.verifyUrl ?? '';
    const parentResult = await service.verifyEmail(
      new URL(verifyUrl).searchParams.get('token') ?? '',
      { ipHash: 'fb-mum', userAgent: null },
    );

    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const link = await service.submitLinkCode(
      { userId: parentResult.user.id, role: 'parent', tenantId: TEST_TENANT_ID },
      issued.code,
    );

    expect(link.status).toBe('pending');
  }, 90_000);
});
