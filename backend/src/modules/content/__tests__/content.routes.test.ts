import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  chapterResponseSchema,
  chaptersResponseSchema,
} from '@/shared/contracts/content.contract';
import {
  TEST_COOKIE_NAME,
  onboardAccount,
  startAppHarness,
  type AppHarness,
} from '../../../../tests/helpers/app-harness';
import { insertChapter, insertQuestion, makeChapter, makeQuestion } from '../../../../tests/fixtures/index';

/**
 * content route tests — the two endpoints §8.3 specifies, and the absence of
 * every other one.
 *
 * Responses are parsed with the SHARED CONTRACT SCHEMA, so a route and the
 * type the frontend imports cannot drift apart without this failing.
 */

let harness: AppHarness;
let cookie: string;

beforeAll(async () => {
  harness = await startAppHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
  cookie = (await onboardAccount(harness, 'content-reader@example.test', 'student')).cookie;
});

function get(url: string, sessionCookie?: string): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'GET',
    url,
    ...(sessionCookie === undefined ? {} : { cookies: { [TEST_COOKIE_NAME]: sessionCookie } }),
  });
}

let chapterNumber = 0;
async function chapter(
  overrides: Partial<{ grade: '6' | '8' | '9'; subjectCode: string; isActive: boolean }> = {},
): Promise<string> {
  chapterNumber += 1;
  return insertChapter(
    harness.postgres.client,
    makeChapter(`r${String(chapterNumber)}`, { chapterNumber, ...overrides }),
  );
}

describe('GET /api/v1/content/chapters', () => {
  it('lists chapters in the contract shape', async () => {
    await chapter();
    const response = await get('/api/v1/content/chapters', cookie);

    expect(response.statusCode).toBe(200);
    expect(chaptersResponseSchema.parse(response.json()).chapters).toHaveLength(1);
  });

  it('filters by grade from the query string', async () => {
    await chapter({ grade: '8' });
    await chapter({ grade: '9' });

    const response = await get('/api/v1/content/chapters?grade=8', cookie);
    const body = chaptersResponseSchema.parse(response.json());
    expect(body.chapters.map((row) => row.grade)).toEqual(['8']);
  });

  it('filters by subject from the query string', async () => {
    await chapter({ subjectCode: 'science' });
    await chapter({ subjectCode: 'maths' });

    const response = await get('/api/v1/content/chapters?subject=maths', cookie);
    expect(
      chaptersResponseSchema.parse(response.json()).chapters.map((row) => row.subjectCode),
    ).toEqual(['maths']);
  });

  it('400s on a grade outside "6".."12"', async () => {
    expect((await get('/api/v1/content/chapters?grade=13', cookie)).statusCode).toBe(400);
  });

  it('does NOT coerce a query grade into some other type', async () => {
    // `?grade=8` is a string and stays one. There is deliberately no
    // `z.coerce` on grade: coercion is how `?grade=8` and a JSON body carrying
    // the number 8 start behaving differently.
    await chapter({ grade: '8' });
    const response = await get('/api/v1/content/chapters?grade=8', cookie);
    expect(chaptersResponseSchema.parse(response.json()).chapters[0]?.grade).toBe('8');
  });

  it('400s on a limit above the cap', async () => {
    expect((await get('/api/v1/content/chapters?limit=5000', cookie)).statusCode).toBe(400);
  });

  it('401s with no session — the syllabus is not an open scraping target', async () => {
    expect((await get('/api/v1/content/chapters')).statusCode).toBe(401);
  });
});

describe('GET /api/v1/content/chapters/:id', () => {
  it('returns one chapter', async () => {
    const id = await chapter();
    const response = await get(`/api/v1/content/chapters/${id}`, cookie);

    expect(response.statusCode).toBe(200);
    expect(chapterResponseSchema.parse(response.json()).chapter.id).toBe(id);
  });

  it('400s on an id that is not a uuid', async () => {
    expect((await get('/api/v1/content/chapters/not-a-uuid', cookie)).statusCode).toBe(400);
  });

  it('404s for a withdrawn chapter', async () => {
    const id = await chapter({ isActive: false });
    expect((await get(`/api/v1/content/chapters/${id}`, cookie)).statusCode).toBe(404);
  });

  it('401s with no session', async () => {
    const id = await chapter();
    expect((await get(`/api/v1/content/chapters/${id}`)).statusCode).toBe(401);
  });
});

describe('there is NO HTTP route that serves a question', () => {
  it('exposes no questions endpoint under a chapter', async () => {
    // Deliberate, and the reason is in `content.contract.ts`: a question
    // carries `correct_index`. `practice` owns the session, the shuffle and
    // the anti-cheat rules that make serving one safe, and
    // `getQuestionsForChapter` stays a module-to-module call.
    const id = await chapter();
    await insertQuestion(harness.postgres.client, id, makeQuestion('secret'));

    for (const url of [
      `/api/v1/content/chapters/${id}/questions`,
      `/api/v1/content/questions?chapterId=${id}`,
      `/api/v1/content/chapters/${id}/held-out`,
    ]) {
      expect((await get(url, cookie)).statusCode).toBe(404);
    }
  });

  it('never puts an answer index in a chapter response', async () => {
    const id = await chapter();
    await insertQuestion(harness.postgres.client, id, makeQuestion('secret'));

    const body = (await get(`/api/v1/content/chapters/${id}`, cookie)).body;
    expect(body).not.toContain('correctIndex');
    expect(body).not.toContain('correct_index');
    expect(body).not.toContain('secret');
  });
});
