import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  adminActivityResponseSchema,
  adminAuditResponseSchema,
  adminChatSessionDetailResponseSchema,
  adminChatSessionsResponseSchema,
  adminContentCoverageResponseSchema,
  adminPracticeSessionsResponseSchema,
  adminSubscriptionsResponseSchema,
  adminUserDetailResponseSchema,
  adminUsersResponseSchema,
} from '@/shared/contracts/admin.contract';
import {
  HARNESS_ORIGIN,
  TEST_COOKIE_NAME,
  TEST_TENANT_ID,
  onboardAccount,
  startAppHarness,
  type AppHarness,
} from '../helpers/app-harness';
import { insertChapter, makeChapter } from '../fixtures/index';

/**
 * =============================================================================
 * THE MASKS, PROVED ON THE WIRE.
 *
 * `masking.test.ts` pins the functions. This file proves they are actually IN
 * THE PATH — that the raw email and the raw message text are absent from the
 * RESPONSE BYTES, not merely absent from a rendered page.
 *
 * That distinction is the whole reason masking is server-side. A client-side
 * mask leaves the real value in the network tab, in the response cache, and in
 * any HAR file attached to a bug report. So the assertions below search the
 * serialised body for the secret, rather than checking a field.
 *
 * THE SECRETS ARE DISTINCTIVE ON PURPOSE. A test that searched for "aarav"
 * would pass by luck the day a mask happened to keep four characters; a
 * high-entropy token can only be present if the real value was carried.
 * =============================================================================
 */

let harness: AppHarness;

/** Values that must never appear in an admin response. */
const SECRET_LOCAL = 'zqxjkv7413learnerlocalpart';
const SECRET_EMAIL = `${SECRET_LOCAL}@example.test`;
const SECRET_NAME = 'Wubblefloop Qzarnix';
const SECRET_MESSAGE = 'my secret question about zzyzxq fractions and my home address';

let studentUserId: string;
let adminCookie: string;
let chatSessionId: string;
let chapterId: string;

beforeAll(async () => {
  harness = await startAppHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();

  const learner = await onboardAccount(harness, SECRET_EMAIL, 'student');
  studentUserId = learner.userId;
  await harness.learner.service.createProfile(
    { userId: learner.userId, role: 'student', tenantId: TEST_TENANT_ID },
    { displayName: SECRET_NAME, grade: '8', subjects: ['science'] },
  );

  const operator = await onboardAccount(harness, 'operator@example.test', 'student');
  await harness.postgres.client.query(`update users set role = 'super_admin' where id = $1`, [
    operator.userId,
  ]);
  adminCookie = operator.cookie;

  chapterId = await insertChapter(
    harness.postgres.client,
    makeChapter('mask1', { grade: '8', subjectCode: 'science', chapterNumber: 1 }),
  );

  /**
   * Chat rows are INSERTED DIRECTLY rather than driven through Foxy.
   *
   * Driving a real turn needs a model, retrieval and a corpus, and would make
   * this suite depend on all three to assert something about a mask. What the
   * masking path needs is a row with known text in it; SQL is the shortest way
   * to a known row.
   */
  const session = await harness.postgres.client.query<{ id: string }>(
    `insert into chat_sessions (student_user_id, tenant_id, mode, subject, chapter_id, language)
     values ($1, $2, 'doubt', 'science', $3, 'en') returning id`,
    [studentUserId, TEST_TENANT_ID, chapterId],
  );
  chatSessionId = session.rows[0]?.id ?? '';

  await harness.postgres.client.query(
    `insert into chat_messages (session_id, tenant_id, role, content)
     values ($1, $2, 'user', $3)`,
    [chatSessionId, TEST_TENANT_ID, SECRET_MESSAGE],
  );
  /**
   * `last_message_at` IS SET BECAUSE FOXY SETS IT.
   *
   * Inserting the message alone leaves it NULL, and `v_learner_activity` then
   * correctly labels the session `empty` — its whole definition of "used" is
   * that somebody spoke. Leaving it out would have made this fixture a session
   * that has a message and claims nobody spoke, which exists nowhere in
   * production and would test the view against a state it cannot reach.
   */
  await harness.postgres.client.query(
    `update chat_sessions set last_message_at = now() where id = $1`,
    [chatSessionId],
  );
});

function get(url: string, cookie = adminCookie): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'GET',
    url,
    headers: { origin: HARNESS_ORIGIN },
    cookies: { [TEST_COOKIE_NAME]: cookie },
  });
}

describe('the data endpoints answer and match their contracts', () => {
  it('users, practice, foxy, billing, audit and coverage', async () => {
    const cases: [string, { safeParse: (value: unknown) => { success: boolean } }][] = [
      ['/api/v1/admin/users', adminUsersResponseSchema],
      ['/api/v1/admin/practice/sessions', adminPracticeSessionsResponseSchema],
      ['/api/v1/admin/foxy/sessions', adminChatSessionsResponseSchema],
      ['/api/v1/admin/billing/subscriptions', adminSubscriptionsResponseSchema],
      ['/api/v1/admin/audit', adminAuditResponseSchema],
      ['/api/v1/admin/content/coverage', adminContentCoverageResponseSchema],
    ];

    for (const [url, schema] of cases) {
      const response = await get(url);
      expect({ url, status: response.statusCode }).toEqual({ url, status: 200 });
      expect({ url, ok: schema.safeParse(response.json()).success }).toEqual({ url, ok: true });
    }
  });
});

describe('the raw email never reaches the wire', () => {
  it('is absent from the users list', async () => {
    const response = await get('/api/v1/admin/users');
    expect(response.body).not.toContain(SECRET_LOCAL);
    expect(response.body).not.toContain(SECRET_EMAIL);

    const parsed = adminUsersResponseSchema.parse(response.json());
    const learner = parsed.items.find((item) => item.id === studentUserId);
    // Masked, but still a pseudonym an operator can distinguish.
    expect(learner?.emailMasked).toBe('z•••@e•••.test');
  });

  it('is absent from the user detail, and so is the display name', async () => {
    const response = await get(`/api/v1/admin/users/${studentUserId}`);
    expect(response.body).not.toContain(SECRET_LOCAL);
    expect(response.body).not.toContain('Wubblefloop');
    expect(response.body).not.toContain('Qzarnix');

    const parsed = adminUserDetailResponseSchema.parse(response.json());
    expect(parsed.learner?.displayNameMasked).toBe('W.Q.');
    // The operational facts survive — this screen is still useful.
    expect(parsed.learner?.grade).toBe('8');
    expect(parsed.counts.chatSessions).toBe(1);
  });
});

describe('the transcript carries no transcript', () => {
  it('returns turn shape and never the message text', async () => {
    const response = await get(`/api/v1/admin/foxy/sessions/${chatSessionId}`);
    expect(response.statusCode).toBe(200);

    // THE ASSERTION THIS FILE EXISTS FOR.
    expect(response.body).not.toContain('zzyzxq');
    expect(response.body).not.toContain('home address');
    expect(response.body).not.toContain(SECRET_MESSAGE);

    const parsed = adminChatSessionDetailResponseSchema.parse(response.json());
    expect(parsed.turns).toHaveLength(1);
    // What survives is enough to see the SHAPE of a conversation that went wrong.
    expect(parsed.turns[0]).toEqual({
      // The id that reaches the trace explaining this turn.
      messageId: expect.any(String),
      role: 'user',
      length: SECRET_MESSAGE.length,
      createdAt: expect.any(String),
      action: null,
      abstained: false,
      citationCount: 0,
    });
  });

  it('reports message counts on the list without carrying any message', async () => {
    const response = await get('/api/v1/admin/foxy/sessions');
    expect(response.body).not.toContain('zzyzxq');

    const parsed = adminChatSessionsResponseSchema.parse(response.json());
    expect(parsed.items[0]?.messageCount).toBe(1);
    expect(parsed.items[0]?.abstentions).toBe(0);
  });
});

describe('one learner activity feed, split by visit', () => {
  it('reports activities and the number of sittings they were', async () => {
    // Two practice sessions in one visit and one in another, driven through the
    // real service so `visit_id` is written the way production writes it.
    const actor = { userId: studentUserId, role: 'student' as const, tenantId: TEST_TENANT_ID };
    const visitA = '018f4b2c-9d3a-7c21-8f6e-1a2b3c4d5e6f';
    const visitB = '028f4b2c-9d3a-7c21-8f6e-1a2b3c4d5e6f';

    await harness.postgres.client.query(
      `update chat_sessions set visit_id = $1 where id = $2`,
      [visitA, chatSessionId],
    );
    await harness.postgres.client.query(
      `insert into practice_sessions
         (student_user_id, chapter_id, question_ids, started_at, tenant_id, visit_id)
       values ($1, $2, array[$3::uuid], now(), $4, $5), ($1, $2, array[$3::uuid], now(), $4, $6)`,
      [actor.userId, chapterId, chapterId, TEST_TENANT_ID, visitA, visitB],
    );

    const response = await get(`/api/v1/admin/learners/${studentUserId}/activity`);
    expect(response.statusCode).toBe(200);

    const parsed = adminActivityResponseSchema.parse(response.json());
    expect(parsed.items).toHaveLength(3);
    // THE QUESTION THE VIEW WAS BUILT FOR: three activities, two sittings.
    expect(parsed.visits).toBe(2);
    expect(parsed.items.map((item) => item.kind).sort()).toEqual(['chat', 'practice', 'practice']);
    // A chat session nobody spoke in and an unsubmitted practice session are
    // labelled in their own vocabularies, not flattened into one flag.
    expect(new Set(parsed.items.map((item) => item.outcome))).toEqual(new Set(['used', 'open']));
  });
});

describe('paging', () => {
  it('refuses a malformed cursor with a 400 rather than silently restarting', async () => {
    // Ignoring a bad cursor makes a paging bug look like a data bug, and the
    // caller pages for ever without being told why.
    const response = await get('/api/v1/admin/users?cursor=not-a-real-cursor');
    expect(response.statusCode).toBe(400);
  });

  it('walks pages without repeating or skipping a row', async () => {
    const first = adminUsersResponseSchema.parse((await get('/api/v1/admin/users?limit=1')).json());
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = adminUsersResponseSchema.parse(
      (await get(`/api/v1/admin/users?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`)).json(),
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });
});

describe('an unknown id is a 404, not an empty object', () => {
  it.each([
    '/api/v1/admin/users/99999999-9999-4999-8999-999999999999',
    '/api/v1/admin/foxy/sessions/99999999-9999-4999-8999-999999999999',
    '/api/v1/admin/foxy/traces/99999999-9999-4999-8999-999999999999',
  ])('%s', async (url) => {
    expect((await get(url)).statusCode).toBe(404);
  });
});

describe('reading the record is itself recorded', () => {
  it('writes an admin.read row for a data read, naming the resource', async () => {
    await get(`/api/v1/admin/users/${studentUserId}`);

    const { rows } = await harness.postgres.client.query<{
      resource_type: string;
      resource_id: string | null;
      metadata: Record<string, unknown>;
    }>(`select resource_type, resource_id, metadata from audit_log where resource_type = 'user'`);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe(studentUserId);
    // Identifiers and counts only — never the address that was just read.
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain(SECRET_LOCAL);
  });
});
