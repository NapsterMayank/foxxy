import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  HARNESS_ORIGIN,
  TEST_COOKIE_NAME,
  TEST_TENANT_ID,
  onboardAccount,
  startAppHarness,
  type AppHarness,
  type HarnessAccount,
} from '../helpers/app-harness';
import { insertChapter, insertQuestion, makeChapter, makeQuestion } from '../fixtures/index';

/**
 * =============================================================================
 * D-401 — `X-Visit-Id`, END TO END, THROUGH A REAL SERVER AND A REAL DATABASE.
 *
 * The unit test in `src/shared/http/__tests__/visit-id.test.ts` pins the PARSE.
 * This one pins the thing the parse exists for and that no unit test can see:
 * that a header a browser sends survives the route, the service and the
 * repository, and arrives in the column — on BOTH tables, which are owned by
 * two modules that share no code.
 *
 * That gap is where this feature would silently fail. A visit id that stopped
 * at the route would leave the column NULL, every existing test would still
 * pass, and the symptom would be an ops view that says every student always did
 * exactly one visit — a number that looks like data.
 *
 * -----------------------------------------------------------------------------
 * THE VIEW IS ASSERTED HERE TOO, AND ONLY HERE.
 *
 * `v_learner_activity` is hand-written SQL in the migration; nothing in the
 * application imports it, so nothing else would notice if a future migration
 * dropped a branch of the UNION or renamed a column out from under it. It is
 * checked against rows this test created rather than against a fixture, so what
 * passes is "the view reports what actually happened".
 * =============================================================================
 */

let harness: AppHarness;

/** Two visits, as two tabs would produce. Distinct on their first character. */
const VISIT_A = '018f4b2c-9d3a-7c21-8f6e-1a2b3c4d5e6f';
const VISIT_B = '028f4b2c-9d3a-7c21-8f6e-1a2b3c4d5e6f';

beforeAll(async () => {
  harness = await startAppHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

function post(
  url: string,
  payload: unknown,
  cookie: string,
  visitId?: string,
): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url,
    headers: {
      // Every state-changing request carries an Origin, because every real one
      // does — the origin check runs before authentication.
      origin: HARNESS_ORIGIN,
      ...(visitId === undefined ? {} : { 'x-visit-id': visitId }),
    },
    payload: payload as Record<string, unknown>,
    cookies: { [TEST_COOKIE_NAME]: cookie },
  });
}

let counter = 0;

async function seed(): Promise<{ account: HarnessAccount; chapterId: string }> {
  counter += 1;
  const account = await onboardAccount(harness, `visit${counter}@example.test`, 'student');
  await harness.learner.service.createProfile(
    { userId: account.userId, role: 'student', tenantId: TEST_TENANT_ID },
    { displayName: `Visit ${counter}`, grade: '8', subjects: ['science'] },
  );

  const chapterId = await insertChapter(
    harness.postgres.client,
    makeChapter(`vc${counter}`, { grade: '8', subjectCode: 'science', chapterNumber: 1 }),
  );
  for (let index = 0; index < 4; index += 1) {
    await insertQuestion(
      harness.postgres.client,
      chapterId,
      makeQuestion(`vq${counter}-${index}`, { correctIndex: index % 4 }),
    );
  }
  return { account, chapterId };
}

async function visitIdOf(table: string, id: string): Promise<string | null> {
  const { rows } = await harness.postgres.client.query<{ visit_id: string | null }>(
    `select visit_id from ${table} where id = $1`,
    [id],
  );
  return rows[0]?.visit_id ?? null;
}

async function startPractice(
  chapterId: string,
  cookie: string,
  visitId?: string,
): Promise<string> {
  const response = await post('/api/v1/practice/sessions', { chapterId }, cookie, visitId);
  expect(response.statusCode).toBe(201);
  return response.json<{ session: { id: string } }>().session.id;
}

async function startChat(cookie: string, visitId?: string): Promise<string> {
  const response = await post(
    '/api/v1/foxy/sessions',
    { mode: 'doubt', subject: 'science' },
    cookie,
    visitId,
  );
  expect(response.statusCode).toBe(201);
  return response.json<{ session: { id: string } }>().session.id;
}

describe('X-Visit-Id reaches the column', () => {
  it('stamps a practice session', async () => {
    const { account, chapterId } = await seed();
    const sessionId = await startPractice(chapterId, account.cookie, VISIT_A);
    await expect(visitIdOf('practice_sessions', sessionId)).resolves.toBe(VISIT_A);
  });

  it('stamps a chat session', async () => {
    const { account } = await seed();
    const sessionId = await startChat(account.cookie, VISIT_A);
    await expect(visitIdOf('chat_sessions', sessionId)).resolves.toBe(VISIT_A);
  });

  it('normalises case on the way in', async () => {
    // Two requests in one visit that differ only in case must not group as two.
    const { account, chapterId } = await seed();
    const sessionId = await startPractice(chapterId, account.cookie, VISIT_A.toUpperCase());
    await expect(visitIdOf('practice_sessions', sessionId)).resolves.toBe(VISIT_A);
  });
});

describe('a missing or unusable visit id is not an error', () => {
  it('starts a session with no header at all', async () => {
    // curl, a mobile client, a proxy with a header allow-list. A correlation
    // label must never be the reason a student cannot practise.
    const { account, chapterId } = await seed();
    const sessionId = await startPractice(chapterId, account.cookie);
    await expect(visitIdOf('practice_sessions', sessionId)).resolves.toBeNull();
  });

  it('starts a session and stores NULL when the header is not a uuid', async () => {
    // The column holds a uuid or nothing — never what the caller typed.
    const { account, chapterId } = await seed();
    const sessionId = await startPractice(chapterId, account.cookie, "' OR 1=1 --");
    await expect(visitIdOf('practice_sessions', sessionId)).resolves.toBeNull();
  });
});

describe('v_learner_activity', () => {
  it('reports one day of chat and practice as the visits it actually was', async () => {
    const { account, chapterId } = await seed();

    // Visit A: the student practises twice and asks Foxy something.
    await startPractice(chapterId, account.cookie, VISIT_A);
    await startPractice(chapterId, account.cookie, VISIT_A);
    await startChat(account.cookie, VISIT_A);
    // Visit B: they come back later and open one chapter.
    await startPractice(chapterId, account.cookie, VISIT_B);

    const { rows } = await harness.postgres.client.query<{
      visit_id: string;
      kind: string;
      outcome: string;
      count: string;
    }>(
      `select visit_id, kind, outcome, count(*)::text as count
         from v_learner_activity
        where student_user_id = $1
        group by visit_id, kind, outcome
        order by visit_id, kind`,
      [account.userId],
    );

    // THE QUESTION THAT HAD NO ANSWER BEFORE THIS MIGRATION: four activities,
    // two sittings — not "four things at some point on Tuesday".
    expect(rows).toEqual([
      { visit_id: VISIT_A, kind: 'chat', outcome: 'empty', count: '1' },
      { visit_id: VISIT_A, kind: 'practice', outcome: 'open', count: '2' },
      { visit_id: VISIT_B, kind: 'practice', outcome: 'open', count: '1' },
    ]);
  });

  it('labels each lifecycle in its own vocabulary', async () => {
    // A chat session that was opened and never spoken in is 'empty'; a practice
    // session that was started and not submitted is 'open'. They are different
    // facts and the view refuses to flatten them into one `completed` flag.
    const { account, chapterId } = await seed();
    await startChat(account.cookie, VISIT_A);
    await startPractice(chapterId, account.cookie, VISIT_A);

    const { rows } = await harness.postgres.client.query<{ kind: string; outcome: string }>(
      `select kind, outcome from v_learner_activity
        where student_user_id = $1 order by kind`,
      [account.userId],
    );

    expect(rows).toEqual([
      { kind: 'chat', outcome: 'empty' },
      { kind: 'practice', outcome: 'open' },
    ]);
  });

  it('carries the tenant so a caller can scope by it', async () => {
    // The view has no access check of its own — it is for operations, not for a
    // route — so `tenant_id` must be present for a human to filter on.
    const { account, chapterId } = await seed();
    await startPractice(chapterId, account.cookie, VISIT_A);

    const { rows } = await harness.postgres.client.query<{ tenant_id: string }>(
      `select tenant_id from v_learner_activity where student_user_id = $1`,
      [account.userId],
    );
    expect(rows).toEqual([{ tenant_id: TEST_TENANT_ID }]);
  });
});
