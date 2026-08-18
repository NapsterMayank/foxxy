import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LINK_SUBMIT_RATE_LIMIT } from '@/shared/constants/rate-limits';
import { LINK_CODE_ALPHABET } from '../domain/link-code';
import { createArgon2PasswordHasher } from '../identity.password-hasher';
import type { IdentityService } from '../identity.service';
import type { RequestContext } from '../identity.types';
import {
  TEST_COOKIE_NAME,
  TEST_TENANT_ID,
  startIdentityHarness,
  type IdentityHarness,
} from './harness';

/**
 * THE SECURITY TESTS THAT MUST EXIST EXPLICITLY.
 *
 * Each one is a defence from §6.10 that is invisible in ordinary use: nothing
 * about the feature stops working if it regresses. That is precisely why they
 * are written down separately rather than left as a property of some other
 * test.
 *
 * This file uses the REAL Argon2id hasher. The timing test is meaningless
 * against a fake, and the other cases cost little.
 */

let harness: IdentityHarness;
let service: IdentityService;

const CONTEXT: RequestContext = { ipHash: 'sec-ip', userAgent: 'vitest' };
/** The origin the browser application sends. See the §6.10 check. */
const ALLOWED_ORIGIN = 'http://app.test';
const GOOD_PASSWORD = 'vermillion-otter-49';

beforeAll(async () => {
  harness = await startIdentityHarness({ hasher: createArgon2PasswordHasher() });
  service = harness.identity.service;
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

async function createVerifiedUser(
  email: string,
  role: 'student' | 'parent',
  context: RequestContext,
): Promise<string> {
  await service.signup({ email, password: GOOD_PASSWORD, role }, context);
  const verifyUrl = harness.mail.sent.at(-1)?.data.verifyUrl ?? '';
  const token = new URL(verifyUrl).searchParams.get('token') ?? '';
  const result = await service.verifyEmail(token, context);
  return result.user.id;
}

/** Median rather than mean: one scheduler hiccup must not move the result. */
function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

// ---------------------------------------------------------------------------

describe('SECURITY: login timing does not reveal whether the account exists', () => {
  it('takes a comparable time for an existing and a non-existent account', async () => {
    await createVerifiedUser('exists@example.test', 'student', CONTEXT);

    const SAMPLES = 7;
    const existing: number[] = [];
    const missing: number[] = [];

    for (let sample = 0; sample < SAMPLES; sample += 1) {
      // A fresh IP and email counter each round, so the rate limiter — which
      // runs first and returns almost instantly — never becomes the thing
      // being measured.
      const context: RequestContext = { ipHash: `timing-${sample}`, userAgent: null };

      const startExisting = performance.now();
      await service
        .login({ email: 'exists@example.test', password: 'wrong-password-000' }, context)
        .catch(() => undefined);
      existing.push(performance.now() - startExisting);

      const startMissing = performance.now();
      await service
        .login({ email: `absent-${sample}@example.test`, password: 'wrong-password-000' }, context)
        .catch(() => undefined);
      missing.push(performance.now() - startMissing);
    }

    const existingMedian = median(existing);
    const missingMedian = median(missing);
    const ratio = Math.max(existingMedian, missingMedian) / Math.min(existingMedian, missingMedian);

    // Both paths perform one full Argon2id verification, so the medians should
    // sit within a small factor. Without the dummy verification the missing
    // path returns in microseconds and this ratio is in the hundreds.
    expect(existingMedian).toBeGreaterThan(1);
    expect(missingMedian).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(3);
  }, 120_000);

  it('performs the dummy verification with the same Argon2 parameters', async () => {
    const hasher = createArgon2PasswordHasher();
    const real = await hasher.hash(GOOD_PASSWORD);
    const dummy = await hasher.dummyHash();

    // If the dummy used cheaper parameters the timing defence would be
    // decorative. Comparing the encoded parameter segment is the only way to
    // see it — a wrong cost hashes perfectly happily.
    const parametersOf = (hash: string): string => hash.split('$').slice(0, 4).join('$');
    expect(parametersOf(dummy)).toBe(parametersOf(real));
    expect(real).toContain('$argon2id$');
    expect(real).toContain('$m=19456,t=2,p=1$');
  }, 60_000);
});

describe('SECURITY: forgot-password does not reveal whether the account exists', () => {
  it('returns 200 for an address that has no account', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
      url: '/api/v1/auth/forgot-password',
      payload: { email: 'nobody@example.test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('returns a byte-identical response for an address that does have one', async () => {
    await createVerifiedUser('real@example.test', 'student', CONTEXT);

    const missing = await harness.app.inject({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
      url: '/api/v1/auth/forgot-password',
      payload: { email: 'nobody@example.test' },
    });
    const present = await harness.app.inject({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
      url: '/api/v1/auth/forgot-password',
      payload: { email: 'real@example.test' },
    });

    expect(present.statusCode).toBe(missing.statusCode);
    expect(present.body).toBe(missing.body);
  });
});

describe('SECURITY: signup does not reveal whether the account exists', () => {
  it('returns a byte-identical 201 for a new and an existing address', async () => {
    const first = await harness.app.inject({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
      url: '/api/v1/auth/signup',
      payload: { email: 'dup@example.test', password: GOOD_PASSWORD, role: 'student' },
    });
    const second = await harness.app.inject({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
      url: '/api/v1/auth/signup',
      payload: { email: 'dup@example.test', password: GOOD_PASSWORD, role: 'student' },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.body).toBe(first.body);
  }, 60_000);
});

describe('SECURITY: the session token never appears in a response body', () => {
  it('is absent from the login response and present only in set-cookie', async () => {
    await createVerifiedUser('login@example.test', 'student', CONTEXT);

    const response = await harness.app.inject({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
      url: '/api/v1/auth/login',
      payload: { email: 'login@example.test', password: GOOD_PASSWORD },
    });

    expect(response.statusCode).toBe(200);

    const stored = await harness.postgres.client.query<{ token_hash: string }>(
      'select token_hash from sessions order by created_at desc limit 1',
    );
    expect(stored.rows).toHaveLength(1);

    // The body carries the profile and nothing resembling a credential.
    const body: unknown = response.json();
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('token');
    expect(serialised).not.toContain(stored.rows[0]?.token_hash ?? 'never');
    expect(Object.keys(body as Record<string, unknown>)).toEqual(['user']);

    const setCookie = response.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
    expect(cookieHeader).toContain(`${TEST_COOKIE_NAME}=`);
  }, 60_000);

  it('is absent from the verification redirect, which has no body at all', async () => {
    await service.signup(
      { email: 'verify@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );
    const verifyUrl = harness.mail.sent.at(-1)?.data.verifyUrl ?? '';
    const token = new URL(verifyUrl).searchParams.get('token') ?? '';

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/verify?token=${encodeURIComponent(token)}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.body).not.toContain(token);
  }, 60_000);

  it('sets the cookie httpOnly, secure and sameSite=lax', async () => {
    await createVerifiedUser('cookie@example.test', 'student', CONTEXT);

    const response = await harness.app.inject({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
      url: '/api/v1/auth/login',
      payload: { email: 'cookie@example.test', password: GOOD_PASSWORD },
    });

    const setCookie = response.headers['set-cookie'];
    const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : String(setCookie);

    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toContain('Max-Age=2592000'); // 30 days
  }, 60_000);
});

describe('SECURITY: a 403 on a denied link carries no student data', () => {
  it('returns only the fixed forbidden envelope', async () => {
    const studentId = await createVerifiedUser('child@example.test', 'student', CONTEXT);
    await createVerifiedUser('parent@example.test', 'parent', {
      ipHash: 'sec-ip-2',
      userAgent: null,
    });

    /*
     * A link belonging to SOMEBODY ELSE — migration 0007.
     *
     * This used to attempt `approve`, which no longer exists: the old consent
     * model's approval step was unreachable and was removed. `revoke` is the
     * remaining id-bearing link route and carries the identical property — a
     * 403 must reveal nothing about the link or the student behind it.
     */
    const otherParentId = await createVerifiedUser('other-parent@example.test', 'parent', {
      ipHash: 'sec-ip-2b',
      userAgent: null,
    });
    const issued = await service.generateLinkCode({ userId: studentId, role: 'student', tenantId: TEST_TENANT_ID });
    const otherActor = { userId: otherParentId, role: 'parent' as const, tenantId: TEST_TENANT_ID };
    await service.requestLinkOtp(otherActor, { code: issued.code });
    const link = await service.redeemLinkCode(otherActor, {
      code: issued.code,
      otp: String(harness.mail.sent.at(-1)?.data.otp),
    });

    // A DIFFERENT parent tries to revoke it.
    const parentSession = await service.login(
      { email: 'parent@example.test', password: GOOD_PASSWORD },
      { ipHash: 'sec-ip-3', userAgent: null },
    );

    const response = await harness.app.inject({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
      url: `/api/v1/links/${link.id}/revoke`,
      cookies: { [TEST_COOKIE_NAME]: parentSession.session.token },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Forbidden.' } });

    // Nothing about the student, the link, or even that either exists.
    expect(response.body).not.toContain(studentId);
    expect(response.body).not.toContain(link.id);
    expect(response.body).not.toContain('child@example.test');
    expect(response.body).not.toContain('approved');
  }, 90_000);

  it('answers identically for a link id that does not exist at all', async () => {
    const parentId = await createVerifiedUser('parent2@example.test', 'parent', CONTEXT);
    const session = await service.login(
      { email: 'parent2@example.test', password: GOOD_PASSWORD },
      { ipHash: 'sec-ip-4', userAgent: null },
    );
    expect(parentId).not.toBe('');

    const response = await harness.app.inject({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
      url: '/api/v1/links/00000000-0000-4000-8000-00000000dead/revoke',
      cookies: { [TEST_COOKIE_NAME]: session.session.token },
    });

    // "Exists but is not yours" and "does not exist" must be indistinguishable
    // — otherwise the endpoint enumerates link ids.
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Forbidden.' } });
  }, 90_000);
});

describe('SECURITY: link-code brute force is blocked by the rate limit', () => {
  it('cuts a guessing parent off after 5 attempts in an hour', async () => {
    const parentId = await createVerifiedUser('guesser@example.test', 'parent', CONTEXT);
    const actor = { userId: parentId, role: 'parent', tenantId: TEST_TENANT_ID } as const;

    const guesses = [
      LINK_CODE_ALPHABET.slice(0, 6),
      LINK_CODE_ALPHABET.slice(1, 7),
      LINK_CODE_ALPHABET.slice(2, 8),
      LINK_CODE_ALPHABET.slice(3, 9),
      LINK_CODE_ALPHABET.slice(4, 10),
    ];
    expect(guesses).toHaveLength(LINK_SUBMIT_RATE_LIMIT.limit);

    for (const guess of guesses) {
      await expect(service.submitLinkCode(actor, guess)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }

    // The sixth guess never reaches the lookup.
    await expect(
      service.submitLinkCode(actor, LINK_CODE_ALPHABET.slice(5, 11)),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  }, 90_000);

  it('counts a failed guess against the budget, so wrong guesses are not free', async () => {
    const parentId = await createVerifiedUser('guesser2@example.test', 'parent', CONTEXT);
    const studentId = await createVerifiedUser('kid2@example.test', 'student', {
      ipHash: 'sec-ip-5',
      userAgent: null,
    });
    const actor = { userId: parentId, role: 'parent', tenantId: TEST_TENANT_ID } as const;

    for (let attempt = 0; attempt < LINK_SUBMIT_RATE_LIMIT.limit; attempt += 1) {
      await service.submitLinkCode(actor, 'ZZZZZZ').catch(() => undefined);
    }

    // Even a CORRECT code is refused once the budget is spent — the limiter
    // runs before the lookup, which is what makes it a brute-force defence
    // rather than a cosmetic counter.
    const issued = await service.generateLinkCode({ userId: studentId, role: 'student', tenantId: TEST_TENANT_ID });
    await expect(service.submitLinkCode(actor, issued.code)).rejects.toMatchObject({
      code: 'RATE_LIMIT_EXCEEDED',
    });
  }, 90_000);

  it('keeps each parent account on its own budget', async () => {
    const first = await createVerifiedUser('p-a@example.test', 'parent', CONTEXT);
    const second = await createVerifiedUser('p-b@example.test', 'parent', {
      ipHash: 'sec-ip-6',
      userAgent: null,
    });

    for (let attempt = 0; attempt < LINK_SUBMIT_RATE_LIMIT.limit + 1; attempt += 1) {
      await service
        .submitLinkCode({ userId: first, role: 'parent', tenantId: TEST_TENANT_ID }, 'ZZZZZZ')
        .catch(() => undefined);
    }

    await expect(
      service.submitLinkCode({ userId: second, role: 'parent', tenantId: TEST_TENANT_ID }, 'ZZZZZZ'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  }, 90_000);
});

describe('SECURITY: no credential ever reaches a log line', () => {
  it('logs no password, token, email or link code across a whole signup and login', async () => {
    await createVerifiedUser('logged@example.test', 'student', CONTEXT);
    const result = await service.login(
      { email: 'logged@example.test', password: GOOD_PASSWORD },
      { ipHash: 'sec-ip-7', userAgent: null },
    );

    const serialised = JSON.stringify(harness.logger.lines);

    expect(serialised).not.toContain(GOOD_PASSWORD);
    expect(serialised).not.toContain('logged@example.test');
    expect(serialised).not.toContain(result.session.token);
  }, 90_000);

  it('logs no raw IP address', async () => {
    await service.signup(
      { email: 'ip@example.test', password: GOOD_PASSWORD, role: 'student' },
      { ipHash: 'sec-ip-8', userAgent: null },
    );
    // The service only ever receives a hash; the raw address is discarded in
    // the route layer before the context is built.
    expect(JSON.stringify(harness.logger.lines)).not.toContain('127.0.0.1');
  }, 60_000);
});
