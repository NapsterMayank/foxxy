import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  chapterConceptsResponseSchema,
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

describe('GET /api/v1/content/chapters/:id/concepts', () => {
  /** Inserts a concept directly — there is no write path for content. */
  async function concept(
    chapterId: string,
    fields: Partial<{
      conceptNumber: number | null;
      titleEn: string;
      explanationEn: string | null;
      commonMistakes: unknown;
    }> = {},
  ): Promise<void> {
    await harness.postgres.client.query(
      `insert into chapter_concepts
         (chapter_id, concept_number, title_en, explanation_en, common_mistakes)
       values ($1, $2, $3, $4, $5)`,
      [
        chapterId,
        fields.conceptNumber === undefined ? 1 : fields.conceptNumber,
        fields.titleEn ?? 'A concept',
        fields.explanationEn === undefined ? 'An explanation.' : fields.explanationEn,
        JSON.stringify(fields.commonMistakes ?? []),
      ],
    );
  }

  it('returns the chapter and its concepts together', async () => {
    const id = await chapter();
    await concept(id, { conceptNumber: 1, titleEn: 'Chemical Reactions' });

    const response = await get(`/api/v1/content/chapters/${id}/concepts`, cookie);

    expect(response.statusCode).toBe(200);
    const body = chapterConceptsResponseSchema.parse(response.json());
    // BOTH, from one call — a screen rendering concepts without the chapter
    // would show an unnamed list for the length of a second round trip.
    expect(body.chapter.id).toBe(id);
    expect(body.concepts).toHaveLength(1);
    expect(body.concepts[0]?.titleEn).toBe('Chemical Reactions');
    expect(body.concepts[0]?.explanationEn).toBe('An explanation.');
  });

  /*
   * THE ORDERING RULE, AND THE REASON IT IS ASSERTED.
   *
   * `concept_number` is nullable and the source repeats values, so it cannot be
   * trusted alone. Postgres sorts NULLs FIRST on an ascending sort, which would
   * open a chapter's walkthrough on whichever concepts the import failed to
   * number — a defect nobody would see until a student met one of those ten
   * chapters.
   */
  it('orders by concept number, with unnumbered concepts last', async () => {
    const id = await chapter();
    await concept(id, { conceptNumber: 2, titleEn: 'Second' });
    await concept(id, { conceptNumber: null, titleEn: 'Unnumbered' });
    await concept(id, { conceptNumber: 1, titleEn: 'First' });

    const body = chapterConceptsResponseSchema.parse(
      (await get(`/api/v1/content/chapters/${id}/concepts`, cookie)).json(),
    );

    expect(body.concepts.map((entry) => entry.titleEn)).toEqual(['First', 'Second', 'Unnumbered']);
  });

  /*
   * A walkthrough that reshuffles under a student mid-chapter is worse than one
   * in an imperfect order, so duplicate numbers break the tie on `id` rather
   * than on whatever the planner returns.
   */
  it('is stable across requests when numbers repeat', async () => {
    const id = await chapter();
    await concept(id, { conceptNumber: 1, titleEn: 'A' });
    await concept(id, { conceptNumber: 1, titleEn: 'B' });
    await concept(id, { conceptNumber: 1, titleEn: 'C' });

    const first = chapterConceptsResponseSchema.parse(
      (await get(`/api/v1/content/chapters/${id}/concepts`, cookie)).json(),
    );
    const second = chapterConceptsResponseSchema.parse(
      (await get(`/api/v1/content/chapters/${id}/concepts`, cookie)).json(),
    );

    expect(first.concepts.map((entry) => entry.id)).toEqual(
      second.concepts.map((entry) => entry.id),
    );
  });

  /*
   * Ten of the 137 chapters have no concepts. That is content missing, not a
   * chapter missing — a 404 would be a false statement about the chapter.
   */
  it('returns an empty list for a chapter with no concepts, not a 404', async () => {
    const id = await chapter();

    const response = await get(`/api/v1/content/chapters/${id}/concepts`, cookie);

    expect(response.statusCode).toBe(200);
    expect(chapterConceptsResponseSchema.parse(response.json()).concepts).toEqual([]);
  });

  it('404s for a withdrawn chapter rather than listing its concepts', async () => {
    const id = await chapter({ isActive: false });
    await concept(id);

    expect((await get(`/api/v1/content/chapters/${id}/concepts`, cookie)).statusCode).toBe(404);
  });

  it('400s on an id that is not a uuid', async () => {
    expect((await get('/api/v1/content/chapters/not-a-uuid/concepts', cookie)).statusCode).toBe(400);
  });

  it('401s with no session', async () => {
    const id = await chapter();
    expect((await get(`/api/v1/content/chapters/${id}/concepts`)).statusCode).toBe(401);
  });

  /*
   * `common_mistakes` is `jsonb NOT NULL DEFAULT '[]'`, so it cannot be null —
   * but jsonb can hold anything, and a row written by something other than this
   * application should cost one concept its list rather than the whole chapter a
   * 500.
   */
  it('survives a common_mistakes value that is not an array of strings', async () => {
    const id = await chapter();
    await concept(id, { commonMistakes: { not: 'an array' } });

    const response = await get(`/api/v1/content/chapters/${id}/concepts`, cookie);

    expect(response.statusCode).toBe(200);
    expect(chapterConceptsResponseSchema.parse(response.json()).concepts[0]?.commonMistakes).toEqual(
      [],
    );
  });

  it('keeps the strings when the list is well formed', async () => {
    const id = await chapter();
    await concept(id, { commonMistakes: ['forgets to balance', 'reverses the arrow'] });

    const body = chapterConceptsResponseSchema.parse(
      (await get(`/api/v1/content/chapters/${id}/concepts`, cookie)).json(),
    );

    expect(body.concepts[0]?.commonMistakes).toEqual(['forgets to balance', 'reverses the arrow']);
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
