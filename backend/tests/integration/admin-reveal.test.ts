import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { revealResponseSchema } from '@/shared/contracts/admin.contract';
import { REVEAL_LIMIT } from '@/modules/admin/domain/reveal';
import {
  HARNESS_ORIGIN,
  TEST_COOKIE_NAME,
  TEST_TENANT_ID,
  onboardAccount,
  startAppHarness,
  type AppHarness,
} from '../helpers/app-harness';

/**
 * =============================================================================
 * REVEAL — the deliberate exception, and the fence around it.
 *
 * Everything else on this surface is masked. This endpoint is the one road to
 * an unmasked value, and its value is entirely in its constraints: a closed
 * field matrix, a closed reason set, only the fields asked for, and an audit
 * row that names the fields and the reason but NEVER the value.
 *
 * That last one is the property most likely to be "improved" away — writing the
 * revealed email into the audit row looks like better forensics and would make
 * the audit log a second copy of everything anybody ever looked at, with weaker
 * access control than the first.
 * =============================================================================
 */

let harness: AppHarness;

const SECRET_LOCAL = 'qxzv8821revealtarget';
const SECRET_EMAIL = `${SECRET_LOCAL}@example.test`;
const SECRET_NAME = 'Zorbulax Yimmerfen';
const SECRET_MESSAGE = 'the plaintext nobody should see unless they asked, wibblequux';

let studentUserId: string;
let adminCookie: string;
let chatSessionId: string;

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

  const session = await harness.postgres.client.query<{ id: string }>(
    `insert into chat_sessions (student_user_id, tenant_id, mode, subject, language)
     values ($1, $2, 'doubt', 'science', 'en') returning id`,
    [studentUserId, TEST_TENANT_ID],
  );
  chatSessionId = session.rows[0]?.id ?? '';
  await harness.postgres.client.query(
    `insert into chat_messages (session_id, tenant_id, role, content)
     values ($1, $2, 'user', $3)`,
    [chatSessionId, TEST_TENANT_ID, SECRET_MESSAGE],
  );
});

function reveal(body: unknown, cookie = adminCookie): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url: '/api/v1/admin/reveal',
    headers: { origin: HARNESS_ORIGIN },
    payload: body as Record<string, unknown>,
    cookies: { [TEST_COOKIE_NAME]: cookie },
  });
}

async function auditRows(): Promise<
  { action: string; resource_type: string; resource_id: string | null; metadata: Record<string, unknown> }[]
> {
  const { rows } = await harness.postgres.client.query<{
    action: string;
    resource_type: string;
    resource_id: string | null;
    metadata: Record<string, unknown>;
  }>(`select action, resource_type, resource_id, metadata from audit_log where action = 'admin.revealed'`);
  return rows;
}

describe('a reveal returns the value and writes it down', () => {
  it('unmasks an email and records the fields and the reason, not the value', async () => {
    const response = await reveal({
      resourceType: 'user',
      resourceId: studentUserId,
      fields: ['email'],
      reasonCode: 'support_request',
    });

    expect(response.statusCode).toBe(200);
    const parsed = revealResponseSchema.parse(response.json());
    expect(parsed.revealed.email).toBe(SECRET_EMAIL);
    expect(parsed.auditedAs).toBe('admin.revealed');

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_type).toBe('user');
    expect(rows[0]?.resource_id).toBe(studentUserId);
    expect(rows[0]?.metadata).toEqual({ fields: ['email'], reasonCode: 'support_request' });

    // THE PROPERTY MOST LIKELY TO BE "IMPROVED" AWAY. The audit row must not
    // become a second copy of everything anybody ever looked at.
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain(SECRET_LOCAL);
  });

  it('unmasks a learner name', async () => {
    const parsed = revealResponseSchema.parse(
      (
        await reveal({
          resourceType: 'learner',
          resourceId: studentUserId,
          fields: ['displayName'],
          reasonCode: 'quality_review',
        })
      ).json(),
    );
    expect(parsed.revealed.displayName).toBe(SECRET_NAME);
  });

  it('unmasks a transcript, in turn order', async () => {
    const parsed = revealResponseSchema.parse(
      (
        await reveal({
          resourceType: 'chat_session',
          resourceId: chatSessionId,
          fields: ['transcript'],
          reasonCode: 'abuse_report',
        })
      ).json(),
    );
    expect(parsed.revealed.transcript).toEqual([`user: ${SECRET_MESSAGE}`]);
  });
});

describe('the fence around it', () => {
  it('returns ONLY the fields asked for', async () => {
    // A reveal that returned the whole row would make "reveal one field"
    // impossible to audit honestly.
    const parsed = revealResponseSchema.parse(
      (
        await reveal({
          resourceType: 'user',
          resourceId: studentUserId,
          fields: ['email'],
          reasonCode: 'incident',
        })
      ).json(),
    );
    expect(Object.keys(parsed.revealed)).toEqual(['email']);
  });

  it('refuses a field that is not in the matrix, before loading anything', async () => {
    const response = await reveal({
      resourceType: 'user',
      resourceId: studentUserId,
      fields: ['password_hash'],
      reasonCode: 'incident',
    });
    expect(response.statusCode).toBe(400);
    // Nothing was revealed, so nothing was written down.
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses a field belonging to a different resource type', async () => {
    // `displayName` is revealable — for `learner`, not for `user`. The matrix
    // is per resource, not a global allow-list of column names.
    const response = await reveal({
      resourceType: 'user',
      resourceId: studentUserId,
      fields: ['displayName'],
      reasonCode: 'incident',
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an unknown resource type', async () => {
    const response = await reveal({
      resourceType: 'users',
      resourceId: studentUserId,
      fields: ['email'],
      reasonCode: 'incident',
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses free text as a reason', async () => {
    // The reason is a CODE because `audit_log.metadata` is identifiers and
    // counts only, and free text typed during an incident is where a learner's
    // name ends up.
    const response = await reveal({
      resourceType: 'user',
      resourceId: studentUserId,
      fields: ['email'],
      reasonCode: 'because the parent called and their name is Aarav',
    });
    expect(response.statusCode).toBe(400);
    expect(await auditRows()).toHaveLength(0);
  });

  it('requires a reason at all', async () => {
    const response = await reveal({
      resourceType: 'user',
      resourceId: studentUserId,
      fields: ['email'],
    });
    expect(response.statusCode).toBe(400);
  });

  it('is 404 to a student, like every other admin route', async () => {
    const student = await onboardAccount(harness, 'nosy@example.test', 'student');
    const response = await reveal(
      {
        resourceType: 'user',
        resourceId: studentUserId,
        fields: ['email'],
        reasonCode: 'incident',
      },
      student.cookie,
    );
    expect(response.statusCode).toBe(404);
    expect(await auditRows()).toHaveLength(0);
  });

  it('is a 404 for a resource that does not exist', async () => {
    const response = await reveal({
      resourceType: 'user',
      resourceId: '99999999-9999-4999-8999-999999999999',
      fields: ['email'],
      reasonCode: 'incident',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('the throttle', () => {
  it('refuses past the hourly ceiling, and refusal reveals nothing', async () => {
    /**
     * An audit trail RECORDS enumeration; it does not prevent it. A patient
     * caller pulling one address per request writes one dutiful row per
     * address, and the evidence is discovered afterwards.
     *
     * The ceiling is deliberately far above a real support call (one reveal)
     * and far below a scrape, so this test spends the whole allowance to reach
     * the interesting request — the one after it.
     */
    const body = {
      resourceType: 'user',
      resourceId: studentUserId,
      fields: ['email'],
      reasonCode: 'support_request',
    };

    let refusedAt = 0;
    for (let attempt = 1; attempt <= REVEAL_LIMIT.max + 1; attempt += 1) {
      const response = await reveal(body);
      if (response.statusCode === 429) {
        refusedAt = attempt;
        break;
      }
      expect({ attempt, status: response.statusCode }).toEqual({ attempt, status: 200 });
    }

    expect(refusedAt).toBe(REVEAL_LIMIT.max + 1);

    // The refusal carries no value and no policy detail — a limiter that told a
    // caller its exact ceiling would be telling them how to pace themselves.
    const refused = await reveal(body);
    expect(refused.statusCode).toBe(429);
    expect(refused.body).not.toContain(SECRET_LOCAL);

    // AND THE REFUSED ATTEMPTS ARE NOT AUDITED AS REVEALS. The throttle runs
    // before the row is read, so a refusal is not a disclosure and must not sit
    // in the trail looking like one.
    expect((await auditRows()).length).toBe(REVEAL_LIMIT.max);
  });
});
