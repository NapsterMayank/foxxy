import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@/platform/audit/index';
import { PLATFORM_ROLES, SIGNUP_ROLES } from '@/shared/constants/roles';
import {
  HARNESS_ORIGIN,
  TEST_COOKIE_NAME,
  onboardAccount,
  startAppHarness,
  type AppHarness,
} from '../helpers/app-harness';

/**
 * The four privileged identity actions, end to end over HTTP, with a real
 * `audit_log` behind them — 05-ROADMAP.md §8.
 *
 * WHY THESE FOUR AND NOT MORE. Each CHANGES SECURITY STATE and each is
 * something a parent, a school or a regulator could reasonably ask about
 * afterwards. Ordinary activity is deliberately absent: a successful login
 * happens hundreds of times a day per user and would bury these four under a
 * million rows, and an audit log that is expensive to read is one nobody reads.
 *
 * The LINK pair are the consent trail. §6.8 step 5 has the STUDENT approve, in
 * the app, and a code alone grants nothing — these rows are what you point at
 * when the question is how a parent came to have access to a minor's data.
 *
 * This file also pins the other half of migration 0005: the column accepts ten
 * roles and SIGNUP STILL ACCEPTS TWO.
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

interface AuditRow {
  action: string;
  actor_user_id: string | null;
  actor_role: string | null;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
}

async function auditRows(): Promise<AuditRow[]> {
  const result = await harness.postgres.client.query<AuditRow>(
    `select action, actor_user_id, actor_role, resource_type, resource_id, metadata
       from audit_log order by created_at`,
  );
  return result.rows;
}

function post(url: string, payload: unknown, cookie?: string) {
  return harness.app.inject({
    method: 'POST',
    url,
    // The Origin header is not optional here: §6.10's check rejects any
    // state-changing request without an allowed one, BEFORE authentication —
    // deliberately, so the CSRF verdict does not depend on who the caller
    // claims to be.
    headers: { origin: HARNESS_ORIGIN },
    ...(cookie === undefined ? {} : { cookies: { [TEST_COOKIE_NAME]: cookie } }),
    payload: payload as Record<string, unknown>,
  });
}

describe('logout-all is audited', () => {
  it('records the action, the actor and a COUNT of revoked sessions', async () => {
    const student = await onboardAccount(harness, 'audit-logout@example.test', 'student');

    const response = await post('/api/v1/auth/logout-all', {}, student.cookie);
    expect(response.statusCode).toBe(200);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe(AUDIT_ACTIONS.LOGOUT_ALL);
    expect(rows[0]?.actor_user_id).toBe(student.userId);
    expect(rows[0]?.actor_role).toBe('student');
    // A COUNT, which identifies nobody, and which is the one fact worth having
    // later: "I was signed out of six devices I did not recognise" is the shape
    // of the support conversation this row exists to answer.
    //
    // TWO, not one, and the number is worth understanding rather than
    // adjusting: `verifyEmail` issues a session (§6.3) and so does the `login`
    // that follows it in `onboardAccount`. A freshly onboarded account really
    // does hold two sessions, which is exactly the sort of thing this count
    // exists to make visible.
    expect(rows[0]?.metadata).toEqual({ sessions: 2 });
  });
});

describe('a password reset is audited', () => {
  it('records the USER whose credentials moved, and nothing about the token', async () => {
    await onboardAccount(harness, 'audit-reset@example.test', 'student');
    harness.mail.sent.length = 0;
    await harness.postgres.client.query('truncate table audit_log');

    await post('/api/v1/auth/forgot-password', { email: 'audit-reset@example.test' });
    const resetUrl = harness.mail.sent.at(-1)?.data.resetUrl ?? '';
    const token = new URL(resetUrl).searchParams.get('token') ?? '';

    const response = await post('/api/v1/auth/reset-password', {
      token,
      password: 'a-completely-different-passphrase',
    });
    expect(response.statusCode).toBe(200);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe(AUDIT_ACTIONS.PASSWORD_RESET);
    expect(rows[0]?.metadata).toEqual({ sessionsRevoked: true, via: 'reset_token' });

    // NOTHING about the token — it is a live credential until consumed — and
    // nothing about the email address. The scrubber would have caught the
    // address; a payload that RELIES on the scrubber is a payload written by
    // somebody who did not think about it.
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain('audit-reset@example.test');
  });
});

describe('the parent-child consent trail', () => {
  it('records approval and revocation, with who did which', async () => {
    const student = await onboardAccount(harness, 'audit-child@example.test', 'student');
    const parent = await onboardAccount(harness, 'audit-parent@example.test', 'parent');
    await harness.postgres.client.query('truncate table audit_log');

    const codeResponse = await post('/api/v1/links/code', {}, student.cookie);
    const code = (JSON.parse(codeResponse.body) as { code: string }).code;

    /*
     * MIGRATION 0007 — the trail is unchanged in shape, reached by a new route.
     *
     * `POST /links/submit` and the student's `approve` are gone: that consent
     * step was unreachable, because no endpoint gave a student a pending link's
     * id. The parent now proves possession of their own mailbox instead, and the
     * link is approved on redemption.
     */
    await post('/api/v1/links/request-otp', { code }, parent.cookie);

    // REQUESTING AN OTP IS NOT AUDITED, and that is deliberate — the same
    // reasoning that left `submit` unaudited. No access has been granted yet, so
    // a row here would record an intention rather than an access.
    expect(await auditRows()).toHaveLength(0);

    const otp = String(harness.mail.sent.at(-1)?.data.otp);
    const redeemed = await post('/api/v1/links/redeem', { code, otp }, parent.cookie);
    const linkId = (JSON.parse(redeemed.body) as { link: { id: string } }).link.id;

    await post(`/api/v1/links/${linkId}/revoke`, {}, parent.cookie);

    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual([
      AUDIT_ACTIONS.LINK_APPROVED,
      AUDIT_ACTIONS.LINK_REVOKED,
    ]);

    // Approval is by the STUDENT. That is what makes consent real, and it is
    // the single most important thing this row records.
    expect(rows[0]?.actor_user_id).toBe(student.userId);
    expect(rows[0]?.actor_role).toBe('student');
    expect(rows[0]?.resource_id).toBe(linkId);
    /*
     * `via` RECORDS WHICH ROUTE PRODUCED THE CONSENT — migration 0007.
     *
     * The action stays `LINK_APPROVED`, because from a school's or a regulator's
     * point of view this is the same event the old flow recorded. What changed is
     * how it was reached, and a trail that could not distinguish "the student
     * pressed approve" from "the student handed over a code and the parent proved
     * their mailbox" would be answering a question it cannot actually answer.
     */
    expect(rows[0]?.metadata).toEqual({
      via: 'link_code_otp',
      parentUserId: parent.userId,
    });

    // EITHER party may revoke (§6.8 step 7), and "the parent withdrew" and "the
    // child withdrew" are very different facts to a school. The link row itself
    // records only that it happened, not who did it.
    expect(rows[1]?.actor_user_id).toBe(parent.userId);
    expect(rows[1]?.metadata).toMatchObject({ revokedByRole: 'parent' });
  });

  it('carries no names or addresses anywhere in the trail', async () => {
    const student = await onboardAccount(harness, 'audit-pii-child@example.test', 'student');
    const parent = await onboardAccount(harness, 'audit-pii-parent@example.test', 'parent');
    await harness.postgres.client.query('truncate table audit_log');

    const codeResponse = await post('/api/v1/links/code', {}, student.cookie);
    const code = (JSON.parse(codeResponse.body) as { code: string }).code;
    await post('/api/v1/links/request-otp', { code }, parent.cookie);
    const otp = String(harness.mail.sent.at(-1)?.data.otp);
    await post('/api/v1/links/redeem', { code, otp }, parent.cookie);

    // The strongest form: dump the whole table and look for anything personal.
    const raw = await harness.postgres.client.query<{ dump: string }>(
      'select audit_log::text as dump from audit_log',
    );
    const dump = raw.rows.map((row) => row.dump).join(' ');
    expect(dump).not.toContain('audit-pii-child@example.test');
    expect(dump).not.toContain('audit-pii-parent@example.test');
    expect(dump).not.toContain('@');
  });
});

describe('auditing never breaks the action it records', () => {
  it('completes a logout-all even though audit rows cannot be deleted', async () => {
    // A sanity check on the interaction between two features that could
    // plausibly collide: `logout-all` deletes session rows, `audit_log` refuses
    // DELETE. They must not be the same statement.
    const student = await onboardAccount(harness, 'audit-nobreak@example.test', 'student');
    await post('/api/v1/auth/logout-all', {}, student.cookie);
    const second = await post('/api/v1/auth/logout-all', {}, student.cookie);
    // The session is gone, so the second call is unauthenticated — which is the
    // correct outcome and, importantly, not a 500.
    expect(second.statusCode).toBe(401);
  });
});

describe('the widened role enum did NOT widen signup', () => {
  it('rejects every role outside SIGNUP_ROLES with a 400', async () => {
    // THE test that keeps migration 0005 from being a privilege-escalation
    // hole. The COLUMN accepts ten values; `roleSchema` is built from
    // `SIGNUP_ROLES`, not `PLATFORM_ROLES`, and they are separate constants on
    // purpose.
    //
    // The day somebody "simplifies" the contract to point at `PLATFORM_ROLES`,
    // it compiles, it inserts, and a public endpoint accepts
    // `role: 'super_admin'`. Nothing else in the codebase notices.
    const ungranted = PLATFORM_ROLES.filter(
      (role) => !(SIGNUP_ROLES as readonly string[]).includes(role),
    );
    expect(ungranted.length).toBeGreaterThan(0);

    for (const role of ungranted) {
      const response = await post('/api/v1/auth/signup', {
        email: `signup-${role}@example.test`,
        password: 'vermillion-otter-49',
        role,
      });
      expect(response.statusCode).toBe(400);
    }

    // And no account was created for any of them.
    const created = await harness.postgres.client.query<{ count: string }>(
      `select count(*)::text from users where role not in ('student', 'parent')`,
    );
    expect(created.rows[0]?.count).toBe('0');
  });

  it('still accepts student and parent', async () => {
    // The control. Without it the test above would pass against a signup
    // endpoint that rejected everything.
    for (const role of SIGNUP_ROLES) {
      const response = await post('/api/v1/auth/signup', {
        email: `signup-ok-${role}@example.test`,
        password: 'vermillion-otter-49',
        role,
      });
      expect(response.statusCode).toBe(201);
    }
  });
});
