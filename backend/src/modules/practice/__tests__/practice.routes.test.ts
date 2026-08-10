import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { errorResponseSchema } from '@/shared/contracts/identity.contract';
import { z } from 'zod';
import {
  answerResultSchema,
  historyResponseSchema,
  missionResponseSchema,
  practiceSessionResponseSchema,
  progressResponseSchema,
  submissionResponseSchema,
} from '@/shared/contracts/practice.contract';

/** The answers endpoint's envelope. The only response shape with no named wrapper. */
const answerResultResponseSchema = z.object({ result: answerResultSchema });
import {
  HARNESS_ORIGIN,
  TEST_COOKIE_NAME,
  onboardAccount,
  startAppHarness,
  type AppHarness,
  type HarnessAccount,
} from '../../../../tests/helpers/app-harness';
import {
  insertChapter,
  insertQuestion,
  makeChapter,
  makeQuestion,
} from '../../../../tests/fixtures/index';

/**
 * practice route tests — the HTTP surface.
 *
 * Every success response is parsed with the SHARED CONTRACT SCHEMA rather than
 * checked field by field. That is what makes the contract real: if a route and
 * the schema the frontend imports ever disagree, these tests fail rather than
 * the frontend doing so at runtime.
 *
 * The last describe block is the one that matters most: it asserts that the
 * bytes on the wire carry no answer. A field that exists in
 * `shared/contracts/` exists in the browser, and a `correctIndex` in the
 * browser is a quiz with no questions in it.
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

function post(url: string, payload: unknown, cookie?: string): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url,
    // Every state-changing request carries an `Origin`, because every real one
    // does: the origin check (§6.10) refuses one that arrives without a
    // recognised origin, and it runs BEFORE authentication.
    headers: { origin: HARNESS_ORIGIN },
    payload: payload as Record<string, unknown>,
    ...(cookie === undefined ? {} : { cookies: { [TEST_COOKIE_NAME]: cookie } }),
  });
}

let counter = 0;

async function seed(): Promise<{ account: HarnessAccount; chapterId: string }> {
  counter += 1;
  const account = await onboardAccount(harness, `route${counter}@example.test`, 'student');
  const actor = { userId: account.userId, role: 'student' as const, tenantId: '11111111-1111-4111-8111-111111111111' };
  await harness.learner.service.createProfile(actor, {
    displayName: `Route ${counter}`,
    grade: '8',
    subjects: ['science'],
  });

  const chapterId = await insertChapter(
    harness.postgres.client,
    makeChapter(`rc${counter}`, { grade: '8', subjectCode: 'science', chapterNumber: 1 }),
  );
  for (let index = 0; index < 4; index += 1) {
    await insertQuestion(
      harness.postgres.client,
      chapterId,
      makeQuestion(`rq${counter}-${index}`, {
        correctIndex: index % 4,
        questionText: `Question ${index} correct=${index % 4}?`,
      }),
    );
  }
  return { account, chapterId };
}

/** Answers every question of a session through the HTTP surface. */
async function answerAll(
  sessionId: string,
  cookie: string,
  questions: readonly { id: string; questionText: string; options: string[] }[],
): Promise<void> {
  for (const question of questions) {
    const canonical = /correct=(\d)/.exec(question.questionText)?.[1] ?? '0';
    const position = question.options.findIndex((option) => option.endsWith(`option ${canonical}`));
    await post(
      `/api/v1/practice/sessions/${sessionId}/answers`,
      { questionId: question.id, selectedIndex: position, timeSpentMs: 12_000 },
      cookie,
    );
  }
}

describe('every practice endpoint requires a session', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['GET', '/api/v1/practice/mission'],
    ['GET', '/api/v1/practice/history'],
    ['GET', '/api/v1/practice/progress'],
    ['GET', '/api/v1/practice/sessions/00000000-0000-4000-8000-000000000000'],
  ];

  for (const [method, url] of cases) {
    it(`refuses ${method} ${url} without a cookie`, async () => {
      const response = await get(url);
      expect(response.statusCode).toBe(401);
      expect(errorResponseSchema.safeParse(response.json()).success).toBe(true);
    });
  }

  it('refuses POST /practice/sessions without a cookie', async () => {
    const response = await post('/api/v1/practice/sessions', {
      chapterId: '00000000-0000-4000-8000-000000000000',
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /practice/mission', () => {
  it('returns a mission that satisfies the shared contract', async () => {
    const { account } = await seed();
    const response = await get('/api/v1/practice/mission', account.cookie);

    expect(response.statusCode).toBe(200);
    const parsed = missionResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.mission?.reasonEn.length).toBeGreaterThan(0);
    expect(parsed.success && parsed.data.mission?.reasonHi.length).toBeGreaterThan(0);
  });
});

describe('POST /practice/sessions', () => {
  it('creates a session and answers 201', async () => {
    const { account, chapterId } = await seed();
    const response = await post(
      '/api/v1/practice/sessions',
      { chapterId, questionCount: 4 },
      account.cookie,
    );

    expect(response.statusCode).toBe(201);
    const parsed = practiceSessionResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.session.questions).toHaveLength(4);
  });

  it('rejects a malformed body with a 400', async () => {
    const { account } = await seed();
    const response = await post('/api/v1/practice/sessions', { chapterId: 'nope' }, account.cookie);
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.safeParse(response.json()).success).toBe(true);
  });

  it('rejects a question count above the maximum', async () => {
    const { account, chapterId } = await seed();
    const response = await post(
      '/api/v1/practice/sessions',
      { chapterId, questionCount: 500 },
      account.cookie,
    );
    expect(response.statusCode).toBe(400);
  });
});

describe('the full session, over HTTP', () => {
  it('starts, answers, submits and appears in history and progress', async () => {
    const { account, chapterId } = await seed();

    const started = await post(
      '/api/v1/practice/sessions',
      { chapterId, questionCount: 4 },
      account.cookie,
    );
    const session = practiceSessionResponseSchema.parse(started.json()).session;

    await answerAll(session.id, account.cookie, session.questions);

    const submitted = await post(
      `/api/v1/practice/sessions/${session.id}/submit`,
      {},
      account.cookie,
    );
    expect(submitted.statusCode).toBe(200);
    const result = submissionResponseSchema.parse(submitted.json()).result;
    expect(result.scorePercent).toBe(100);
    expect(result.isValid).toBe(true);

    const history = await get('/api/v1/practice/history', account.cookie);
    expect(history.statusCode).toBe(200);
    const entries = historyResponseSchema.parse(history.json()).sessions;
    expect(entries[0]?.sessionId).toBe(session.id);

    const progress = await get('/api/v1/practice/progress', account.cookie);
    expect(progress.statusCode).toBe(200);
    const parsedProgress = progressResponseSchema.parse(progress.json());
    expect(parsedProgress.totalXp).toBeGreaterThan(0);
  });

  it('answers 409 on a second submit', async () => {
    const { account, chapterId } = await seed();
    const started = await post(
      '/api/v1/practice/sessions',
      { chapterId, questionCount: 4 },
      account.cookie,
    );
    const session = practiceSessionResponseSchema.parse(started.json()).session;
    await answerAll(session.id, account.cookie, session.questions);
    await post(`/api/v1/practice/sessions/${session.id}/submit`, {}, account.cookie);

    const second = await post(
      `/api/v1/practice/sessions/${session.id}/submit`,
      {},
      account.cookie,
    );
    expect(second.statusCode).toBe(409);
    expect(errorResponseSchema.safeParse(second.json()).success).toBe(true);
  });

  it('answers 403 for another student’s session, with no payload', async () => {
    const owner = await seed();
    const started = await post(
      '/api/v1/practice/sessions',
      { chapterId: owner.chapterId, questionCount: 4 },
      owner.account.cookie,
    );
    const session = practiceSessionResponseSchema.parse(started.json()).session;

    counter += 1;
    const intruder = await onboardAccount(harness, `nosy${counter}@example.test`, 'student');
    const response = await get(`/api/v1/practice/sessions/${session.id}`, intruder.cookie);

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(session.id);
    expect(response.body).not.toContain(owner.chapterId);
    expect(response.body).not.toContain(owner.account.userId);
  });
});

describe('THE WIRE CARRIES NO ANSWER', () => {
  it('sends no correct index, explanation or misconception on a session', async () => {
    const { account, chapterId } = await seed();
    const started = await post(
      '/api/v1/practice/sessions',
      { chapterId, questionCount: 4 },
      account.cookie,
    );

    // The BYTES, not the parsed object: a field stripped by a schema on the way
    // out would still be in the body if the handler serialised it.
    expect(started.body).not.toContain('correctIndex');
    expect(started.body).not.toContain('correct_index');
    expect(started.body).not.toContain('explanation');
    expect(started.body).not.toContain('distractorMisconceptions');
    expect(started.body).not.toContain('Because of');
  });

  it('discloses the answer only AFTER the student has committed to one', async () => {
    const { account, chapterId } = await seed();
    const started = await post(
      '/api/v1/practice/sessions',
      { chapterId, questionCount: 4 },
      account.cookie,
    );
    const session = practiceSessionResponseSchema.parse(started.json()).session;
    const question = session.questions[0]!;

    const answered = await post(
      `/api/v1/practice/sessions/${session.id}/answers`,
      { questionId: question.id, selectedIndex: 0, timeSpentMs: 9_000 },
      account.cookie,
    );

    expect(answered.statusCode).toBe(200);
    // Parsed through the shared schema, like every other response here: it is
    // the schema that says an answer result CARRIES the explanation, and this
    // is the one endpoint where that is correct rather than a leak.
    const result = answerResultResponseSchema.parse(answered.json()).result;
    expect(result.explanation.length).toBeGreaterThan(0);
    expect(typeof result.isCorrect).toBe('boolean');
  });
});
