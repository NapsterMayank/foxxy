import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  activeLinkCodeResponseSchema,
  linkCodeResponseSchema,
  linkResponseSchema,
  linkedChildrenResponseSchema,
  loginResponseSchema,
  signupResponseSchema,
} from '@/shared/contracts/identity.contract';
import {
  OTHER_TENANT_ID,
  TEST_COOKIE_NAME,
  TEST_TENANT_ID,
  createSecondTenant,
  sessionCookieFrom,
  startIdentityHarness,
} from './harness';
import type { IdentityHarness } from './harness';

/**
 * Route tests — the HTTP surface, and the end-to-end journey the definition of
 * done names:
 *
 *   signup -> verify -> login -> issue code -> approve -> list children -> revoke
 *
 * Every response is parsed with the SHARED CONTRACT SCHEMA rather than checked
 * field by field. That is what makes the contract real: if the route and the
 * schema the frontend imports ever disagree, these tests fail rather than the
 * frontend doing so at runtime.
 */

let harness: IdentityHarness;

const GOOD_PASSWORD = 'vermillion-otter-49';

beforeAll(async () => {
  harness = await startIdentityHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

/**
 * Every POST carries an `Origin` header, because every real one does: the
 * origin check (§6.10) refuses a state-changing request that arrives without a
 * recognised origin, and `APP_URL` is what the browser application sends. The
 * check itself is tested in `src/app/__tests__/origin-check.test.ts`.
 */
const ALLOWED_ORIGIN = 'http://app.test';

function post(url: string, payload: unknown, cookie?: string): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url,
    headers: { origin: ALLOWED_ORIGIN },
    payload: payload as Record<string, unknown>,
    ...(cookie === undefined ? {} : { cookies: { [TEST_COOKIE_NAME]: cookie } }),
  });
}

function get(url: string, cookie?: string): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'GET',
    url,
    ...(cookie === undefined ? {} : { cookies: { [TEST_COOKIE_NAME]: cookie } }),
  });
}

/** The token from the most recent verification email. */
function lastVerifyToken(): string {
  const verifyUrl = harness.mail.sent.at(-1)?.data.verifyUrl ?? '';
  return new URL(verifyUrl).searchParams.get('token') ?? '';
}

/** signup -> verify -> login, returning a live session cookie. */
async function onboard(email: string, role: 'student' | 'parent'): Promise<string> {
  await post('/api/v1/auth/signup', { email, password: GOOD_PASSWORD, role });
  await get(`/api/v1/auth/verify?token=${encodeURIComponent(lastVerifyToken())}`);
  const login = await post('/api/v1/auth/login', { email, password: GOOD_PASSWORD });
  const cookie = sessionCookieFrom(login.headers['set-cookie']);
  if (cookie === null) throw new Error(`onboard: no session cookie for ${role}`);
  return cookie;
}

// ---------------------------------------------------------------------------

describe('THE END-TO-END JOURNEY', () => {
  it('signs up, verifies, logs in, links a parent and revokes — all by HTTP', async () => {
    // --- 1. Two accounts sign up -----------------------------------------
    const studentSignup = await post('/api/v1/auth/signup', {
      email: 'kid@example.test',
      password: GOOD_PASSWORD,
      role: 'student',
    });
    expect(studentSignup.statusCode).toBe(201);
    expect(signupResponseSchema.parse(studentSignup.json())).toMatchObject({ status: 'ok' });

    const studentToken = lastVerifyToken();

    await post('/api/v1/auth/signup', {
      email: 'mum@example.test',
      password: GOOD_PASSWORD,
      role: 'parent',
    });
    const parentToken = lastVerifyToken();

    // --- 2. Verification, which redirects to onboarding -------------------
    const verify = await get(`/api/v1/auth/verify?token=${encodeURIComponent(studentToken)}`);
    expect(verify.statusCode).toBe(302);
    expect(verify.headers.location).toBe('http://app.test/onboarding');
    expect(sessionCookieFrom(verify.headers['set-cookie'])).not.toBeNull();

    await get(`/api/v1/auth/verify?token=${encodeURIComponent(parentToken)}`);

    // --- 3. Login ---------------------------------------------------------
    const studentLogin = await post('/api/v1/auth/login', {
      email: 'kid@example.test',
      password: GOOD_PASSWORD,
    });
    expect(studentLogin.statusCode).toBe(200);
    const studentProfile = loginResponseSchema.parse(studentLogin.json());
    expect(studentProfile.user.role).toBe('student');
    expect(studentProfile.user.emailVerifiedAt).not.toBeNull();

    const studentCookie = sessionCookieFrom(studentLogin.headers['set-cookie']);
    expect(studentCookie).not.toBeNull();

    const parentLogin = await post('/api/v1/auth/login', {
      email: 'mum@example.test',
      password: GOOD_PASSWORD,
    });
    const parentCookie = sessionCookieFrom(parentLogin.headers['set-cookie']);
    expect(parentCookie).not.toBeNull();

    // --- 4. The student issues a link code --------------------------------
    const codeResponse = await post('/api/v1/links/code', {}, studentCookie ?? '');
    expect(codeResponse.statusCode).toBe(201);
    const issued = linkCodeResponseSchema.parse(codeResponse.json());
    expect(issued.code).toHaveLength(6);

    // --- 5. The parent submits it — and gets NOTHING yet -------------------
    const submitted = await post('/api/v1/links/submit', { code: issued.code }, parentCookie ?? '');
    expect(submitted.statusCode).toBe(201);
    const pending = linkResponseSchema.parse(submitted.json());
    expect(pending.link.status).toBe('pending');

    const beforeApproval = await get('/api/v1/links/children', parentCookie ?? '');
    expect(linkedChildrenResponseSchema.parse(beforeApproval.json()).children).toEqual([]);

    // --- 6. The student approves — this is where consent happens ----------
    const approve = await post(`/api/v1/links/${pending.link.id}/approve`, {}, studentCookie ?? '');
    expect(approve.statusCode).toBe(200);
    expect(linkResponseSchema.parse(approve.json()).link.status).toBe('approved');

    // --- 7. The child now appears -----------------------------------------
    const children = await get('/api/v1/links/children', parentCookie ?? '');
    const listed = linkedChildrenResponseSchema.parse(children.json());
    expect(listed.children).toHaveLength(1);
    expect(listed.children[0]?.studentUserId).toBe(studentProfile.user.id);

    // --- 8. Revoke, and the child disappears on the very next request -----
    const revoke = await post(`/api/v1/links/${pending.link.id}/revoke`, {}, parentCookie ?? '');
    expect(revoke.statusCode).toBe(200);
    expect(linkResponseSchema.parse(revoke.json()).link.status).toBe('revoked');

    const afterRevoke = await get('/api/v1/links/children', parentCookie ?? '');
    expect(linkedChildrenResponseSchema.parse(afterRevoke.json()).children).toEqual([]);
  }, 120_000);
});

describe('POST /api/v1/auth/signup', () => {
  it('rejects a malformed email with a 400 that names the field', async () => {
    const response = await post('/api/v1/auth/signup', {
      email: 'not-an-email',
      password: GOOD_PASSWORD,
      role: 'student',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects a role outside student and parent', async () => {
    const response = await post('/api/v1/auth/signup', {
      email: 'a@example.test',
      password: GOOD_PASSWORD,
      role: 'teacher',
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a missing body', async () => {
    const response = await post('/api/v1/auth/signup', {});
    expect(response.statusCode).toBe(400);
  });

  it('rejects a weak password with the domain message', async () => {
    const response = await post('/api/v1/auth/signup', {
      email: 'a@example.test',
      password: 'password123',
      role: 'student',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { message: expect.stringContaining('breach lists') },
    });
  });
});

describe('GET /api/v1/auth/verify', () => {
  it('rejects a missing token with a 400', async () => {
    expect((await get('/api/v1/auth/verify')).statusCode).toBe(400);
  });

  it('rejects an unknown token with a 400 and no redirect', async () => {
    const response = await get('/api/v1/auth/verify?token=nonsense');
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
  });
});

describe('POST /api/v1/auth/login', () => {
  it('returns 401 with one message for a wrong password', async () => {
    await onboard('a@example.test', 'student');
    const response = await post('/api/v1/auth/login', {
      email: 'a@example.test',
      password: 'definitely-wrong-11',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password.' },
    });
  });

  it('returns the identical 401 for an account that does not exist', async () => {
    const response = await post('/api/v1/auth/login', {
      email: 'nobody@example.test',
      password: 'definitely-wrong-11',
    });
    expect(response.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password.' },
    });
  });

  it('returns 403 EMAIL_NOT_VERIFIED so the frontend can offer to resend', async () => {
    await post('/api/v1/auth/signup', {
      email: 'unverified@example.test',
      password: GOOD_PASSWORD,
      role: 'student',
    });

    const response = await post('/api/v1/auth/login', {
      email: 'unverified@example.test',
      password: GOOD_PASSWORD,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { reason: 'EMAIL_NOT_VERIFIED' } });
  });

  it('sets no cookie on a failed login', async () => {
    const response = await post('/api/v1/auth/login', {
      email: 'nobody@example.test',
      password: 'definitely-wrong-11',
    });
    expect(sessionCookieFrom(response.headers['set-cookie'])).toBeNull();
  });

  it('returns 429 once the limit is spent', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await post('/api/v1/auth/login', {
        email: 'a@example.test',
        password: 'definitely-wrong-11',
      });
    }
    const response = await post('/api/v1/auth/login', {
      email: 'a@example.test',
      password: 'definitely-wrong-11',
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('900');
  });
});

describe('POST /api/v1/auth/logout and logout-all', () => {
  it('clears the cookie and kills the session', async () => {
    const cookie = await onboard('a@example.test', 'student');

    const response = await post('/api/v1/auth/logout', {}, cookie);
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['set-cookie'])).toContain(`${TEST_COOKIE_NAME}=;`);

    // The dead cookie no longer authenticates anything.
    expect((await get('/api/v1/links/children', cookie)).statusCode).toBe(401);
  });

  it('succeeds with no session at all — logout is idempotent', async () => {
    expect((await post('/api/v1/auth/logout', {})).statusCode).toBe(200);
  });

  it('logout-all requires a session', async () => {
    expect((await post('/api/v1/auth/logout-all', {})).statusCode).toBe(401);
  });

  it('logout-all kills every session for the user', async () => {
    const first = await onboard('a@example.test', 'student');
    const secondLogin = await post('/api/v1/auth/login', {
      email: 'a@example.test',
      password: GOOD_PASSWORD,
    });
    const second = sessionCookieFrom(secondLogin.headers['set-cookie']) ?? '';

    expect((await post('/api/v1/auth/logout-all', {}, first)).statusCode).toBe(200);

    expect((await get('/api/v1/links/children', first)).statusCode).toBe(401);
    expect((await get('/api/v1/links/children', second)).statusCode).toBe(401);
  });
});

describe('POST /api/v1/auth/reset-password', () => {
  it('logs every session out, so the caller must sign in again', async () => {
    const cookie = await onboard('a@example.test', 'student');

    await post('/api/v1/auth/forgot-password', { email: 'a@example.test' });
    const resetUrl = harness.mail.sent.at(-1)?.data.resetUrl ?? '';
    const token = new URL(resetUrl).searchParams.get('token') ?? '';

    const response = await post('/api/v1/auth/reset-password', {
      token,
      password: 'brand-new-passphrase-1',
    });
    expect(response.statusCode).toBe(200);

    expect((await get('/api/v1/links/children', cookie)).statusCode).toBe(401);
  });

  it('rejects a weak new password before touching anything', async () => {
    const response = await post('/api/v1/auth/reset-password', {
      token: 'whatever',
      password: 'short',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('the authenticated routes', () => {
  it.each([
    ['POST', '/api/v1/links/code'],
    ['POST', '/api/v1/links/submit'],
    ['POST', '/api/v1/links/00000000-0000-4000-8000-000000000001/approve'],
    ['POST', '/api/v1/links/00000000-0000-4000-8000-000000000001/revoke'],
    ['GET', '/api/v1/links/children'],
    ['POST', '/api/v1/auth/logout-all'],
  ])('%s %s returns 401 without a session', async (method, url) => {
    const response =
      method === 'GET' ? await get(url) : await post(url, {});
    expect(response.statusCode).toBe(401);
  });

  it('clears a rejected cookie so the browser stops sending it', async () => {
    const response = await get('/api/v1/links/children', 'not-a-real-session-token');
    expect(response.statusCode).toBe(401);
    expect(String(response.headers['set-cookie'])).toContain(`${TEST_COOKIE_NAME}=;`);
  });

  it('rejects a link id that is not a uuid with a 400, not a 500', async () => {
    const cookie = await onboard('a@example.test', 'student');
    const response = await post('/api/v1/links/not-a-uuid/approve', {}, cookie);
    expect(response.statusCode).toBe(400);
  });

  it('rejects a malformed link code with a 400', async () => {
    const cookie = await onboard('p@example.test', 'parent');
    const response = await post('/api/v1/links/submit', { code: 'ABC' }, cookie);
    expect(response.statusCode).toBe(400);
  });

  it('refuses a parent asking for a link code', async () => {
    const cookie = await onboard('p@example.test', 'parent');
    expect((await post('/api/v1/links/code', {}, cookie)).statusCode).toBe(403);
  });

  it('refuses a student listing children', async () => {
    const cookie = await onboard('s@example.test', 'student');
    expect((await get('/api/v1/links/children', cookie)).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// PUBLIC URLS COME FROM CONFIGURATION — resolves D-015.
//
// Both origins used to be derived, and both derivations were wrong in the same
// deployment: `apiBaseUrl` from HOST + PORT (a BIND address — `0.0.0.0` is not
// somewhere a browser can go) and `appBaseUrl` from `corsOrigins[0]` (an
// allow-list entry that happens to be first, so adding a staging origin at the
// front would have redirected every production signup to staging).
//
// The harness is configured so the three candidate sources are all DIFFERENT:
//   APP_URL      http://app.test
//   API_URL      http://api.test
//   CORS_ORIGINS http://localhost:3000
//   request host localhost (whatever light-my-request uses)
// so these assertions can only pass if the value came from config.
// ---------------------------------------------------------------------------

describe('the post-verification redirect', () => {
  it('is built from APP_URL', async () => {
    await post('/api/v1/auth/signup', {
      email: 'redirect@example.test',
      password: GOOD_PASSWORD,
      role: 'student',
    });
    const response = await get(`/api/v1/auth/verify?token=${encodeURIComponent(lastVerifyToken())}`);

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('http://app.test/onboarding');
  });

  it('is NOT built from the CORS allow-list', async () => {
    await post('/api/v1/auth/signup', {
      email: 'cors@example.test',
      password: GOOD_PASSWORD,
      role: 'student',
    });
    const response = await get(`/api/v1/auth/verify?token=${encodeURIComponent(lastVerifyToken())}`);

    expect(String(response.headers.location)).not.toContain('localhost:3000');
  });

  it('is NOT built from the request host, so a proxy cannot move it', async () => {
    await post('/api/v1/auth/signup', {
      email: 'proxy@example.test',
      password: GOOD_PASSWORD,
      role: 'student',
    });

    // A forged Host header is the classic way this kind of derivation is
    // abused: the attacker makes the redirect — or worse, the emailed link —
    // point at their own server.
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/auth/verify?token=${encodeURIComponent(lastVerifyToken())}`,
      headers: { host: 'attacker.test', 'x-forwarded-host': 'attacker.test' },
    });

    expect(response.headers.location).toBe('http://app.test/onboarding');
  });
});

describe('the links in outbound email', () => {
  it('points the verification link at API_URL', async () => {
    await post('/api/v1/auth/signup', {
      email: 'mail@example.test',
      password: GOOD_PASSWORD,
      role: 'student',
    });

    const verifyUrl = String(harness.mail.sent.at(-1)?.data.verifyUrl);
    expect(verifyUrl.startsWith('http://api.test/api/v1/auth/verify?token=')).toBe(true);
  });

  it('points the reset link at APP_URL — a page, not an endpoint', async () => {
    await onboard('reset@example.test', 'student');
    await post('/api/v1/auth/forgot-password', { email: 'reset@example.test' });

    const resetUrl = String(harness.mail.sent.at(-1)?.data.resetUrl);
    expect(resetUrl.startsWith('http://app.test/reset-password?token=')).toBe(true);
  });
});

describe('GET /api/v1/links/code', () => {
  it('returns the outstanding code rather than issuing a new one', async () => {
    const cookie = await onboard('kid@example.test', 'student');
    const issued = linkCodeResponseSchema.parse((await post('/api/v1/links/code', {}, cookie)).json());

    const response = await get('/api/v1/links/code', cookie);

    expect(response.statusCode).toBe(200);
    expect(activeLinkCodeResponseSchema.parse(response.json())).toEqual({
      code: issued.code,
      expiresAt: issued.expiresAt,
    });
  });

  it('answers with nulls when there is no live code', async () => {
    const cookie = await onboard('nocode@example.test', 'student');

    const response = await get('/api/v1/links/code', cookie);

    expect(response.statusCode).toBe(200);
    expect(activeLinkCodeResponseSchema.parse(response.json())).toEqual({
      code: null,
      expiresAt: null,
    });
  });

  it('requires a session', async () => {
    expect((await get('/api/v1/links/code')).statusCode).toBe(401);
  });

  it('refuses a parent', async () => {
    const cookie = await onboard('mum@example.test', 'parent');
    expect((await get('/api/v1/links/code', cookie)).statusCode).toBe(403);
  });
});

describe('the origin check on the identity routes', () => {
  it('rejects a login POST that arrives with no Origin at all', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'a@example.test', password: GOOD_PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a signup POST from a foreign origin', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      headers: { origin: 'https://evil.test' },
      payload: { email: 'csrf@example.test', password: GOOD_PASSWORD, role: 'student' },
    });

    expect(response.statusCode).toBe(403);
    // And nothing was created — the hook runs before the body is even parsed.
    expect(harness.mail.sent).toHaveLength(0);
  });

  it('leaves the emailed verification GET reachable, which has no origin', async () => {
    await post('/api/v1/auth/signup', {
      email: 'email-link@example.test',
      password: GOOD_PASSWORD,
      role: 'student',
    });

    const response = await get(`/api/v1/auth/verify?token=${encodeURIComponent(lastVerifyToken())}`);
    expect(response.statusCode).toBe(302);
  });
});

// ---------------------------------------------------------------------------
// TENANCY — D-073
// ---------------------------------------------------------------------------

/** The tenant a user row actually landed in. Read from the database, not inferred. */
async function tenantOf(email: string): Promise<string | null> {
  const result = await harness.postgres.client.query<{ tenant_id: string | null }>(
    'select tenant_id from users where email = $1',
    [email],
  );
  return result.rows[0]?.tenant_id ?? null;
}

describe('a client-supplied tenant cannot escalate — D-073', () => {
  /**
   * THE FRONT-DOOR ATTACK ON TENANCY, AND WHY IT NEEDS ITS OWN TEST.
   *
   * Every other tenant rule in the product is a READ-side check: the guard
   * compares the actor's tenant with the resource's and refuses a mismatch. All
   * of that is worth nothing if a caller can choose which tenant they are IN.
   *
   * Signup is the only endpoint with no authenticated actor, so it is the only
   * place the question arises — and it is exactly the place somebody would later
   * "helpfully" add a `tenantId` field to support multi-tenant onboarding. The
   * tenant comes from CONFIGURATION and nowhere else.
   *
   * The defence is layered and the layers are worth naming, because only one of
   * them is visible at the call site: the signup contract does not declare the
   * field, Zod strips unknown keys rather than passing them through, and
   * `createUser` takes its tenant as an explicit argument the route cannot
   * influence. This test is what proves all three still hold together.
   */
  it('IGNORES a tenantId in the signup body', async () => {
    await createSecondTenant(harness);

    const response = await post('/api/v1/auth/signup', {
      email: 'sneaky@example.test',
      password: GOOD_PASSWORD,
      role: 'student',
      tenantId: OTHER_TENANT_ID,
    });

    // 201, identical to any other signup — the field is not an error, it is
    // simply not part of the contract, and rejecting it would tell a prober that
    // the field means something.
    expect(response.statusCode).toBe(201);
    expect(await tenantOf('sneaky@example.test')).toBe(TEST_TENANT_ID);
  });

  it('ignores it under every plausible spelling', async () => {
    // A single-key test passes against an implementation that blocks that one
    // key. The rule is that NOTHING in the body reaches the tenant column.
    await createSecondTenant(harness);

    await post('/api/v1/auth/signup', {
      email: 'sneaky2@example.test',
      password: GOOD_PASSWORD,
      role: 'student',
      tenant_id: OTHER_TENANT_ID,
      tenant: OTHER_TENANT_ID,
      tenantID: OTHER_TENANT_ID,
    });

    expect(await tenantOf('sneaky2@example.test')).toBe(TEST_TENANT_ID);
  });

  it('files the session actor under the tenant of the ROW, not of the request', async () => {
    // The session is where the actor's tenant comes from on every subsequent
    // request, so a signup that ignored the body but a session that trusted it
    // would leave the hole exactly where it was.
    await createSecondTenant(harness);
    await post('/api/v1/auth/signup', {
      email: 'sneaky3@example.test',
      password: GOOD_PASSWORD,
      role: 'student',
      tenantId: OTHER_TENANT_ID,
    });
    await get(`/api/v1/auth/verify?token=${encodeURIComponent(lastVerifyToken())}`);
    const login = await post('/api/v1/auth/login', {
      email: 'sneaky3@example.test',
      password: GOOD_PASSWORD,
    });
    const cookie = sessionCookieFrom(login.headers['set-cookie']) ?? '';

    const actor = await harness.identity.service.validateSession(cookie);
    expect(actor.tenantId).toBe(TEST_TENANT_ID);
  });
});

describe('a cross-tenant link is refused — D-073', () => {
  /**
   * `parent_child_links` is the ONLY cross-user data path in the product, and it
   * is the one row that spans two accounts. Every other tenant decision is made
   * at read time by `assertCanAccess`; this one has to be made at WRITE time,
   * because a link row carries a single tenant and there is no read-time check
   * that could repair one filed under the wrong one.
   */
  async function moveToOtherTenant(email: string): Promise<void> {
    await createSecondTenant(harness);
    await harness.postgres.client.query('update users set tenant_id = $1 where email = $2', [
      OTHER_TENANT_ID,
      email,
    ]);
  }

  it('refuses a parent in tenant A redeeming a code from a student in tenant B', async () => {
    const studentCookie = await onboard('kid-t@example.test', 'student');
    const parentCookie = await onboard('mum-t@example.test', 'parent');

    const issued = await post('/api/v1/links/code', {}, studentCookie);
    const code = linkCodeResponseSchema.parse(issued.json()).code;

    await moveToOtherTenant('kid-t@example.test');

    const submit = await post('/api/v1/links/submit', { code }, parentCookie);

    // The SAME 400 as an unknown or expired code. Distinguishing them would tell
    // a parent in tenant A that this code belongs to a real student in tenant B
    // — the existence disclosure a white-labelled deployment cannot afford,
    // delivered by a helpful error message.
    expect(submit.statusCode).toBe(400);

    const links = await harness.postgres.client.query('select count(*)::text as n from parent_child_links');
    expect((links.rows[0] as { n: string }).n).toBe('0');
  });

  it('still allows the same pair when both are in one tenant', async () => {
    // The control. Without it the test above would pass against an
    // implementation that refused every link.
    const studentCookie = await onboard('kid-u@example.test', 'student');
    const parentCookie = await onboard('mum-u@example.test', 'parent');

    const issued = await post('/api/v1/links/code', {}, studentCookie);
    const code = linkCodeResponseSchema.parse(issued.json()).code;

    const submit = await post('/api/v1/links/submit', { code }, parentCookie);
    expect(submit.statusCode).toBe(201);
    expect(linkResponseSchema.parse(submit.json()).link.status).toBe('pending');
  });
});

describe('POST /links/code is rate limited — open item 2', () => {
  /**
   * A student session could previously mint codes without bound.
   *
   * The harm worth preventing is not brute force — that is the SUBMIT limit's
   * job, and it is keyed by the parent. It is that every mint RETIRES the
   * previous code, so a loop denies the student their own onboarding by
   * invalidating the code the parent is part-way through typing; and that
   * `link_codes` rows are never deleted, so an unbounded mint rate is an
   * unbounded table.
   */
  it('allows five in an hour and REJECTS the sixth', async () => {
    const cookie = await onboard('minter@example.test', 'student');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await post('/api/v1/links/code', {}, cookie);
      expect(response.statusCode).toBe(201);
    }

    const sixth = await post('/api/v1/links/code', {}, cookie);
    expect(sixth.statusCode).toBe(429);
  });

  it('takes PRECEDENCE over the global 100-per-minute limit', async () => {
    /**
     * The two limits coexist and the STRICTER one is the one that fires, because
     * it is the one that runs out first. Six requests is nowhere near the global
     * 100/minute, so a 429 here can only have come from the per-endpoint rule.
     *
     * They also do not double-count: the counters live under separate key
     * namespaces (`rl:identity:link-code:` and `rl:global:authenticated:`), so
     * one request increments each exactly once.
     */
    const cookie = await onboard('minter2@example.test', 'student');
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await post('/api/v1/links/code', {}, cookie);
    }

    // The global counter saw six requests, not twelve, and is nowhere near its
    // own limit — so the rejection above was the endpoint's, not the backstop's.
    const globalCount = await harness.container.cache.get(
      `rl:global:authenticated:${(await harness.identity.service.validateSession(cookie)).userId}`,
    );
    expect(Number(globalCount)).toBeLessThanOrEqual(7);
    expect(Number(globalCount)).toBeGreaterThan(0);
  });

  it('is keyed per student — one student minting does not block another', async () => {
    const first = await onboard('minter3@example.test', 'student');
    const second = await onboard('minter4@example.test', 'student');

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await post('/api/v1/links/code', {}, first);
    }
    expect((await post('/api/v1/links/code', {}, first)).statusCode).toBe(429);

    expect((await post('/api/v1/links/code', {}, second)).statusCode).toBe(201);
  });

  it('lets the student back in once the hour has passed', async () => {
    // Through the injected clock. No sleep.
    const cookie = await onboard('minter5@example.test', 'student');
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await post('/api/v1/links/code', {}, cookie);
    }
    expect((await post('/api/v1/links/code', {}, cookie)).statusCode).toBe(429);

    harness.clock.advanceMs(60 * 60 * 1000 + 1);

    expect((await post('/api/v1/links/code', {}, cookie)).statusCode).toBe(201);
  });
});

describe('the global authenticated limit is really wired to module routes', () => {
  it('throttles an authenticated GET after 100 requests in a minute', async () => {
    /**
     * THE WIRING TEST, and it is the one that matters most for this feature.
     *
     * `app/__tests__/authenticated-rate-limit.test.ts` covers the plugin's
     * behaviour against a stand-in preHandler. This covers the thing that
     * behaviour depends on and that no unit test can see: that the hook is
     * appended AFTER identity's real `requireSession`, so `request.actor` is
     * populated by the time it runs.
     *
     * Registered the other way round, every assertion in the plugin's own file
     * still passes and the limiter silently counts nothing.
     */
    const cookie = await onboard('chatty@example.test', 'student');

    let lastStatus = 0;
    for (let attempt = 0; attempt < 101; attempt += 1) {
      lastStatus = (await get('/api/v1/links/code', cookie)).statusCode;
    }

    expect(lastStatus).toBe(429);
  });
});

/**
 * =============================================================================
 * POST /api/v1/auth/resend-verification — D-291.
 *
 * The eighth `/auth/*` route, and the one D-217 assumed was already there. Its
 * whole contract is HTTP-shaped, which is why these live here: one status, one
 * body, three branches behind it that the caller cannot tell apart.
 * =============================================================================
 */
describe('POST /api/v1/auth/resend-verification — D-291', () => {
  it('EXISTS. Before this it was a 404, and D-217 depended on it', async () => {
    const response = await post('/api/v1/auth/resend-verification', {
      email: 'anyone@example.test',
    });

    // The assertion that would have caught the defect: the audit found seven
    // /auth/* routes and this was not one of them.
    expect(response.statusCode).not.toBe(404);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('ANSWERS IDENTICALLY for unknown, unverified and already-verified', async () => {
    // An account awaiting verification…
    await post('/api/v1/auth/signup', {
      email: 'waiting@example.test',
      password: GOOD_PASSWORD,
      role: 'student',
    });
    // …and one that has finished.
    await onboard('finished@example.test', 'student');

    const unknown = await post('/api/v1/auth/resend-verification', {
      email: 'nobody@example.test',
    });
    const unverified = await post('/api/v1/auth/resend-verification', {
      email: 'waiting@example.test',
    });
    const verified = await post('/api/v1/auth/resend-verification', {
      email: 'finished@example.test',
    });

    // Identical AND correct. Without the status assertion this test is happy
    // with three identical 404s, which is the state the defect was in.
    expect(unknown.statusCode).toBe(200);
    // BYTE-IDENTICAL, all three. Two bits are being withheld here rather than
    // one: whether the address has an account, and if so whether it is verified.
    expect(unverified.statusCode).toBe(unknown.statusCode);
    expect(verified.statusCode).toBe(unknown.statusCode);
    expect(unverified.body).toBe(unknown.body);
    expect(verified.body).toBe(unknown.body);
  });

  it('returns the same body as forgot-password, which it is modelled on', async () => {
    const resend = await post('/api/v1/auth/resend-verification', {
      email: 'nobody@example.test',
    });
    const forgot = await post('/api/v1/auth/forgot-password', { email: 'nobody@example.test' });

    expect(resend.statusCode).toBe(forgot.statusCode);
    expect(resend.body).toBe(forgot.body);
  });

  it('rejects a malformed email with a 400, before any lookup', async () => {
    const response = await post('/api/v1/auth/resend-verification', { email: 'not-an-email' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('RATE LIMITS: ten from one IP in an hour, and the ELEVENTH is a 429', async () => {
    // The IP counter is `TOKEN_ENDPOINT_RATE_LIMIT`, shared with verify and
    // reset-password. Ten is the literal — see D-292 and
    // `identity.rate-limit-policy.test.ts`. Each request uses a DIFFERENT
    // address so that the per-address counter is not what fires first.
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const allowed = await post('/api/v1/auth/resend-verification', {
        email: `flood-${attempt}@example.test`,
      });
      expect(allowed.statusCode).toBe(200);
    }

    const refused = await post('/api/v1/auth/resend-verification', {
      email: 'flood-11@example.test',
    });
    expect(refused.statusCode).toBe(429);
  });

  it('lets the caller back in once the hour has passed', async () => {
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      await post('/api/v1/auth/resend-verification', { email: `lapse-${attempt}@example.test` });
    }
    expect(
      (await post('/api/v1/auth/resend-verification', { email: 'lapse-x@example.test' }))
        .statusCode,
    ).toBe(429);

    // Through the injected clock. No sleep.
    harness.clock.advanceMs(60 * 60 * 1000 + 1);

    expect(
      (await post('/api/v1/auth/resend-verification', { email: 'lapse-y@example.test' }))
        .statusCode,
    ).toBe(200);
  });

  it('completes the journey: signup, resend, verify, log in', async () => {
    // The end-to-end point of the whole fix. The first verification email is
    // ignored entirely — this is the user for whom it never arrived.
    await post('/api/v1/auth/signup', {
      email: 'rescued@example.test',
      password: GOOD_PASSWORD,
      role: 'student',
    });

    const resend = await post('/api/v1/auth/resend-verification', {
      email: 'rescued@example.test',
    });
    expect(resend.statusCode).toBe(200);

    // A SECOND email, and the journey continues on ITS token — not on the one
    // from signup, which in the case this endpoint exists for never arrived.
    expect(harness.mail.sent).toHaveLength(2);

    const verify = await get(`/api/v1/auth/verify?token=${encodeURIComponent(lastVerifyToken())}`);
    expect(verify.statusCode).toBe(302);

    const login = await post('/api/v1/auth/login', {
      email: 'rescued@example.test',
      password: GOOD_PASSWORD,
    });
    expect(login.statusCode).toBe(200);
    expect(loginResponseSchema.parse(login.json()).user.emailVerifiedAt).not.toBeNull();
  });
});
