import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeLlm } from '@/platform/llm/index';
import { FOXY_ACTIONS, FOXY_DAILY_MESSAGE_LIMIT, FOXY_MODES } from '@/shared/constants/foxy';
import type { OnboardingRequest } from '@/shared/contracts/learner.contract';
import {
  HARNESS_ORIGIN,
  TEST_COOKIE_NAME,
  TEST_TENANT_ID,
  onboardAccount,
  startAppHarness,
  type AppHarness,
  type HarnessAccount,
} from '../../../../tests/helpers/app-harness';
import { insertChapter, insertRagChunk, makeChapter, makeRagChunk } from '../../../../tests/fixtures/index';
import { usageCacheKey } from '../domain/usage';

/**
 * ============================================================================
 * foxy HTTP TESTS — the five endpoints, over a real server.
 *
 * The one that matters is `POST /messages`. It is the only streaming endpoint
 * in the product, and it has a property no other route has:
 *
 *   EVERYTHING WITH A STATUS CODE HAPPENS BEFORE THE FIRST BYTE, AND
 *   EVERYTHING AFTER IT IS A FRAME.
 *
 * A 403, a 404 and a 429 must arrive as ordinary JSON error responses. A model
 * failure must arrive as an `error` FRAME inside a 200, because by then the
 * status is committed and there is nothing left to change. Both halves are
 * asserted below, because getting either one wrong produces the same symptom
 * from the outside — a spinner that never stops.
 * ============================================================================
 */

let harness: AppHarness;

const ONBOARDING: OnboardingRequest = {
  displayName: 'Aarav',
  grade: '8',
  subjects: ['science', 'maths'],
};

const NOBODY = '99999999-9999-4999-8999-999999999999';

let emailCounter = 0;
function nextEmail(prefix: string): string {
  emailCounter += 1;
  return `${prefix}${emailCounter}@example.test`;
}

async function makeStudentAccount(): Promise<HarnessAccount> {
  const account = await onboardAccount(harness, nextEmail('httpstudent'), 'student');
  await harness.learner.service.createProfile(
    { userId: account.userId, role: 'student', tenantId: TEST_TENANT_ID },
    ONBOARDING,
  );
  return account;
}

async function seedChunk(): Promise<string> {
  const chapterId = await insertChapter(
    harness.postgres.client,
    makeChapter('light', {
      grade: '8',
      subjectCode: 'science',
      chapterNumber: 10,
      titleEn: 'Light',
    }),
  );
  return await insertRagChunk(
    harness.postgres.client,
    makeRagChunk('light-seed', {
      grade: '8',
      subject: 'science',
      chapterNumber: 10,
      chapterTitle: 'Light',
      chunkText: 'Light bends when it enters a denser medium.',
    }),
    chapterId,
  );
}

function get(url: string, account: HarnessAccount): Promise<{ statusCode: number; body: string }> {
  return harness.app.inject({ method: 'GET', url, cookies: { [TEST_COOKIE_NAME]: account.cookie } });
}

function post(
  url: string,
  account: HarnessAccount,
  payload: unknown,
): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> {
  return harness.app.inject({
    method: 'POST',
    url,
    headers: { origin: HARNESS_ORIGIN },
    cookies: { [TEST_COOKIE_NAME]: account.cookie },
    payload: payload as Record<string, unknown>,
  });
}

/** Parses an SSE body into `{ event, data }` pairs. */
function parseFrames(body: string): { event: string; data: Record<string, unknown> }[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const event = (lines.find((line) => line.startsWith('event: ')) ?? '').slice(7);
      const data = (lines.find((line) => line.startsWith('data: ')) ?? '').slice(6);
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

async function startSession(account: HarnessAccount): Promise<string> {
  const response = await post('/api/v1/foxy/sessions', account, {
    mode: 'doubt',
    subject: 'science',
  });
  return (JSON.parse(response.body) as { session: { id: string } }).session.id;
}

beforeAll(async () => {
  harness = await startAppHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

describe('POST /api/v1/foxy/sessions', () => {
  it('creates a conversation and returns 201', async () => {
    const student = await makeStudentAccount();
    const response = await post('/api/v1/foxy/sessions', student, {
      mode: 'explain',
      subject: 'science',
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { session: Record<string, unknown> };
    expect(body.session).toMatchObject({ mode: 'explain', subject: 'science' });
    // ISO STRINGS on the wire, never a serialised Date (D-124).
    expect(typeof body.session.startedAt).toBe('string');
    expect(Number.isNaN(new Date(String(body.session.startedAt)).getTime())).toBe(false);
    // No student id on the wire. There is no field a caller could change.
    expect(response.body).not.toContain(student.userId);
  });

  it('401s without a session cookie', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/foxy/sessions',
      headers: { origin: HARNESS_ORIGIN },
      payload: { mode: 'doubt', subject: 'science' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('400s on a mode or subject outside the closed set', async () => {
    const student = await makeStudentAccount();
    expect(
      (await post('/api/v1/foxy/sessions', student, { mode: 'freestyle', subject: 'science' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post('/api/v1/foxy/sessions', student, { mode: 'doubt', subject: 'astrology' }))
        .statusCode,
    ).toBe(400);
  });
});

describe('POST /api/v1/foxy/sessions/:id/messages — the stream', () => {
  it('answers 200 with an event-stream and a terminating `done` frame', async () => {
    await seedChunk();
    const student = await makeStudentAccount();
    const sessionId = await startSession(student);

    const response = await post(`/api/v1/foxy/sessions/${sessionId}/messages`, student, {
      text: 'why does light bend',
    });

    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'])).toContain('text/event-stream');
    // Without this a proxy buffers the body and the stream silently stops
    // being a stream — perfect in development, broken in production.
    expect(response.headers['x-accel-buffering']).toBe('no');

    const frames = parseFrames(response.body);
    expect(frames.some((frame) => frame.event === 'token')).toBe(true);
    expect(frames.at(-1)?.event).toBe('done');
  });

  it('delivers an ABSTENTION as a 200 with an `abstention` frame, not an error', async () => {
    // No chunks seeded — a genuine `no-candidates` abstention.
    const student = await makeStudentAccount();
    const sessionId = await startSession(student);

    const response = await post(`/api/v1/foxy/sessions/${sessionId}/messages`, student, {
      text: 'why does light bend',
    });

    expect(response.statusCode).toBe(200);
    const frames = parseFrames(response.body);
    expect(frames.map((frame) => frame.event)).toEqual(['abstention', 'done']);
    expect(frames[0]?.data.reason).toBe('no_results');
    expect(String(frames[0]?.data.text).length).toBeGreaterThan(0);
  });

  it('a mid-stream model failure is a 200 with an `error` FRAME, never a 500', async () => {
    harness.useLlm(
      createFakeLlm({ respond: () => 'Light bends when it enters a denser medium.', failAfter: 2 }),
    );
    await seedChunk();
    const student = await makeStudentAccount();
    const sessionId = await startSession(student);

    const response = await post(`/api/v1/foxy/sessions/${sessionId}/messages`, student, {
      text: 'why does light bend',
    });

    // THE WHOLE POINT. By the time the model failed the status was already 200
    // and the tokens were already on the wire.
    expect(response.statusCode).toBe(200);
    const frames = parseFrames(response.body);
    expect(frames.filter((frame) => frame.event === 'token')).toHaveLength(2);
    expect(frames.find((frame) => frame.event === 'error')?.data).toMatchObject({
      code: 'model_unavailable',
      partial: true,
    });
    expect(frames.at(-1)?.event).toBe('done');
  });

  it('403s BEFORE any byte when the conversation belongs to somebody else', async () => {
    const owner = await makeStudentAccount();
    const stranger = await makeStudentAccount();
    const sessionId = await startSession(owner);

    const response = await post(`/api/v1/foxy/sessions/${sessionId}/messages`, stranger, {
      text: 'hello',
    });

    expect(response.statusCode).toBe(403);
    // A JSON error, NOT an event-stream: nothing was written before the guard.
    expect(String(response.headers['content-type'])).toContain('application/json');
    expect(response.body).not.toContain(owner.userId);
    expect(response.body).not.toContain(sessionId);
  });

  it('404s for a conversation that does not exist', async () => {
    const student = await makeStudentAccount();
    const response = await post(`/api/v1/foxy/sessions/${NOBODY}/messages`, student, {
      text: 'hello',
    });
    expect(response.statusCode).toBe(404);
  });

  it('429s once the daily allowance is spent, before any byte', async () => {
    const student = await makeStudentAccount();
    const sessionId = await startSession(student);
    await harness.cache.set(
      usageCacheKey(student.userId, harness.clock.now()),
      String(FOXY_DAILY_MESSAGE_LIMIT.free),
    );

    const response = await post(`/api/v1/foxy/sessions/${sessionId}/messages`, student, {
      text: 'hello',
    });

    expect(response.statusCode).toBe(429);
    expect(String(response.headers['content-type'])).toContain('application/json');
  });

  it('400s when neither `text` nor `action` is sent, and when BOTH are', async () => {
    const student = await makeStudentAccount();
    const sessionId = await startSession(student);

    expect(
      (await post(`/api/v1/foxy/sessions/${sessionId}/messages`, student, {})).statusCode,
    ).toBe(400);
    expect(
      (
        await post(`/api/v1/foxy/sessions/${sessionId}/messages`, student, {
          text: 'hello',
          action: 'simpler',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('400s on an action outside the fixed set — the six buttons are the vocabulary', async () => {
    const student = await makeStudentAccount();
    const sessionId = await startSession(student);
    expect(
      (
        await post(`/api/v1/foxy/sessions/${sessionId}/messages`, student, {
          action: 'write_my_essay',
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('GET /api/v1/foxy/sessions', () => {
  it('lists the caller’s own conversations and nobody else’s', async () => {
    const owner = await makeStudentAccount();
    const other = await makeStudentAccount();
    await startSession(owner);

    const mine = JSON.parse((await get('/api/v1/foxy/sessions', owner)).body) as {
      sessions: unknown[];
    };
    const theirs = JSON.parse((await get('/api/v1/foxy/sessions', other)).body) as {
      sessions: unknown[];
    };

    expect(mine.sessions).toHaveLength(1);
    expect(theirs.sessions).toHaveLength(0);
  });
});

describe('GET /api/v1/foxy/sessions/:id', () => {
  it('returns the conversation and its transcript, oldest first', async () => {
    await seedChunk();
    const student = await makeStudentAccount();
    const sessionId = await startSession(student);
    await post(`/api/v1/foxy/sessions/${sessionId}/messages`, student, {
      text: 'why does light bend',
    });

    const body = JSON.parse((await get(`/api/v1/foxy/sessions/${sessionId}`, student)).body) as {
      messages: { role: string; text: string; createdAt: string }[];
    };

    expect(body.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(Number.isNaN(new Date(body.messages[0]?.createdAt ?? '').getTime())).toBe(false);
  });

  it('never serves the prompt or the retrieved passages', async () => {
    await seedChunk();
    const student = await makeStudentAccount();
    const sessionId = await startSession(student);
    await post(`/api/v1/foxy/sessions/${sessionId}/messages`, student, {
      text: 'why does light bend',
    });

    const raw = (await get(`/api/v1/foxy/sessions/${sessionId}`, student)).body;

    // A system prompt in the browser is a system prompt that can be read and
    // worked around. It lives on `retrieval_traces`, which no route serves.
    expect(raw).not.toContain('You are Foxy');
    expect(raw).not.toContain('Reference passages');
  });

  it('403s for another student’s conversation, with no payload', async () => {
    const owner = await makeStudentAccount();
    const stranger = await makeStudentAccount();
    const sessionId = await startSession(owner);

    const response = await get(`/api/v1/foxy/sessions/${sessionId}`, stranger);

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(owner.userId);
    expect(response.body).not.toContain(sessionId);
  });
});

describe('GET /api/v1/foxy/capabilities', () => {
  it('serves the fixed action set and the three modes, so the client has ONE copy', async () => {
    const student = await makeStudentAccount();
    const body = JSON.parse((await get('/api/v1/foxy/capabilities', student)).body) as {
      modes: { code: string }[];
      actions: { code: string; label: { en: string; hi: string } }[];
      usage: { plan: string; limit: number; remaining: number };
    };

    expect(body.modes.map((mode) => mode.code)).toEqual([...FOXY_MODES]);
    expect(body.actions.map((action) => action.code)).toEqual([...FOXY_ACTIONS]);
    // Bilingual labels — a client that had to translate them would be a second
    // copy of the vocabulary (P7).
    for (const action of body.actions) {
      expect(action.label.en.length).toBeGreaterThan(0);
      expect(action.label.hi).toMatch(/[ऀ-ॿ]/u);
    }
    expect(body.usage).toMatchObject({ plan: 'free', limit: FOXY_DAILY_MESSAGE_LIMIT.free });
  });
});
