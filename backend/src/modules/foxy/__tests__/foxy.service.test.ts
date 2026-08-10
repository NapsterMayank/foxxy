import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ERROR_CODES, isAppError } from '@/platform/errors/index';
import { createFakeLlm } from '@/platform/llm/index';
import { FOXY_DAILY_MESSAGE_LIMIT } from '@/shared/constants/foxy';
import type { OnboardingRequest } from '@/shared/contracts/learner.contract';
import {
  OTHER_TENANT_ID,
  TEST_TENANT_ID,
  createSecondTenant,
  onboardAccount,
  startAppHarness,
  type AppHarness,
  type HarnessAccount,
} from '../../../../tests/helpers/app-harness';
import { insertChapter, insertRagChunk, makeChapter, makeRagChunk } from '../../../../tests/fixtures/index';
import { usageCacheKey } from '../domain/usage';
import type { ChunkSearch, FoxyActor } from '../foxy.types';
import type { FoxyFrame } from '../domain/sse';

/**
 * ============================================================================
 * foxy SERVICE TESTS — a real Postgres, a real retrieval pipeline, a scripted
 * model (§9.1).
 *
 * THE RETRIEVAL IS NOT STUBBED. The harness wires `retrieval.service.search`
 * exactly as `app/routes.ts` does, over the real database and the deterministic
 * embedder, so "no chunks were seeded for grade 8 science" produces a genuine
 * `no-candidates` abstention through the production path. A stub returning
 * `shouldAbstain: true` would prove that the service reads a boolean.
 *
 * THE MODEL IS SCRIPTED, and it has to be: every property worth asserting here
 * is a statement about exactly what came back — that a fabricated citation was
 * stripped, that the model was NEVER CALLED, that a mid-stream failure kept the
 * tokens that had arrived. None of those survive a non-deterministic answer.
 *
 * The clock is fixed. There is no `sleep` anywhere in this file — a test that
 * waits on wall-clock time is a test that fails on a loaded CI box.
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

function studentActor(account: HarnessAccount, tenantId: string = TEST_TENANT_ID): FoxyActor {
  return { userId: account.userId, role: 'student', tenantId };
}

async function makeStudentAccount(harnessRef: AppHarness): Promise<HarnessAccount> {
  const account = await onboardAccount(harnessRef, nextEmail('student'), 'student');
  await harnessRef.learner.service.createProfile(studentActor(account), ONBOARDING);
  return account;
}

/**
 * Seeds one grade-8 science chunk and returns its id.
 *
 * The id is what the scripted model cites, which is what makes the citation
 * assertions real: a verified citation resolves to a row that retrieval
 * genuinely returned rather than to a constant the test invented.
 */
async function seedChunk(text = 'Light bends when it enters a denser medium.'): Promise<string> {
  const chapterId = await insertChapter(
    harness.postgres.client,
    makeChapter("light", { grade: "8", subjectCode: "science", chapterNumber: 10, titleEn: "Light" }),
  );
  return await insertRagChunk(
    harness.postgres.client,
    makeRagChunk('light-seed', {
      grade: '8',
      subject: 'science',
      chapterNumber: 10,
      chapterTitle: 'Light',
      chunkText: text,
    }),
    chapterId,
  );
}

async function collect(frames: AsyncIterable<FoxyFrame>): Promise<FoxyFrame[]> {
  const out: FoxyFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

function textOf(frames: readonly FoxyFrame[]): string {
  return frames
    .filter((frame): frame is Extract<FoxyFrame, { type: 'token' }> => frame.type === 'token')
    .map((frame) => frame.text)
    .join('');
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

// ---------------------------------------------------------------------------
// STARTING A CONVERSATION
// ---------------------------------------------------------------------------

describe('startSession', () => {
  it('opens a session in the requested mode about the requested subject', async () => {
    const student = await makeStudentAccount(harness);

    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    expect(session.mode).toBe('doubt');
    expect(session.subject).toBe('science');
    expect(session.studentUserId).toBe(student.userId);
    // The tenant the GUARD passed on, never the one the actor claimed.
    expect(session.tenantId).toBe(TEST_TENANT_ID);
    // Null until the first message: a session opened and abandoned is a real
    // thing to be able to count.
    expect(session.lastMessageAt).toBeNull();
  });

  it('takes the language from the profile rather than from the request', async () => {
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'explain',
      subject: 'science',
    });
    expect(['en', 'hi']).toContain(session.language);
  });

  it('REFUSES a subject the student is not enrolled in, at creation', async () => {
    const student = await makeStudentAccount(harness);
    // Every turn of such a session would abstain — correctly, since retrieval is
    // hard-filtered by subject — and the student would experience that as Foxy
    // being broken.
    await expect(
      harness.foxy.service.startSession(studentActor(student), {
        mode: 'doubt',
        subject: 'mathematics',
      }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === ERROR_CODES.VALIDATION);
  });
});

// ---------------------------------------------------------------------------
// THE GROUNDED PATH
// ---------------------------------------------------------------------------

describe('sendMessage — the grounded path', () => {
  it('streams tokens, ends with `done`, and stores the answer', async () => {
    await seedChunk();
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    const turn = await harness.foxy.service.sendMessage(studentActor(student), session.id, {
      text: 'why does light bend',
    });
    const frames = await collect(turn.frames);

    expect(frames.filter((frame) => frame.type === 'token').length).toBeGreaterThan(0);
    expect(frames.at(-1)?.type).toBe('done');

    const stored = await harness.foxy.service.getSession(studentActor(student), session.id);
    expect(stored.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(stored.messages[0]?.content).toBe('why does light bend');
    expect(stored.messages[1]?.content).toBe(textOf(frames));
    expect(stored.messages[1]?.abstained).toBe(false);
  });

  it('writes ONE trace row for the turn', async () => {
    await seedChunk();
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'why does light bend',
      })).frames,
    );

    const traces = await harness.postgres.client.query<{
      count: string;
      prompt: string;
      model: string;
      grade: string;
      answer: string;
    }>('select count(*)::text as count, max(prompt) as prompt, max(model) as model, max(grade) as grade, max(answer) as answer from retrieval_traces');

    expect(traces.rows[0]?.count).toBe('1');
    // THE ASSEMBLED PROMPT, VERBATIM. Without it a bad answer can only be
    // reproduced by re-running today's assembler, which is a different
    // assembler from the one that produced the answer under investigation.
    expect(traces.rows[0]?.prompt).toContain('You are Foxy');
    expect(traces.rows[0]?.model).toBe('harness-model');
    expect(traces.rows[0]?.grade).toBe('8');
    expect((traces.rows[0]?.answer ?? '').length).toBeGreaterThan(0);
  });

  it('records every retrieved chunk id and score on the trace', async () => {
    const chunkId = await seedChunk();
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'why does light bend',
      })).frames,
    );

    const trace = await harness.postgres.client.query<{ retrieved: { chunkId: string }[] }>(
      'select retrieved from retrieval_traces limit 1',
    );
    expect(trace.rows[0]?.retrieved.map((entry) => entry.chunkId)).toContain(chunkId);
  });

  it('stamps `last_message_at` on the session', async () => {
    await seedChunk();
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'why does light bend',
      })).frames,
    );

    const [listed] = await harness.foxy.service.listSessions(studentActor(student), 10);
    expect(listed?.lastMessageAt).not.toBeNull();
  });

  it('stores which BUTTON produced a turn, and free text as NULL', async () => {
    await seedChunk();
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'explain',
      subject: 'science',
    });

    await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        action: 'simpler',
      })).frames,
    );
    await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'and why is that',
      })).frames,
    );

    const stored = await harness.foxy.service.getSession(studentActor(student), session.id);
    const studentTurns = stored.messages.filter((message) => message.role === 'user');
    // A free-text turn is genuinely NULL rather than a `'freetext'` sentinel, so
    // "which action produces bad answers" stays queryable.
    expect(studentTurns.map((message) => message.action)).toEqual(['simpler', null]);
  });
});

// ---------------------------------------------------------------------------
// CITATIONS
// ---------------------------------------------------------------------------

describe('sendMessage — citations', () => {
  it('emits a verified citation and keeps the marker out of the visible text', async () => {
    const chunkId = await seedChunk();
    harness.useLlm(createFakeLlm({ respond: () => `Light bends. [chunk:${chunkId}] Done.` }));

    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    const frames = await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'why does light bend',
      })).frames,
    );

    // The marker is STRUCTURED DATA on the message, never punctuation in the
    // prose the student reads.
    expect(textOf(frames)).not.toContain('[chunk:');
    expect(textOf(frames)).toBe('Light bends.  Done.');

    const citation = frames.find((frame) => frame.type === 'citation');
    expect(citation).toMatchObject({ citation: { chunkId, chapterNumber: 10 } });
    // §7 attaches BY MESSAGE ID, never by position — so the frame carries one.
    expect((citation as { messageId: string }).messageId.length).toBeGreaterThan(0);

    const stored = await harness.foxy.service.getSession(studentActor(student), session.id);
    expect(stored.messages[1]?.citations.map((entry) => entry.chunkId)).toEqual([chunkId]);
  });

  it('STRIPS a fabricated citation before the response is sent', async () => {
    await seedChunk();
    harness.useLlm(
      createFakeLlm({ respond: () => `Light bends. [chunk:${NOBODY}] That is refraction.` }),
    );

    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    const frames = await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'why does light bend',
      })).frames,
    );

    // Nothing about the invented id reaches the student, in ANY frame.
    expect(JSON.stringify(frames)).not.toContain(NOBODY);
    expect(frames.filter((frame) => frame.type === 'citation')).toEqual([]);

    const stored = await harness.foxy.service.getSession(studentActor(student), session.id);
    expect(stored.messages[1]?.citations).toEqual([]);

    // …and it IS recorded on the trace, which is where a fabrication has to be
    // visible in order for anyone to measure how often it happens.
    const trace = await harness.postgres.client.query<{ fabricated_citations: string[] }>(
      'select fabricated_citations from retrieval_traces limit 1',
    );
    expect(trace.rows[0]?.fabricated_citations).toEqual([NOBODY]);
  });

  it('keeps the real citation and drops the invented one from the same answer', async () => {
    const chunkId = await seedChunk();
    harness.useLlm(
      createFakeLlm({
        respond: () => `A [chunk:${chunkId}] and B [chunk:${NOBODY}].`,
      }),
    );

    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    const frames = await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'why does light bend',
      })).frames,
    );

    expect(
      frames
        .filter((frame) => frame.type === 'citation')
        .map((frame) => (frame as { citation: { chunkId: string } }).citation.chunkId),
    ).toEqual([chunkId]);
  });
});

// ---------------------------------------------------------------------------
// ABSTENTION — THE MOST IMPORTANT SECTION IN THIS FILE
// ---------------------------------------------------------------------------

describe('abstention NEVER calls the model', () => {
  it('abstains when nothing was retrieved, and the model records ZERO calls', async () => {
    // NO CHUNKS SEEDED. This is a genuine `no-candidates` abstention through the
    // production retrieval pipeline, not a stubbed boolean.
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    const before = harness.llm.recorder.callCount();
    const frames = await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'why does light bend',
      })).frames,
    );

    // THE ASSERTION THIS WHOLE MODULE EXISTS TO KEEP TRUE. If this is ever
    // weakened, foxy has become a chatbot with a search box attached.
    expect(harness.llm.recorder.callCount()).toBe(before);

    expect(frames.map((frame) => frame.type)).toEqual(['abstention', 'done']);
    expect(frames[0]).toMatchObject({ reason: 'no_results' });
  });

  it('delivers the abstention as a SUCCESSFUL answer, stored and traced', async () => {
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    const frames = await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'why does light bend',
      })).frames,
    );

    // Not an error, not a 4xx, not an empty response.
    expect(frames.some((frame) => frame.type === 'error')).toBe(false);

    const stored = await harness.foxy.service.getSession(studentActor(student), session.id);
    expect(stored.messages).toHaveLength(2);
    expect(stored.messages[1]?.abstained).toBe(true);
    expect(stored.messages[1]?.content.length).toBeGreaterThan(0);
    // AN ABSTENTION CARRIES NO CITATIONS — also a CHECK in migration 0005.
    expect(stored.messages[1]?.citations).toEqual([]);

    const trace = await harness.postgres.client.query<{
      abstained: boolean;
      abstain_reason: string;
      prompt: string;
    }>('select abstained, abstain_reason, prompt from retrieval_traces limit 1');
    expect(trace.rows[0]?.abstained).toBe(true);
    expect(trace.rows[0]?.abstain_reason).toBe('no_results');
    // EMPTY BECAUSE THERE WAS NO PROMPT — the honest record of a turn that never
    // reached the model.
    expect(trace.rows[0]?.prompt).toBe('');
  });

  it('abstains BELOW THE THRESHOLD without calling the model either', async () => {
    /**
     * The one abstention the real pipeline cannot currently produce.
     * `ABSTAIN_THRESHOLD` ships UNCALIBRATED and INERT — it filters nothing,
     * deliberately, until the calibration harness runs against `VOYAGE_API_KEY`
     * — so this branch is reached with an injected search rather than not
     * tested at all.
     */
    const search: ChunkSearch = () =>
      Promise.resolve({
        chunks: [],
        shouldAbstain: true,
        confidence: 0.1,
        normalisedQuery: 'why does light bend',
        abstainReason: 'below-threshold',
      });
    const scripted = createFakeLlm();
    harness.useLlm(scripted);
    harness.useSearch(search);

    // Chunks ARE seeded, so this is not the `no-candidates` case wearing a
    // different name: retrieval had something and judged it too weak.
    await seedChunk();
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    const frames = await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'why does light bend',
      })).frames,
    );

    expect(scripted.recorder.callCount()).toBe(0);
    expect(frames[0]).toMatchObject({ type: 'abstention', reason: 'below_threshold' });
  });
});

describe('a session whose subject the student has since dropped', () => {
  it('abstains with `out_of_scope` and does not call the model', async () => {
    await seedChunk();
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    // Dropped AFTER the session was opened. The session survives — a
    // conversation that happened still happened — but it can no longer be
    // answered, because retrieval is hard-filtered by subject and there is
    // nothing honest to filter by.
    await harness.postgres.client.query('delete from student_subjects where student_user_id = $1', [
      student.userId,
    ]);

    const before = harness.llm.recorder.callCount();
    const frames = await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'why does light bend',
      })).frames,
    );

    expect(harness.llm.recorder.callCount()).toBe(before);
    expect(frames[0]).toMatchObject({ type: 'abstention', reason: 'out_of_scope' });
  });
});

describe('getTranscript', () => {
  it('returns the messages alone, oldest first, behind the same guard', async () => {
    await seedChunk();
    const owner = await makeStudentAccount(harness);
    const stranger = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(owner), {
      mode: 'doubt',
      subject: 'science',
    });
    await collect(
      (await harness.foxy.service.sendMessage(studentActor(owner), session.id, {
        text: 'why does light bend',
      })).frames,
    );

    const transcript = await harness.foxy.service.getTranscript(studentActor(owner), session.id);
    expect(transcript.map((message) => message.role)).toEqual(['user', 'assistant']);

    await expect(
      harness.foxy.service.getTranscript(studentActor(stranger), session.id),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === ERROR_CODES.FORBIDDEN);
  });
});

describe('a corrupt usage counter FAILS CLOSED', () => {
  it('reads a non-numeric counter as zero rather than as NaN', async () => {
    // NaN compares false against every limit, which fails OPEN — a broken cache
    // key would silently grant unlimited messages and nothing would report it.
    const student = await makeStudentAccount(harness);
    await harness.cache.set(usageCacheKey(student.userId, harness.clock.now()), 'not-a-number');

    expect((await harness.foxy.service.getUsage(studentActor(student))).used).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SAFETY
// ---------------------------------------------------------------------------

describe('the safety classifier blocks off-scope input BEFORE the model', () => {
  it('refuses a harm question, names a helpline, and never calls the model', async () => {
    await seedChunk();
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    const before = harness.llm.recorder.callCount();
    const frames = await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'i want to kill myself',
      })).frames,
    );

    expect(harness.llm.recorder.callCount()).toBe(before);
    expect(frames[0]).toMatchObject({ type: 'abstention', reason: 'refused' });
    expect((frames[0] as { text: string }).text).toContain('14416');
  });

  it('refuses a message carrying a phone number, before it can reach the model', async () => {
    await seedChunk();
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    const before = harness.llm.recorder.callCount();
    const frames = await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'call me on +91 98765 43210 about light',
      })).frames,
    );

    expect(harness.llm.recorder.callCount()).toBe(before);
    expect(frames[0]).toMatchObject({ type: 'abstention', reason: 'refused' });
  });

  it('does NOT charge a refused message against the daily allowance', async () => {
    // Charging a child a message for being told to talk to a trusted adult is
    // indefensible.
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'send me porn',
      })).frames,
    );

    expect((await harness.foxy.service.getUsage(studentActor(student))).used).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// USAGE LIMITS
// ---------------------------------------------------------------------------

describe('the daily usage limit', () => {
  it('blocks a message once the allowance is spent', async () => {
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    // Pre-load the counter rather than sending twenty messages: the RULE is
    // tested exhaustively in `usage.test.ts`, and this asserts the wiring.
    const key = usageCacheKey(student.userId, harness.clock.now());
    await harness.cache.set(key, String(FOXY_DAILY_MESSAGE_LIMIT.free));

    await expect(
      harness.foxy.service.sendMessage(studentActor(student), session.id, { text: 'hello' }),
    ).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === ERROR_CODES.RATE_LIMIT,
    );
  });

  it('counts an ABSTENTION against the allowance — it still cost a retrieval', async () => {
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'why does light bend',
      })).frames,
    );

    expect((await harness.foxy.service.getUsage(studentActor(student))).used).toBe(1);
  });

  it('reports the plan, the limit and the remaining allowance', async () => {
    const student = await makeStudentAccount(harness);
    const usage = await harness.foxy.service.getUsage(studentActor(student));
    // `billing` does not exist yet, so every account is `free`.
    expect(usage).toEqual({
      plan: 'free',
      used: 0,
      limit: FOXY_DAILY_MESSAGE_LIMIT.free,
      remaining: FOXY_DAILY_MESSAGE_LIMIT.free,
    });
  });

  it('blocks BEFORE retrieval and before the model', async () => {
    await seedChunk();
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });
    await harness.cache.set(
      usageCacheKey(student.userId, harness.clock.now()),
      String(FOXY_DAILY_MESSAGE_LIMIT.free),
    );

    const before = harness.llm.recorder.callCount();
    await harness.foxy.service
      .sendMessage(studentActor(student), session.id, { text: 'why does light bend' })
      .catch(() => undefined);

    expect(harness.llm.recorder.callCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// A MID-STREAM FAILURE
// ---------------------------------------------------------------------------

describe('a mid-stream model failure degrades gracefully', () => {
  it('keeps the tokens that arrived, emits `error` then `done`, and NEVER throws', async () => {
    const scripted = createFakeLlm({
      respond: () => 'Light bends when it enters a denser medium.',
      failAfter: 2,
    });
    harness.useLlm(scripted);

    await seedChunk();
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    const turn = await harness.foxy.service.sendMessage(studentActor(student), session.id, {
      text: 'why does light bend',
    });
    // Draining MUST NOT REJECT. By this point the HTTP response is committed to
    // 200 and there is no status left to change.
    const frames = await collect(turn.frames);

    expect(textOf(frames)).toBe('Light bends ');
    expect(frames.find((frame) => frame.type === 'error')).toMatchObject({
      code: 'model_unavailable',
      partial: true,
    });
    expect(frames.at(-1)?.type).toBe('done');

    // THE PARTIAL ANSWER IS STORED. The conversation the student remembers and
    // the one we stored must not disagree.
    const stored = await harness.foxy.service.getSession(studentActor(student), session.id);
    expect(stored.messages[1]?.content).toBe('Light bends ');

    // …and so is the trace, which is exactly what somebody wants when they ask
    // why the answer stopped.
    const trace = await harness.postgres.client.query<{ abstain_reason: string }>(
      'select abstain_reason from retrieval_traces limit 1',
    );
    expect(trace.rows[0]?.abstain_reason).toBe('model_failed');
  });

  it('reports `partial: false` when the model failed before a single token', async () => {
    harness.useLlm(createFakeLlm({ failImmediately: true }));

    await seedChunk();
    const student = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(student), {
      mode: 'doubt',
      subject: 'science',
    });

    const frames = await collect(
      (await harness.foxy.service.sendMessage(studentActor(student), session.id, {
        text: 'why does light bend',
      })).frames,
    );

    // §7's table lists these as two DIFFERENT required client behaviours: an
    // error with a retry, versus keep-the-text-and-offer-to-continue.
    expect(frames.find((frame) => frame.type === 'error')).toMatchObject({ partial: false });
    expect(textOf(frames)).toBe('');

    // A message with no text is not a message, so an honest sentence is stored
    // rather than violating the content CHECK.
    const stored = await harness.foxy.service.getSession(studentActor(student), session.id);
    expect(stored.messages[1]?.content.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ISOLATION
// ---------------------------------------------------------------------------

describe('a student cannot read another student’s conversation', () => {
  it('refuses with a contentless 403, carrying no payload at all', async () => {
    const owner = await makeStudentAccount(harness);
    const stranger = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(owner), {
      mode: 'doubt',
      subject: 'science',
    });

    const attempt = harness.foxy.service.getSession(studentActor(stranger), session.id);

    await expect(attempt).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === ERROR_CODES.FORBIDDEN,
    );
    await attempt.catch((error: unknown) => {
      const serialised = JSON.stringify(error);
      expect(serialised).not.toContain(owner.userId);
      expect(serialised).not.toContain(session.id);
    });
  });

  it('refuses to let a stranger SEND into somebody else’s conversation', async () => {
    const owner = await makeStudentAccount(harness);
    const stranger = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(owner), {
      mode: 'doubt',
      subject: 'science',
    });

    await expect(
      harness.foxy.service.sendMessage(studentActor(stranger), session.id, { text: 'hello' }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === ERROR_CODES.FORBIDDEN);
  });

  it('lists only the caller’s own conversations', async () => {
    const owner = await makeStudentAccount(harness);
    const other = await makeStudentAccount(harness);
    await harness.foxy.service.startSession(studentActor(owner), {
      mode: 'doubt',
      subject: 'science',
    });

    expect(await harness.foxy.service.listSessions(studentActor(other), 10)).toEqual([]);
  });

  it('returns a 404 for a conversation that does not exist', async () => {
    const student = await makeStudentAccount(harness);
    await expect(
      harness.foxy.service.getSession(studentActor(student), NOBODY),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === ERROR_CODES.NOT_FOUND);
  });
});

describe('cross-tenant access is denied, with no payload', () => {
  it('refuses a caller from another tenant reading a conversation', async () => {
    await createSecondTenant(harness);
    const owner = await makeStudentAccount(harness);
    const session = await harness.foxy.service.startSession(studentActor(owner), {
      mode: 'doubt',
      subject: 'science',
    });

    // The SAME user id, in another tenant — so ownership is trivially satisfied
    // and the ONLY thing that can refuse this is the tenant comparison.
    const attempt = harness.foxy.service.getSession(
      studentActor(owner, OTHER_TENANT_ID),
      session.id,
    );

    await expect(attempt).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === ERROR_CODES.FORBIDDEN,
    );
    await attempt.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain(session.id);
    });
  });

  it('refuses a cross-tenant `listSessions` and returns no rows to it', async () => {
    await createSecondTenant(harness);
    const owner = await makeStudentAccount(harness);
    await harness.foxy.service.startSession(studentActor(owner), {
      mode: 'doubt',
      subject: 'science',
    });

    await expect(
      harness.foxy.service.listSessions(studentActor(owner, OTHER_TENANT_ID), 10),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === ERROR_CODES.FORBIDDEN);
  });
});
