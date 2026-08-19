import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  answerResultSchema,
  practiceSessionResponseSchema,
  submissionResponseSchema,
} from '@/shared/contracts/practice.contract';
import { TIME_TARGET_MS } from '@/modules/practice/domain/time-targets';
import { z } from 'zod';
import {
  HARNESS_ORIGIN,
  TEST_COOKIE_NAME,
  onboardAccount,
  startAppHarness,
  type AppHarness,
  type HarnessAccount,
} from '../helpers/app-harness';
import { insertChapter, insertQuestion, makeChapter, makeQuestion } from '../fixtures/index';

/** The answers endpoint's envelope. The only response shape with no named wrapper. */
const answerResultResponseSchema = z.object({ result: answerResultSchema });

/**
 * =============================================================================
 * TASK 8 — THE PROOF THAT THE LADDER ACTUALLY MOVES A REAL SESSION, OVER HTTP,
 * AGAINST A REAL POSTGRES.
 * =============================================================================
 *
 * Everything up to this task has been proved in isolation: `difficulty-ladder`
 * is pure and unit-tested; `time-targets` is a constant table; the service
 * tests prove `nextQuestion` walks and that a fallback does not move the
 * ladder. None of that proves the three actually compose — that a session
 * started through the real HTTP surface, against real rows in `questions` and
 * `practice_responses`, serves a difficulty other than the one it started on,
 * and that every response the database now holds carries the pace target that
 * was actually in force for the difficulty it was served at.
 *
 * A session that merely RAN — six answers, one submit, 200 back — proves
 * nothing about the ladder. It would pass identically against a service that
 * served `easy` six times in a row. The assertion that matters is the second
 * one below: the SET of difficulties served has more than one member.
 * =============================================================================
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

function post(url: string, payload: unknown, cookie: string): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url,
    headers: { origin: HARNESS_ORIGIN },
    payload: payload as Record<string, unknown>,
    cookies: { [TEST_COOKIE_NAME]: cookie },
  });
}

let counter = 0;

/**
 * A signed-in, onboarded student and a chapter with plenty of EACH difficulty.
 *
 * Three of each rung so a fallback (D-385's `pickRungWithFallback`) is never
 * what this test is actually exercising — the chapter always has what the
 * ladder asks for, and every question's correct option is index 0 so the
 * walker below can find it by text regardless of the per-session shuffle.
 */
async function seed(): Promise<{ account: HarnessAccount; chapterId: string }> {
  counter += 1;
  const account = await onboardAccount(harness, `adaptive${String(counter)}@example.test`, 'student');
  const actor = {
    userId: account.userId,
    role: 'student' as const,
    tenantId: '11111111-1111-4111-8111-111111111111',
  };
  await harness.learner.service.createProfile(actor, {
    displayName: `Adaptive ${String(counter)}`,
    grade: '8',
    subjects: ['science'],
  });

  const chapterId = await insertChapter(
    harness.postgres.client,
    makeChapter(`ad${String(counter)}`, { grade: '8', subjectCode: 'science', chapterNumber: 1 }),
  );

  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    for (let index = 0; index < 3; index += 1) {
      await insertQuestion(
        harness.postgres.client,
        chapterId,
        makeQuestion(`adq${String(counter)}-${difficulty}-${String(index)}`, {
          correctIndex: 0,
          difficulty,
        }),
      );
    }
  }

  return { account, chapterId };
}

/** Comfortably inside every difficulty's target (30s/45s/60s) and above the 3s floor. */
const QUALIFYING_ANSWER_MS = 8_000;

describe('the ladder, walked over a real session — D-384, D-385, D-386', () => {
  it('walks a real session up the ladder and records every target', async () => {
    const { account, chapterId } = await seed();

    const started = await post(
      '/api/v1/practice/sessions',
      { chapterId, questionCount: 4 },
      account.cookie,
    );
    expect(started.statusCode).toBe(201);
    const session = practiceSessionResponseSchema.parse(started.json()).session;

    // A session arrives with exactly its FIRST question — Task 5.
    expect(session.questions).toHaveLength(1);

    let current = session.questions[0] ?? null;
    if (current === null) throw new Error('session started with no first question');
    const served: string[] = [current.difficulty];

    for (let i = 0; i < 3; i += 1) {
      const correctPosition = current.options.findIndex((option) => option.endsWith(' option 0'));
      expect(correctPosition).toBeGreaterThanOrEqual(0);

      harness.clock.advanceMs(QUALIFYING_ANSWER_MS);
      const response = await post(
        `/api/v1/practice/sessions/${session.id}/answers`,
        {
          questionId: current.id,
          selectedIndex: correctPosition,
          timeSpentMs: QUALIFYING_ANSWER_MS,
        },
        account.cookie,
      );
      expect(response.statusCode).toBe(200);
      const result = answerResultResponseSchema.parse(response.json()).result;
      expect(result.isCorrect).toBe(true);

      if (result.nextQuestion === null) break;
      current = result.nextQuestion;
      served.push(current.difficulty);
    }

    const submitted = await post(
      `/api/v1/practice/sessions/${session.id}/submit`,
      {},
      account.cookie,
    );
    expect(submitted.statusCode).toBe(200);
    submissionResponseSchema.parse(submitted.json());

    const { rows } = await harness.postgres.client.query<{
      time_target_ms: number;
      authored_difficulty: 'easy' | 'medium' | 'hard';
    }>(
      `select time_target_ms, authored_difficulty
         from practice_responses
        where session_id = $1`,
      [session.id],
    );

    expect(rows.length).toBeGreaterThan(0);

    // Every answer carries the target for the difficulty IT was served at, not
    // for whatever difficulty the session started or ended on.
    for (const row of rows) {
      expect(row.time_target_ms).toBe(TIME_TARGET_MS[row.authored_difficulty]);
    }

    // Two consecutive qualifying answers (correct, and well inside the target)
    // step the rung up — D-385. If this session had stayed on 'easy' throughout,
    // every response above would trivially satisfy the target check even with a
    // completely broken ladder, so the proof that the ladder MOVED is this
    // assertion, not the one above it.
    expect(new Set(served).size).toBeGreaterThan(1);
  }, 60_000);
});
