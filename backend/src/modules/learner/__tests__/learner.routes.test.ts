import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  masteryResponseSchema,
  onboardingResponseSchema,
  profileResponseSchema,
} from '@/shared/contracts/learner.contract';
import { errorResponseSchema } from '@/shared/contracts/identity.contract';
import {
  HARNESS_ORIGIN,
  TEST_COOKIE_NAME,
  onboardAccount,
  startAppHarness,
  type AppHarness,
  type HarnessAccount,
} from '../../../../tests/helpers/app-harness';

/**
 * learner route tests — the HTTP surface.
 *
 * Every success response is parsed with the SHARED CONTRACT SCHEMA rather than
 * checked field by field. That is what makes the contract real: if a route and
 * the schema the frontend imports ever disagree, these tests fail rather than
 * the frontend doing so at runtime.
 */

let harness: AppHarness;

beforeAll(async () => {
  harness = await startAppHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

function get(url: string, cookie?: string): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'GET',
    url,
    ...(cookie === undefined ? {} : { cookies: { [TEST_COOKIE_NAME]: cookie } }),
  });
}

function send(
  method: 'POST' | 'PATCH',
  url: string,
  payload: unknown,
  cookie?: string,
): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method,
    url,
    // Every state-changing request carries an `Origin`, because every real one
    // does: the origin check (§6.10) refuses one that arrives without a
    // recognised origin. Its own behaviour is tested in
    // `src/app/__tests__/origin-check.test.ts`.
    headers: { origin: HARNESS_ORIGIN },
    payload: payload as Record<string, unknown>,
    ...(cookie === undefined ? {} : { cookies: { [TEST_COOKIE_NAME]: cookie } }),
  });
}

const ONBOARDING = { displayName: 'Aarav', grade: '8', subjects: ['science', 'maths'] };

async function student(email: string): Promise<HarnessAccount> {
  return onboardAccount(harness, email, 'student');
}

describe('POST /api/v1/me/onboarding', () => {
  it('creates the profile and returns the contract shape', async () => {
    const account = await student('r1@example.test');
    const response = await send('POST', '/api/v1/me/onboarding', ONBOARDING, account.cookie);

    expect(response.statusCode).toBe(200);
    const body = onboardingResponseSchema.parse(response.json());
    expect(body.created).toBe(true);
    expect(body.profile.grade).toBe('8');
    expect(body.subjects).toEqual(['maths', 'science']);
  });

  it('returns the SAME status code on a repeat, with created: false', async () => {
    // Not 201-then-200. A client retrying after a dropped connection cannot
    // tell which of its two attempts arrived, so a status that differs between
    // them is a difference it can only misread.
    const account = await student('r2@example.test');
    const first = await send('POST', '/api/v1/me/onboarding', ONBOARDING, account.cookie);
    const second = await send('POST', '/api/v1/me/onboarding', ONBOARDING, account.cookie);

    expect(second.statusCode).toBe(first.statusCode);
    expect(onboardingResponseSchema.parse(second.json()).created).toBe(false);
  });

  it('400s on a grade sent as a NUMBER', async () => {
    // The §8.2 rule, over real HTTP. JSON carries a genuine number here, which
    // is the exact case the database cannot refuse (D-038).
    const account = await student('r3@example.test');
    const response = await send(
      'POST',
      '/api/v1/me/onboarding',
      { ...ONBOARDING, grade: 8 },
      account.cookie,
    );

    expect(response.statusCode).toBe(400);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('grade');
  });

  it('400s on a grade outside "6".."12"', async () => {
    const account = await student('r4@example.test');
    const response = await send(
      'POST',
      '/api/v1/me/onboarding',
      { ...ONBOARDING, grade: '13' },
      account.cookie,
    );
    expect(response.statusCode).toBe(400);
  });

  it('401s with no session', async () => {
    const response = await send('POST', '/api/v1/me/onboarding', ONBOARDING);
    expect(response.statusCode).toBe(401);
  });

  it('403s a cross-site POST with no Origin, before authentication', async () => {
    // Deliberate ordering: the CSRF verdict must not depend on who the caller
    // claims to be (D-035). Recorded here because the frontend has to handle a
    // 403 on POST as "session expired" as well as "forbidden".
    const account = await student('r5@example.test');
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/me/onboarding',
      payload: ONBOARDING,
      cookies: { [TEST_COOKIE_NAME]: account.cookie },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /api/v1/me/profile', () => {
  it('returns the caller’s own profile', async () => {
    const account = await student('r6@example.test');
    await send('POST', '/api/v1/me/onboarding', ONBOARDING, account.cookie);

    const response = await get('/api/v1/me/profile', account.cookie);
    expect(response.statusCode).toBe(200);
    const body = profileResponseSchema.parse(response.json());
    expect(body.profile.userId).toBe(account.userId);
  });

  it('404s before onboarding', async () => {
    const account = await student('r7@example.test');
    expect((await get('/api/v1/me/profile', account.cookie)).statusCode).toBe(404);
  });

  it('401s with no session', async () => {
    expect((await get('/api/v1/me/profile')).statusCode).toBe(401);
  });

  it('has NO endpoint that takes another student’s id', async () => {
    // The route surface is `/me/…` only. There is no path parameter to change,
    // which is a structural guarantee on top of the service's access check —
    // the check stays because the day someone adds `/students/:id/profile`, it
    // is already in the right place.
    const alice = await student('r8@example.test');
    const bob = await student('r9@example.test');
    await send('POST', '/api/v1/me/onboarding', ONBOARDING, bob.cookie);

    const response = await get(`/api/v1/students/${bob.userId}/profile`, alice.cookie);
    expect(response.statusCode).toBe(404);
  });
});

describe('PATCH /api/v1/me/profile', () => {
  it('applies a partial update', async () => {
    const account = await student('r10@example.test');
    await send('POST', '/api/v1/me/onboarding', ONBOARDING, account.cookie);

    const response = await send(
      'PATCH',
      '/api/v1/me/profile',
      { displayName: 'Aarav K' },
      account.cookie,
    );

    expect(response.statusCode).toBe(200);
    const body = profileResponseSchema.parse(response.json());
    expect(body.profile.displayName).toBe('Aarav K');
    expect(body.profile.grade).toBe('8');
  });

  it('400s on an EMPTY patch', async () => {
    const account = await student('r11@example.test');
    await send('POST', '/api/v1/me/onboarding', ONBOARDING, account.cookie);
    expect((await send('PATCH', '/api/v1/me/profile', {}, account.cookie)).statusCode).toBe(400);
  });

  it('400s on a numeric grade — the quieter of the two doors', async () => {
    const account = await student('r12@example.test');
    await send('POST', '/api/v1/me/onboarding', ONBOARDING, account.cookie);
    expect(
      (await send('PATCH', '/api/v1/me/profile', { grade: 9 }, account.cookie)).statusCode,
    ).toBe(400);
  });
});

describe('GET /api/v1/me/mastery', () => {
  it('returns an empty list before any practice', async () => {
    const account = await student('r13@example.test');
    await send('POST', '/api/v1/me/onboarding', ONBOARDING, account.cookie);

    const response = await get('/api/v1/me/mastery', account.cookie);
    expect(response.statusCode).toBe(200);
    expect(masteryResponseSchema.parse(response.json()).mastery).toEqual([]);
  });

  it('401s with no session', async () => {
    expect((await get('/api/v1/me/mastery')).statusCode).toBe(401);
  });

  it('has NO endpoint that WRITES mastery', async () => {
    // Deliberate: §8.2 lists no such endpoint. Mastery is derived from
    // practice, and a route that let a client post its own would let a student
    // declare themselves expert and make every parent report meaningless.
    const account = await student('r14@example.test');
    await send('POST', '/api/v1/me/onboarding', ONBOARDING, account.cookie);

    const response = await send(
      'POST',
      '/api/v1/me/mastery',
      { chapterId: '00000000-0000-0000-0000-000000000000', masteryScore: 1 },
      account.cookie,
    );
    expect(response.statusCode).toBe(404);
  });
});
