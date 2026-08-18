import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OnboardingRequest } from '@/shared/contracts/learner.contract';
import {
  TEST_COOKIE_NAME,
  TEST_TENANT_ID,
  onboardAccount,
  startAppHarness,
  type AppHarness,
} from '../../../../tests/helpers/app-harness';
import { insertChapter, insertRagChunk, makeChapter, makeRagChunk } from '../../../../tests/fixtures/index';

/**
 * ============================================================================
 * THE STREAM, OVER A REAL SOCKET. The only test in the repository that opens
 * one, and it exists because of a defect nothing else could see.
 *
 * Every other HTTP test runs through `app.inject`, which calls the handler
 * stack directly: real routing, real plugins, real Postgres — NO SOCKET. That
 * is fast and correct for almost everything, and it has one blind spot that
 * matters here.
 *
 * `POST /foxy/sessions/:id/messages` HIJACKS the reply so it can push SSE
 * frames, and `@fastify/cors` sets its headers in an `onSend` hook that a
 * hijacked reply never reaches. So the product's one streaming endpoint went
 * out with no `access-control-allow-origin` while every other route had one,
 * and EVERY BROWSER BLOCKED EVERY FOXY TURN.
 *
 * All 3,220 tests passed throughout. `app.inject` does not enforce CORS and
 * does not surface headers written straight to the raw socket; curl does not
 * enforce CORS either. It took driving the real UI against the real API to find
 * it — which is exactly the class of failure `PROGRESS.md` names as the one
 * three audits could not reach.
 *
 * So this file listens on an ephemeral port and speaks HTTP.
 * ============================================================================
 */

const ONBOARDING: OnboardingRequest = {
  displayName: 'Socket Student',
  grade: '8',
  board: 'CBSE',
  preferredLanguage: 'en',
  subjects: ['science'],
};

/**
 * THE CORS ALLOW-LIST AND THE CSRF ORIGIN ALLOW-LIST ARE NOT THE SAME LIST.
 *
 * `HARNESS_ORIGIN` (`http://app.test`) is `APP_URL`, which the origin check
 * accepts for state-changing requests. The CORS plugin is registered with
 * `CORS_READ_ORIGINS`, which the harness sets to `http://localhost:3000` — so
 * that, not `HARNESS_ORIGIN`, is the origin a browser gets CORS headers for.
 *
 * D-082 split those two lists on purpose. Asserting against the wrong one is
 * how you conclude a working implementation is broken, which cost a round trip
 * here.
 */
const CORS_ORIGIN = 'http://localhost:3000';

let harness: AppHarness;
let origin: string;

beforeAll(async () => {
  harness = await startAppHarness();
  // Port 0 — the OS picks a free one, so a busy machine cannot make this flaky.
  await harness.app.listen({ port: 0, host: '127.0.0.1' });
  const address = harness.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no socket address');
  origin = `http://127.0.0.1:${String(address.port)}`;
}, 120_000);

afterAll(async () => {
  await harness.stop();
});

describe('the SSE turn, spoken over a real socket', () => {
  it('carries the CORS headers a browser requires', async () => {
    const chapterId = await insertChapter(
      harness.postgres.client,
      makeChapter('sse-socket', { grade: '8', subjectCode: 'science', chapterNumber: 11 }),
    );
    await insertRagChunk(
      harness.postgres.client,
      makeRagChunk('sse-socket-chunk', {
        grade: '8',
        subject: 'science',
        chapterNumber: 11,
        chapterTitle: 'Light',
        chunkText: 'Light bends when it enters a denser medium.',
      }),
      chapterId,
    );

    const account = await onboardAccount(harness, 'socket-student@example.test', 'student');
    await harness.learner.service.createProfile(
      { userId: account.userId, role: 'student', tenantId: TEST_TENANT_ID },
      ONBOARDING,
    );

    const started = await fetch(`${origin}/api/v1/foxy/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: CORS_ORIGIN,
        cookie: `${TEST_COOKIE_NAME}=${account.cookie}`,
      },
      body: JSON.stringify({ mode: 'doubt', subject: 'science' }),
    });
    expect(started.status).toBe(201);
    const { session } = (await started.json()) as { session: { id: string } };

    const response = await fetch(`${origin}/api/v1/foxy/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: CORS_ORIGIN,
        cookie: `${TEST_COOKIE_NAME}=${account.cookie}`,
      },
      body: JSON.stringify({ text: 'why does light bend' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    /*
     * THE ASSERTION THIS FILE EXISTS FOR. Without these two headers a browser
     * discards the response before a single frame reaches the application, and
     * the student sees a chat that never answers.
     */
    expect(response.headers.get('access-control-allow-origin')).toBe(CORS_ORIGIN);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    // A cache that ignored `Origin` would hand one origin's stream to another.
    expect(response.headers.get('vary')).toContain('Origin');

    // Drain it, so the socket closes before the harness stops.
    await response.text();
  }, 60_000);

  /*
   * The headers are set for the ALLOWED origin only. A hook that echoed
   * whatever arrived would be a reflected-origin CORS policy, which is the
   * thing `plugins/cors.ts` refuses to be — "never a reflected origin and never
   * `*`".
   */
  it('does not hand its headers to an origin that is not allow-listed', async () => {
    const account = await onboardAccount(harness, 'socket-student-2@example.test', 'student');
    await harness.learner.service.createProfile(
      { userId: account.userId, role: 'student', tenantId: TEST_TENANT_ID },
      ONBOARDING,
    );

    const response = await fetch(`${origin}/api/v1/foxy/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://evil.test',
        cookie: `${TEST_COOKIE_NAME}=${account.cookie}`,
      },
      body: JSON.stringify({ mode: 'doubt', subject: 'science' }),
    });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  }, 60_000);
});
