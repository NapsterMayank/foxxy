import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { loginResponseSchema } from '@/shared/contracts/identity.contract';
import {
  TEST_COOKIE_NAME,
  onboardAccount,
  startAppHarness,
  type AppHarness,
} from '../helpers/app-harness';

/**
 * ===========================================================================
 * THE FRONTEND'S SESSION BOOTSTRAP — 02-FRONTEND-IMPLEMENTATION-PLAN.md §5.5.
 *
 * §5.5 makes one endpoint the single source of truth for "am I authenticated,
 * and as whom", and forbids any other route to that question. It originally
 * named `GET /me/profile`, and this file exists because that route CANNOT
 * answer it — a fact only visible with identity AND learner both mounted,
 * which is exactly what this harness does and what the identity-only route
 * suite cannot.
 *
 * Three properties, and the frontend's whole session model rests on them:
 *
 *   1. A signed-in PARENT gets 200 from the bootstrap and 403 from
 *      `/me/profile` — authz refuses a parent reading a student profile before
 *      any row is looked for. Not a bug in learner; it is what that route is
 *      for, and it is precisely why it cannot be the oracle.
 *   2. An un-onboarded STUDENT gets 404 from `/me/profile` for an entirely
 *      different reason. So the two commonest authenticated states on a fresh
 *      page load produce two different error statuses, neither of which means
 *      "signed in" anywhere else in the error table.
 *   3. No session is 401 from the bootstrap. That is the ONE signal §5.5's
 *      mid-session-expiry rule keys on.
 * ===========================================================================
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

describe('GET /api/v1/auth/me is the only route that can answer "who am I"', () => {
  it('answers a parent 200 where /me/profile answers 404', async () => {
    const parent = await onboardAccount(harness, 'mum@example.test', 'parent');

    const bootstrap = await get('/api/v1/auth/me', parent.cookie);
    expect(bootstrap.statusCode).toBe(200);
    expect(loginResponseSchema.parse(bootstrap.json())).toMatchObject({
      user: { role: 'parent', email: 'mum@example.test' },
    });

    /*
     * THE REASON THE BOOTSTRAP MOVED. Same live session, same instant — and
     * the status is 403, which is worse for a client than the 404 one might
     * expect: authz refuses a parent reading a student profile before the row
     * is ever looked for. §5.6 assigns 403-on-a-GET the treatment "show a
     * no-access state carrying no detail", so a frontend bootstrapping here
     * would have to read "you are signed in" out of the one response the error
     * table says means the opposite.
     */
    expect((await get('/api/v1/me/profile', parent.cookie)).statusCode).toBe(403);
  });

  it('answers an un-onboarded student 200 where /me/profile also answers 404', async () => {
    const student = await onboardAccount(harness, 'kid@example.test', 'student');

    const bootstrap = await get('/api/v1/auth/me', student.cookie);
    expect(bootstrap.statusCode).toBe(200);
    expect(loginResponseSchema.parse(bootstrap.json()).user.role).toBe('student');

    // The SAME 404 as the parent above, for an unrelated reason: this account
    // has simply not finished onboarding. One status, two states — which is
    // what makes `/me/profile` unusable as the oracle.
    expect((await get('/api/v1/me/profile', student.cookie)).statusCode).toBe(404);
  });

  it('answers 401 without a session, and clears the rejected cookie', async () => {
    expect((await get('/api/v1/auth/me')).statusCode).toBe(401);

    const rejected = await get('/api/v1/auth/me', 'not-a-real-session-token');
    expect(rejected.statusCode).toBe(401);
    expect(String(rejected.headers['set-cookie'])).toContain(`${TEST_COOKIE_NAME}=;`);
  });
});
