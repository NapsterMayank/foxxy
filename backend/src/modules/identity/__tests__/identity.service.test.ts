import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ERROR_CODES, isAppError } from '@/platform/errors/index';
import {
  LOGIN_RATE_LIMIT,
  LOGOUT_RATE_LIMIT,
  SIGNUP_RATE_LIMIT,
} from '@/shared/constants/rate-limits';
import { LINK_CODE_TTL_MS } from '../domain/link-code';
import {
  EMAIL_VERIFICATION_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  SESSION_IDLE_TTL_MS,
} from '../domain/token';
import type { IdentityService } from '../identity.service';
import type { RequestContext } from '../identity.types';
import { TEST_TENANT_ID, startIdentityHarness, type IdentityHarness } from './harness';

/**
 * Service tests — §8.1, "service tests", against a REAL Postgres.
 *
 * Every named test from the plan is here, plus the branches around them
 * required by the §9.3 checklist.
 */

let harness: IdentityHarness;
let service: IdentityService;

const CONTEXT: RequestContext = { ipHash: 'ip-hash-a', userAgent: 'vitest' };
const OTHER_IP: RequestContext = { ipHash: 'ip-hash-b', userAgent: 'vitest' };
const GOOD_PASSWORD = 'vermillion-otter-49';

beforeAll(async () => {
  harness = await startIdentityHarness();
  service = harness.identity.service;
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

/** Signs up, reads the token out of the mail fake, and verifies it. */
async function signupAndVerify(
  email: string,
  role: 'student' | 'parent',
  context: RequestContext = CONTEXT,
): Promise<{ userId: string; sessionToken: string }> {
  await service.signup({ email, password: GOOD_PASSWORD, role }, context);
  const verifyUrl = harness.mail.sent.at(-1)?.data.verifyUrl ?? '';
  const token = new URL(verifyUrl).searchParams.get('token') ?? '';
  const result = await service.verifyEmail(token, context);
  return { userId: result.user.id, sessionToken: result.session.token };
}

async function countRows(table: string): Promise<number> {
  const result = await harness.postgres.client.query<{ count: string }>(
    `select count(*)::text as count from ${table}`,
  );
  return Number(result.rows[0]?.count ?? '0');
}

function codeOf(error: unknown): string {
  return isAppError(error) ? error.code : 'NOT_AN_APP_ERROR';
}

// ---------------------------------------------------------------------------
// §6.2 signup
// ---------------------------------------------------------------------------

describe('signup', () => {
  it('creates the user, the verification token, and sends the mail', async () => {
    await service.signup(
      { email: 'a@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );

    expect(await countRows('users')).toBe(1);
    expect(await countRows('email_verification_tokens')).toBe(1);
    expect(harness.mail.sent).toHaveLength(1);
    expect(harness.mail.sent[0]?.template).toBe('email-verification');
  });

  it('normalises the email before storing it', async () => {
    await service.signup(
      { email: '  MiXeD@Example.TEST ', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );
    const result = await harness.postgres.client.query<{ email: string }>(
      'select email from users',
    );
    expect(result.rows[0]?.email).toBe('mixed@example.test');
  });

  it('stores no session — the account is not logged in until verified', async () => {
    await service.signup(
      { email: 'a@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );
    expect(await countRows('sessions')).toBe(0);
  });

  it('stores a HASH of the verification token, never the token', async () => {
    await service.signup(
      { email: 'a@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );
    const verifyUrl = harness.mail.sent[0]?.data.verifyUrl ?? '';
    const token = new URL(verifyUrl).searchParams.get('token') ?? '';
    const stored = await harness.postgres.client.query<{ token_hash: string }>(
      'select token_hash from email_verification_tokens',
    );
    expect(token).not.toBe('');
    expect(stored.rows[0]?.token_hash).not.toBe(token);
  });

  it('expires the verification token 24 hours out', async () => {
    await service.signup(
      { email: 'a@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );
    const stored = await harness.postgres.client.query<{ expires_at: Date }>(
      'select expires_at from email_verification_tokens',
    );
    const expected = harness.clock.now().getTime() + EMAIL_VERIFICATION_TTL_MS;
    expect(stored.rows[0]?.expires_at.getTime()).toBe(expected);
  });

  it('rejects a password shorter than the minimum', async () => {
    await expect(
      service.signup({ email: 'a@example.test', password: 'short', role: 'student' }, CONTEXT),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION });
    expect(await countRows('users')).toBe(0);
  });

  it('rejects a common password', async () => {
    await expect(
      service.signup(
        { email: 'a@example.test', password: 'password123', role: 'student' },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION });
  });

  it('accepts the parent role as well as student', async () => {
    await service.signup(
      { email: 'p@example.test', password: GOOD_PASSWORD, role: 'parent' },
      CONTEXT,
    );
    const stored = await harness.postgres.client.query<{ role: string }>('select role from users');
    expect(stored.rows[0]?.role).toBe('parent');
  });
});

// ---------------------------------------------------------------------------
// §6.2, THE ENUMERATION TRAP
// ---------------------------------------------------------------------------

describe('signup — the enumeration defence', () => {
  it('resolves identically for an address that already has an account', async () => {
    await service.signup(
      { email: 'taken@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );

    // Byte-for-byte the same outcome as a fresh signup: no throw, no
    // distinguishable value. Anything else lets anyone discover which
    // addresses have accounts.
    await expect(
      service.signup(
        { email: 'taken@example.test', password: 'a-different-password-99', role: 'parent' },
        OTHER_IP,
      ),
    ).resolves.toBeUndefined();
  });

  it('creates no second user and no second verification token', async () => {
    await service.signup(
      { email: 'taken@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );
    await service.signup(
      { email: 'taken@example.test', password: GOOD_PASSWORD, role: 'parent' },
      OTHER_IP,
    );

    expect(await countRows('users')).toBe(1);
    expect(await countRows('email_verification_tokens')).toBe(1);
  });

  it('does not overwrite the existing account role or password', async () => {
    await service.signup(
      { email: 'taken@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );
    await service.signup(
      { email: 'taken@example.test', password: 'entirely-other-77', role: 'parent' },
      OTHER_IP,
    );

    const stored = await harness.postgres.client.query<{ role: string; password_hash: string }>(
      'select role, password_hash from users',
    );
    expect(stored.rows[0]?.role).toBe('student');
    expect(stored.rows[0]?.password_hash).toBe(`fake$${GOOD_PASSWORD}`);
  });

  it('emails the EXISTING account instead, so the owner learns of the attempt', async () => {
    await service.signup(
      { email: 'taken@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );
    harness.mail.sent.length = 0;

    await service.signup(
      { email: 'taken@example.test', password: GOOD_PASSWORD, role: 'parent' },
      OTHER_IP,
    );

    expect(harness.mail.sent).toHaveLength(1);
    expect(harness.mail.sent[0]?.template).toBe('signup-attempt-on-existing-account');
    expect(harness.mail.sent[0]?.to).toBe('taken@example.test');
  });

  it('treats a differently-cased address as the same account', async () => {
    await service.signup(
      { email: 'taken@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );
    await service.signup(
      { email: 'TAKEN@Example.Test', password: GOOD_PASSWORD, role: 'student' },
      OTHER_IP,
    );

    expect(await countRows('users')).toBe(1);
    expect(harness.mail.sent.at(-1)?.template).toBe('signup-attempt-on-existing-account');
  });

  it('hashes the password on the existing-address path too, so the work is the same', async () => {
    await service.signup(
      { email: 'taken@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );
    harness.hasher.hashCalls.length = 0;

    await service.signup(
      { email: 'taken@example.test', password: GOOD_PASSWORD, role: 'parent' },
      OTHER_IP,
    );

    // Skipping the hash on the duplicate path would make it measurably faster
    // and reintroduce the leak the identical response was written to close.
    expect(harness.hasher.hashCalls).toHaveLength(1);
  });

  it('relies on the UNIQUE constraint, not a pre-check, for the race', async () => {
    // Both calls are started before either completes, which is the shape of
    // the race in §6.2 step 5. Exactly one row may exist afterwards.
    const results = await Promise.allSettled([
      service.signup(
        { email: 'race@example.test', password: GOOD_PASSWORD, role: 'student' },
        CONTEXT,
      ),
      service.signup(
        { email: 'race@example.test', password: GOOD_PASSWORD, role: 'student' },
        OTHER_IP,
      ),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(await countRows('users')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §6.3 verification
// ---------------------------------------------------------------------------

describe('verifyEmail', () => {
  it('marks the address verified and issues a session', async () => {
    const { userId, sessionToken } = await signupAndVerify('a@example.test', 'student');

    const stored = await harness.postgres.client.query<{ email_verified_at: Date | null }>(
      'select email_verified_at from users where id = $1',
      [userId],
    );
    expect(stored.rows[0]?.email_verified_at).not.toBeNull();
    expect(sessionToken).not.toBe('');
    expect(await countRows('sessions')).toBe(1);
  });

  it('consumes the token in the same transaction — a second use fails', async () => {
    await service.signup(
      { email: 'a@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );
    const verifyUrl = harness.mail.sent[0]?.data.verifyUrl ?? '';
    const token = new URL(verifyUrl).searchParams.get('token') ?? '';

    await service.verifyEmail(token, CONTEXT);
    await expect(service.verifyEmail(token, CONTEXT)).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION,
    });
    expect(await countRows('sessions')).toBe(1);
  });

  it('rejects an unknown token with the same message as a consumed one', async () => {
    await expect(service.verifyEmail('not-a-real-token', CONTEXT)).rejects.toMatchObject({
      safeMessage: 'This link is invalid or has expired.',
    });
  });

  it('rejects a token past its 24-hour expiry', async () => {
    await service.signup(
      { email: 'a@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );
    const verifyUrl = harness.mail.sent[0]?.data.verifyUrl ?? '';
    const token = new URL(verifyUrl).searchParams.get('token') ?? '';

    harness.clock.advanceMs(EMAIL_VERIFICATION_TTL_MS);

    await expect(service.verifyEmail(token, CONTEXT)).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION,
    });
  });

  it('accepts a token one millisecond before expiry', async () => {
    await service.signup(
      { email: 'a@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );
    const verifyUrl = harness.mail.sent[0]?.data.verifyUrl ?? '';
    const token = new URL(verifyUrl).searchParams.get('token') ?? '';

    harness.clock.advanceMs(EMAIL_VERIFICATION_TTL_MS - 1);

    await expect(service.verifyEmail(token, CONTEXT)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §6.4 login
// ---------------------------------------------------------------------------

describe('login', () => {
  it('succeeds for a verified account and issues a FRESH session', async () => {
    const { sessionToken } = await signupAndVerify('a@example.test', 'student');

    const result = await service.login(
      { email: 'a@example.test', password: GOOD_PASSWORD },
      CONTEXT,
    );

    // §6.10, session fixation: the new token is never the old one.
    expect(result.session.token).not.toBe(sessionToken);
    expect(await countRows('sessions')).toBe(2);
  });

  it('FAILS ON AN UNVERIFIED EMAIL, with a machine-readable reason', async () => {
    await service.signup(
      { email: 'a@example.test', password: GOOD_PASSWORD, role: 'student' },
      CONTEXT,
    );

    const error: unknown = await service
      .login({ email: 'a@example.test', password: GOOD_PASSWORD }, CONTEXT)
      .catch((caught: unknown) => caught);

    expect(isAppError(error) ? error.httpStatus : 0).toBe(403);
    expect(isAppError(error) ? error.toClientPayload() : {}).toMatchObject({
      error: { reason: 'EMAIL_NOT_VERIFIED' },
    });
    expect(await countRows('sessions')).toBe(0);
  });

  it('gives ONE message for a wrong password', async () => {
    await signupAndVerify('a@example.test', 'student');
    await expect(
      service.login({ email: 'a@example.test', password: 'wrong-password-000' }, CONTEXT),
    ).rejects.toMatchObject({ safeMessage: 'Invalid email or password.' });
  });

  it('gives the SAME message when no account exists', async () => {
    await expect(
      service.login({ email: 'nobody@example.test', password: GOOD_PASSWORD }, CONTEXT),
    ).rejects.toMatchObject({ safeMessage: 'Invalid email or password.' });
  });

  it('runs a DUMMY verification when the account does not exist', async () => {
    harness.hasher.verifyCalls.length = 0;
    await service
      .login({ email: 'nobody@example.test', password: GOOD_PASSWORD }, CONTEXT)
      .catch(() => undefined);

    // The timing defence: the same work is done either way. Without this the
    // "no such account" path returns tens of milliseconds sooner, and that is
    // measurable from anywhere.
    expect(harness.hasher.verifyCalls).toHaveLength(1);
    expect(harness.hasher.verifyCalls[0]?.hash).toBe('fake$__dummy__');
  });

  it('IS REJECTED PAST THE RATE LIMIT', async () => {
    await signupAndVerify('a@example.test', 'student');

    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.limit; attempt += 1) {
      await service
        .login({ email: 'a@example.test', password: 'wrong-password-000' }, CONTEXT)
        .catch(() => undefined);
    }

    await expect(
      service.login({ email: 'a@example.test', password: GOOD_PASSWORD }, CONTEXT),
    ).rejects.toMatchObject({ code: ERROR_CODES.RATE_LIMIT });
  });

  it('rate limits BEFORE touching the database', async () => {
    // No account exists at all. If the limiter ran after the lookup, the
    // sixth attempt would still be an authentication failure.
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.limit; attempt += 1) {
      await service
        .login({ email: 'nobody@example.test', password: GOOD_PASSWORD }, CONTEXT)
        .catch(() => undefined);
    }
    harness.hasher.verifyCalls.length = 0;

    await expect(
      service.login({ email: 'nobody@example.test', password: GOOD_PASSWORD }, CONTEXT),
    ).rejects.toMatchObject({ code: ERROR_CODES.RATE_LIMIT });
    expect(harness.hasher.verifyCalls).toHaveLength(0);
  });

  it('stops an attacker who rotates IPs, because the counter is also keyed by email', async () => {
    await signupAndVerify('target@example.test', 'student');

    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.limit; attempt += 1) {
      await service
        .login(
          { email: 'target@example.test', password: 'wrong-password-000' },
          { ipHash: `rotating-ip-${attempt}`, userAgent: null },
        )
        .catch(() => undefined);
    }

    await expect(
      service.login(
        { email: 'target@example.test', password: GOOD_PASSWORD },
        { ipHash: 'rotating-ip-fresh', userAgent: null },
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.RATE_LIMIT });
  });

  it('stops an attacker spraying many accounts from one host, via the IP counter', async () => {
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.limit; attempt += 1) {
      await service
        .login({ email: `victim-${attempt}@example.test`, password: GOOD_PASSWORD }, CONTEXT)
        .catch(() => undefined);
    }

    await expect(
      service.login({ email: 'another@example.test', password: GOOD_PASSWORD }, CONTEXT),
    ).rejects.toMatchObject({ code: ERROR_CODES.RATE_LIMIT });
  });

  it('allows the limit to lapse once the window closes', async () => {
    await signupAndVerify('a@example.test', 'student');
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.limit; attempt += 1) {
      await service
        .login({ email: 'a@example.test', password: 'wrong-password-000' }, CONTEXT)
        .catch(() => undefined);
    }

    harness.clock.advanceSeconds(LOGIN_RATE_LIMIT.windowSeconds);

    await expect(
      service.login({ email: 'a@example.test', password: GOOD_PASSWORD }, CONTEXT),
    ).resolves.toBeDefined();
  });

  it('clears the counters after a successful login', async () => {
    await signupAndVerify('a@example.test', 'student');
    await service
      .login({ email: 'a@example.test', password: 'wrong-password-000' }, CONTEXT)
      .catch(() => undefined);
    await service.login({ email: 'a@example.test', password: GOOD_PASSWORD }, CONTEXT);

    // A legitimate user who mistyped once is not carrying that budget around.
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.limit; attempt += 1) {
      await service
        .login({ email: 'a@example.test', password: 'wrong-password-000' }, CONTEXT)
        .catch((error: unknown) => {
          expect(codeOf(error)).toBe(ERROR_CODES.UNAUTHENTICATED);
        });
    }
  });

  it('enforces the signup rate limit per IP', async () => {
    for (let attempt = 0; attempt < SIGNUP_RATE_LIMIT.limit; attempt += 1) {
      await service.signup(
        { email: `s-${attempt}@example.test`, password: GOOD_PASSWORD, role: 'student' },
        CONTEXT,
      );
    }
    await expect(
      service.signup(
        { email: 'one-too-many@example.test', password: GOOD_PASSWORD, role: 'student' },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.RATE_LIMIT });
  });
});

// ---------------------------------------------------------------------------
// §6.5 sessions
// ---------------------------------------------------------------------------

describe('validateSession', () => {
  it('resolves to { userId, role, tenantId } and NOTHING else', async () => {
    /**
     * The exhaustive key assertion is the point of this test, not the value
     * check above it. §6.5 step 5 says the session resolves to the actor and not
     * to the user row, and the way that rule dies is one convenient property at
     * a time — an email "just for the log line", then a plan, then a name.
     *
     * `tenantId` was ADDED to this list by D-073, and adding it was a deliberate
     * decision rather than a consequence. It earns its place because it is one
     * half of every authorisation decision: without it on the session, either
     * `assertCanAccess` could only ever see the resource's side, or every
     * authenticated request would pay for a second query to learn the caller's
     * tenant. Nothing else has that property, which is why nothing else is here.
     */
    const { userId, sessionToken } = await signupAndVerify('a@example.test', 'student');
    const actor = await service.validateSession(sessionToken);

    expect(actor).toEqual({ userId, role: 'student', tenantId: TEST_TENANT_ID });
    expect(Object.keys(actor).sort()).toEqual(['role', 'tenantId', 'userId']);
  });

  it('rejects a missing token', async () => {
    await expect(service.validateSession(undefined)).rejects.toMatchObject({
      code: ERROR_CODES.UNAUTHENTICATED,
    });
  });

  it('rejects an empty token', async () => {
    await expect(service.validateSession('')).rejects.toMatchObject({
      code: ERROR_CODES.UNAUTHENTICATED,
    });
  });

  it('rejects an unknown token', async () => {
    await expect(service.validateSession('nonsense')).rejects.toMatchObject({
      code: ERROR_CODES.UNAUTHENTICATED,
    });
  });

  it('REJECTS AN EXPIRED SESSION and reaps the row', async () => {
    const { sessionToken } = await signupAndVerify('a@example.test', 'student');

    harness.clock.advanceDays(30);

    await expect(service.validateSession(sessionToken)).rejects.toMatchObject({
      code: ERROR_CODES.UNAUTHENTICATED,
    });
    expect(await countRows('sessions')).toBe(0);
  });

  it('accepts a session one millisecond before its idle expiry', async () => {
    const { sessionToken } = await signupAndVerify('a@example.test', 'student');
    harness.clock.advanceMs(SESSION_IDLE_TTL_MS - 1);
    await expect(service.validateSession(sessionToken)).resolves.toBeDefined();
  });

  /**
   * =========================================================================
   * D-219 — A SESSION THAT IS USED CONSTANTLY STILL DIES.
   *
   * THE defect test. Renewal used to replace `expires_at` with `now + 30 days`
   * and nothing ever read `created_at`, so a token touched once inside each
   * renewal interval was a permanent credential — a stolen cookie that never
   * expired, under a comment claiming a 30-day ceiling.
   *
   * This walks a session forward in 25 one-day steps, validating at each one so
   * that renewal fires every time (`SESSION_RENEW_AFTER_MS` is 24 hours). Under
   * the defect the session is alive at day 40 and every day after. It must die
   * at exactly `created_at + 30 days`.
   *
   * Re-applying the defect — restoring `expiryFrom(now, absoluteSessionTtlMs)`
   * as the renewal deadline and dropping the `isPastAbsoluteLifetime` check —
   * turns this red at the day-30 assertion.
   * =========================================================================
   */
  it('KILLS A CONTINUOUSLY RENEWED SESSION AT THE ABSOLUTE CEILING', async () => {
    const { sessionToken } = await signupAndVerify('a@example.test', 'student');
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Twenty-five days of daily use. Every one of these renews.
    for (let day = 0; day < 25; day += 1) {
      harness.clock.advanceMs(DAY_MS);
      await expect(service.validateSession(sessionToken)).resolves.toBeDefined();
    }

    // Still alive one millisecond before the ceiling — the sliding window did
    // its job and an active user was not signed out.
    harness.clock.advanceMs(5 * DAY_MS - 1);
    await expect(service.validateSession(sessionToken)).resolves.toBeDefined();

    // And dead AT it, no matter how much it was used.
    harness.clock.advanceMs(1);
    await expect(service.validateSession(sessionToken)).rejects.toMatchObject({
      code: ERROR_CODES.UNAUTHENTICATED,
    });
    expect(await countRows('sessions')).toBe(0);
  });

  it('never writes an expires_at past the absolute ceiling', async () => {
    const { sessionToken } = await signupAndVerify('a@example.test', 'student');
    const created = await harness.postgres.client.query<{ created_at: Date }>(
      'select created_at from sessions',
    );
    const ceiling = (created.rows[0]?.created_at.getTime() ?? 0) + 30 * 24 * 60 * 60 * 1000;

    /**
     * Walked forward in two hops of 13 days rather than one of 25, because the
     * SLIDING window is 14 days: a single 25-day jump kills the session on the
     * idle bound and would assert nothing about the clamp. Each hop lands inside
     * the current idle deadline and renews it — which is the only way to reach
     * day 26 alive, and day 26 is where a full idle window (day 40) overshoots
     * the ceiling (day 30) and must be clamped to it.
     */
    const THIRTEEN_DAYS_MS = 13 * 24 * 60 * 60 * 1000;
    harness.clock.advanceMs(THIRTEEN_DAYS_MS);
    await service.validateSession(sessionToken);
    harness.clock.advanceMs(THIRTEEN_DAYS_MS);
    await service.validateSession(sessionToken);

    const after = await harness.postgres.client.query<{ expires_at: Date }>(
      'select expires_at from sessions',
    );
    expect(after.rows[0]?.expires_at.getTime()).toBe(ceiling);
  });

  it('does not renew a session used within the last 24 hours', async () => {
    const { sessionToken } = await signupAndVerify('a@example.test', 'student');
    const before = await harness.postgres.client.query<{ expires_at: Date }>(
      'select expires_at from sessions',
    );

    harness.clock.advanceMs(23 * 60 * 60 * 1000);
    await service.validateSession(sessionToken);

    const after = await harness.postgres.client.query<{ expires_at: Date }>(
      'select expires_at from sessions',
    );
    expect(after.rows[0]?.expires_at.getTime()).toBe(before.rows[0]?.expires_at.getTime());
  });

  it('renews a session used after 24 hours, so an active user is never logged out', async () => {
    const { sessionToken } = await signupAndVerify('a@example.test', 'student');
    const before = await harness.postgres.client.query<{ expires_at: Date }>(
      'select expires_at from sessions',
    );

    harness.clock.advanceDays(2);
    await service.validateSession(sessionToken);

    const after = await harness.postgres.client.query<{ expires_at: Date }>(
      'select expires_at from sessions',
    );
    expect(after.rows[0]?.expires_at.getTime()).toBeGreaterThan(
      before.rows[0]?.expires_at.getTime() ?? 0,
    );
  });
});

describe('logout', () => {
  it('deletes the one session', async () => {
    const { sessionToken } = await signupAndVerify('a@example.test', 'student');
    await service.logout(sessionToken, CONTEXT);
    expect(await countRows('sessions')).toBe(0);
  });

  it('is idempotent and silent for an unknown token', async () => {
    await expect(service.logout('never-existed', CONTEXT)).resolves.toBeUndefined();
  });

  it('is silent for a missing token', async () => {
    await expect(service.logout(undefined, CONTEXT)).resolves.toBeUndefined();
  });

  it('leaves other sessions of the same user alone', async () => {
    const { sessionToken } = await signupAndVerify('a@example.test', 'student');
    await service.login({ email: 'a@example.test', password: GOOD_PASSWORD }, CONTEXT);

    await service.logout(sessionToken, CONTEXT);
    expect(await countRows('sessions')).toBe(1);
  });

  /**
   * D-220 — THE UNTHROTTLED ENDPOINT ON THE `auth` POOL.
   *
   * `POST /auth/logout` is unauthenticated on purpose and reached the database
   * on every call. It was the one endpoint that could empty the pool the whole
   * product's login path depends on, from one host, with no credentials.
   *
   * Re-applying the defect — deleting the `limiter.consume` line at the top of
   * `logout` — turns this red.
   */
  it('RATE LIMITS logout by IP', async () => {
    const context: RequestContext = { ipHash: 'logout-flood', userAgent: null };

    for (let attempt = 0; attempt < LOGOUT_RATE_LIMIT.limit; attempt += 1) {
      await expect(service.logout(undefined, context)).resolves.toBeUndefined();
    }

    await expect(service.logout(undefined, context)).rejects.toMatchObject({
      code: ERROR_CODES.RATE_LIMIT,
    });
  });

  it('keeps each source IP on its own logout budget', async () => {
    const flooding: RequestContext = { ipHash: 'logout-flood-a', userAgent: null };
    for (let attempt = 0; attempt < LOGOUT_RATE_LIMIT.limit + 1; attempt += 1) {
      await service.logout(undefined, flooding).catch(() => undefined);
    }

    await expect(
      service.logout(undefined, { ipHash: 'logout-flood-b', userAgent: null }),
    ).resolves.toBeUndefined();
  });
});

describe('logoutAll', () => {
  it('deletes every session for the user', async () => {
    const { userId } = await signupAndVerify('a@example.test', 'student');
    await service.login({ email: 'a@example.test', password: GOOD_PASSWORD }, CONTEXT);
    await service.login({ email: 'a@example.test', password: GOOD_PASSWORD }, OTHER_IP);

    const removed = await service.logoutAll({ userId, role: 'student', tenantId: TEST_TENANT_ID });

    expect(removed).toBe(3);
    expect(await countRows('sessions')).toBe(0);
  });

  it("leaves another user's sessions untouched", async () => {
    const first = await signupAndVerify('a@example.test', 'student');
    await signupAndVerify('b@example.test', 'student', OTHER_IP);

    await service.logoutAll({ userId: first.userId, role: 'student', tenantId: TEST_TENANT_ID });

    expect(await countRows('sessions')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §6.7 password reset
// ---------------------------------------------------------------------------

describe('requestPasswordReset', () => {
  it('creates a token and mails it for a real account', async () => {
    await signupAndVerify('a@example.test', 'student');
    harness.mail.sent.length = 0;

    await service.requestPasswordReset({ email: 'a@example.test' }, CONTEXT);

    expect(await countRows('password_reset_tokens')).toBe(1);
    expect(harness.mail.sent[0]?.template).toBe('password-reset');
  });

  it('RESOLVES WITHOUT ERROR for an address with no account', async () => {
    await expect(
      service.requestPasswordReset({ email: 'nobody@example.test' }, CONTEXT),
    ).resolves.toBeUndefined();
  });

  it('sends no mail and creates no token for an unknown address', async () => {
    await service.requestPasswordReset({ email: 'nobody@example.test' }, CONTEXT);
    expect(harness.mail.sent).toHaveLength(0);
    expect(await countRows('password_reset_tokens')).toBe(0);
  });

  it('expires the reset token one hour out', async () => {
    await signupAndVerify('a@example.test', 'student');
    await service.requestPasswordReset({ email: 'a@example.test' }, CONTEXT);

    const stored = await harness.postgres.client.query<{ expires_at: Date }>(
      'select expires_at from password_reset_tokens',
    );
    expect(stored.rows[0]?.expires_at.getTime()).toBe(
      harness.clock.now().getTime() + PASSWORD_RESET_TTL_MS,
    );
  });

  it('cannot be turned into a mail bomb aimed at one address', async () => {
    await signupAndVerify('a@example.test', 'student');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.requestPasswordReset(
        { email: 'a@example.test' },
        { ipHash: `ip-${attempt}`, userAgent: null },
      );
    }

    await expect(
      service.requestPasswordReset(
        { email: 'a@example.test' },
        { ipHash: 'ip-new', userAgent: null },
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.RATE_LIMIT });
  });
});

describe('resetPassword', () => {
  async function requestReset(email: string): Promise<string> {
    await service.requestPasswordReset({ email }, CONTEXT);
    const resetUrl = harness.mail.sent.at(-1)?.data.resetUrl ?? '';
    return new URL(resetUrl).searchParams.get('token') ?? '';
  }

  it('DELETES EVERY SESSION FOR THE USER', async () => {
    const { userId } = await signupAndVerify('a@example.test', 'student');
    await service.login({ email: 'a@example.test', password: GOOD_PASSWORD }, CONTEXT);
    await service.login({ email: 'a@example.test', password: GOOD_PASSWORD }, OTHER_IP);
    expect(await countRows('sessions')).toBe(3);

    const token = await requestReset('a@example.test');
    await service.resetPassword({ token, password: 'brand-new-passphrase-1' }, CONTEXT);

    // If the reset was triggered by a compromise, leaving old sessions alive
    // defeats the whole exercise — the attacker just keeps the one they have.
    expect(await countRows('sessions')).toBe(0);

    const stored = await harness.postgres.client.query<{ password_hash: string }>(
      'select password_hash from users where id = $1',
      [userId],
    );
    expect(stored.rows[0]?.password_hash).toBe('fake$brand-new-passphrase-1');
  });

  it("leaves another user's sessions alone", async () => {
    await signupAndVerify('a@example.test', 'student');
    await signupAndVerify('b@example.test', 'student', OTHER_IP);

    const token = await requestReset('a@example.test');
    await service.resetPassword({ token, password: 'brand-new-passphrase-1' }, CONTEXT);

    expect(await countRows('sessions')).toBe(1);
  });

  it('lets the new password log in and refuses the old one', async () => {
    await signupAndVerify('a@example.test', 'student');
    const token = await requestReset('a@example.test');
    await service.resetPassword({ token, password: 'brand-new-passphrase-1' }, CONTEXT);

    await expect(
      service.login({ email: 'a@example.test', password: 'brand-new-passphrase-1' }, OTHER_IP),
    ).resolves.toBeDefined();
    await expect(
      service.login({ email: 'a@example.test', password: GOOD_PASSWORD }, OTHER_IP),
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHENTICATED });
  });

  it('consumes the token — a replay fails', async () => {
    await signupAndVerify('a@example.test', 'student');
    const token = await requestReset('a@example.test');
    await service.resetPassword({ token, password: 'brand-new-passphrase-1' }, CONTEXT);

    await expect(
      service.resetPassword({ token, password: 'another-new-passphrase-2' }, CONTEXT),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION });
  });

  it('invalidates an EARLIER outstanding token as well', async () => {
    await signupAndVerify('a@example.test', 'student');
    const first = await requestReset('a@example.test');
    const second = await requestReset('a@example.test');

    await service.resetPassword({ token: second, password: 'brand-new-passphrase-1' }, CONTEXT);

    await expect(
      service.resetPassword({ token: first, password: 'yet-another-passphrase-3' }, CONTEXT),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects an expired token', async () => {
    await signupAndVerify('a@example.test', 'student');
    const token = await requestReset('a@example.test');

    harness.clock.advanceMs(PASSWORD_RESET_TTL_MS);

    await expect(
      service.resetPassword({ token, password: 'brand-new-passphrase-1' }, CONTEXT),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects an unknown token', async () => {
    await expect(
      service.resetPassword({ token: 'never-issued', password: 'brand-new-passphrase-1' }, CONTEXT),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION });
  });

  it('applies the strength rules to the new password', async () => {
    await signupAndVerify('a@example.test', 'student');
    const token = await requestReset('a@example.test');

    await expect(
      service.resetPassword({ token, password: 'password123' }, CONTEXT),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION });

    // And the token is still usable, because the weak attempt never reached
    // the transaction.
    await expect(
      service.resetPassword({ token, password: 'brand-new-passphrase-1' }, CONTEXT),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §6.8 parent-child linking
// ---------------------------------------------------------------------------

describe('parent-child linking', () => {
  async function pair(): Promise<{ student: string; parent: string }> {
    const student = await signupAndVerify('kid@example.test', 'student');
    const parent = await signupAndVerify('mum@example.test', 'parent', OTHER_IP);
    return { student: student.userId, parent: parent.userId };
  }

  /*
   * MIGRATION 0007 — the code no longer expires.
   *
   * A fifteen-minute countdown required the parent to be beside the child while
   * the code was generated, which is not how a code reaches a parent: it is read
   * out on a phone call or sent home on a slip. What bounds somebody who merely
   * LEARNS a code is the OTP to the parent's own mailbox, not a timer, and the
   * code is still single-use and still one-per-student.
   */
  it('issues a 6-character code that does not expire', async () => {
    const { student } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });

    expect(issued.code).toHaveLength(6);
    expect(issued.expiresAt).toBeNull();
  });

  it('keeps ONE ACTIVE CODE PER STUDENT — a new code kills the previous one', async () => {
    const { student, parent } = await pair();
    const first = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });

    await expect(
      service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, first.code),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION });
  });

  it('refuses to issue a code to a parent', async () => {
    const { parent } = await pair();
    await expect(
      service.generateLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('A LINK GRANTS NOTHING BEFORE APPROVAL', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);

    expect(link.status).toBe('pending');
    expect(await service.isLinkApproved(parent, student)).toBe(false);
    expect(await service.getLinkedChildren({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID })).toEqual([]);
    await expect(
      service.assertParentCanReadChild({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, student),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('grants access once THE STUDENT approves', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);

    const approved = await service.approveLink({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, link.id);

    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).not.toBeNull();
    expect(await service.isLinkApproved(parent, student)).toBe(true);
    await expect(
      service.assertParentCanReadChild({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, student),
    ).resolves.toBeUndefined();
  });

  it('lists the child once approved', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);
    await service.approveLink({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, link.id);

    const children = await service.getLinkedChildren({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID });
    expect(children).toHaveLength(1);
    expect(children[0]?.studentUserId).toBe(student);
  });

  it('refuses approval from anyone but the student on the link', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);

    // The parent cannot approve their own request — that is the entire point.
    await expect(
      service.approveLink({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, link.id),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });

    const other = await signupAndVerify('other@example.test', 'student', {
      ipHash: 'ip-c',
      userAgent: null,
    });
    await expect(
      service.approveLink({ userId: other.userId, role: 'student', tenantId: TEST_TENANT_ID }, link.id),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });

    expect(await service.isLinkApproved(parent, student)).toBe(false);
  });

  it('refuses a second approval of the same link', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);
    await service.approveLink({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, link.id);

    await expect(
      service.approveLink({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, link.id),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('REVOKE TAKES EFFECT IMMEDIATELY, from the parent side', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);
    await service.approveLink({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, link.id);

    await service.revokeLink({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, link.id);

    // No clock movement, no re-login: the very next read is denied, because
    // status is resolved at query time and never cached in the session.
    expect(await service.isLinkApproved(parent, student)).toBe(false);
    expect(await service.getLinkedChildren({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID })).toEqual([]);
    await expect(
      service.assertParentCanReadChild({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, student),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('REVOKE TAKES EFFECT IMMEDIATELY, from the student side', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);
    await service.approveLink({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, link.id);

    await service.revokeLink({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, link.id);

    expect(await service.isLinkApproved(parent, student)).toBe(false);
  });

  it('lets a pending link be revoked before it is ever approved', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);

    const revoked = await service.revokeLink({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, link.id);
    expect(revoked.status).toBe('revoked');

    await expect(
      service.approveLink({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, link.id),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('refuses revocation by an unrelated third party', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);
    const stranger = await signupAndVerify('stranger@example.test', 'parent', {
      ipHash: 'ip-d',
      userAgent: null,
    });

    await expect(
      service.revokeLink({ userId: stranger.userId, role: 'parent', tenantId: TEST_TENANT_ID }, link.id),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('refuses a second revocation', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);
    await service.revokeLink({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, link.id);

    await expect(
      service.revokeLink({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, link.id),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('lets a revoked pair link again, with a fresh approval', async () => {
    const { student, parent } = await pair();
    const first = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, first.code);
    await service.approveLink({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, link.id);
    await service.revokeLink({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, link.id);

    const second = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const relinked = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, second.code);

    expect(relinked.status).toBe('pending');
    expect(await service.isLinkApproved(parent, student)).toBe(false);
  });

  it('never re-opens an already-approved link when a code is submitted again', async () => {
    const { student, parent } = await pair();
    const first = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, first.code);
    await service.approveLink({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, link.id);

    const second = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const resubmitted = await service.submitLinkCode(
      { userId: parent, role: 'parent', tenantId: TEST_TENANT_ID },
      second.code,
    );

    expect(resubmitted.status).toBe('approved');
    expect(await service.isLinkApproved(parent, student)).toBe(true);
  });

  /*
   * ========================================================================
   * THE EXPIRY TESTS ARE GONE — migration 0007, and they were asserting a rule
   * the product deliberately dropped rather than a rule it broke.
   *
   * A fifteen-minute code required the parent to be standing beside the child
   * while it was generated. That is not how a code reaches a parent: it is read
   * out on a phone call, or sent home on a slip. What now bounds somebody who
   * merely LEARNS a code is the OTP to the parent's own mailbox — see
   * `link-otp.test.ts` and the guardian-linking block in the route tests, which
   * between them cover the attempt cap, the lock, the resend, and the fact that
   * a resend cannot reset the counter.
   *
   * The code is still SINGLE USE and still ONE PER STUDENT, and both properties
   * keep their own tests below. The repository still honours a non-null expiry,
   * asserted in `tests/integration/link-code-repository.test.ts`, so the column
   * has not become decorative.
   * ========================================================================
   */

  it('issues a code that does not expire, however long the clock runs', async () => {
    const { student } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });

    expect(issued.expiresAt).toBeNull();

    // A week later it is still the student's active code, not a stale row the
    // screen would replace on every render.
    harness.clock.advanceMs(7 * 24 * 60 * 60 * 1000);
    const active = await service.getActiveLinkCode({
      userId: student,
      role: 'student',
      tenantId: TEST_TENANT_ID,
    });

    expect(active?.code).toBe(issued.code);
  });

  it('consumes the code on submission', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);

    const otherParent = await signupAndVerify('dad@example.test', 'parent', {
      ipHash: 'ip-e',
      userAgent: null,
    });
    await expect(
      service.submitLinkCode({ userId: otherParent.userId, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION });
  });

  it('accepts a code typed with spaces and in lower case', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const decorated = `${issued.code.slice(0, 3).toLowerCase()} ${issued.code.slice(3).toLowerCase()}`;

    await expect(
      service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, decorated),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('rejects a malformed code with the same error as an unknown one', async () => {
    const { parent } = await pair();
    const malformed: unknown = await service
      .submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, 'OOOOOO')
      .catch((error: unknown) => error);
    const unknown: unknown = await service
      .submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, '2F7K9H')
      .catch((error: unknown) => error);

    expect(isAppError(malformed) ? malformed.safeMessage : 'x').toBe(
      isAppError(unknown) ? unknown.safeMessage : 'y',
    );
  });

  it('refuses to let a student submit a code', async () => {
    const { student } = await pair();
    await expect(
      service.submitLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, '2F7K9H'),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('refuses to let a parent list children as a student', async () => {
    const { student } = await pair();
    await expect(
      service.getLinkedChildren({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it('lets a student reach their own data', async () => {
    const { student } = await pair();
    await expect(
      service.assertParentCanReadChild({ userId: student, role: 'student', tenantId: TEST_TENANT_ID }, student),
    ).resolves.toBeUndefined();
  });

  it('denies a student reaching another student', async () => {
    const { student } = await pair();
    const other = await signupAndVerify('peer@example.test', 'student', {
      ipHash: 'ip-f',
      userAgent: null,
    });
    await expect(
      service.assertParentCanReadChild({ userId: other.userId, role: 'student', tenantId: TEST_TENANT_ID }, student),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });
});

// ---------------------------------------------------------------------------
// LINK CODES ARE DURABLE ROWS — resolves D-012.
//
// They used to live in `platform/cache` under a 15-minute expiring key. A cache
// restart silently invalidated every outstanding code, so a parent entering a
// code their child had just read aloud was told it was invalid: intermittent,
// unreproducible, and in the middle of the onboarding funnel. These tests are
// the reason the change exists, and the first one is the regression itself.
// ---------------------------------------------------------------------------

describe('link codes live in the database', () => {
  async function pair(): Promise<{ student: string; parent: string }> {
    const student = await signupAndVerify('kid@example.test', 'student');
    const parent = await signupAndVerify('mum@example.test', 'parent', OTHER_IP);
    return { student: student.userId, parent: parent.userId };
  }

  async function activeCodeRows(studentUserId: string): Promise<number> {
    const result = await harness.postgres.client.query<{ count: string }>(
      'select count(*)::text as count from link_codes where student_user_id = $1 and consumed_at is null',
      [studentUserId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  it('A SIMULATED CACHE RESTART DOES NOT INVALIDATE AN OUTSTANDING CODE', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });

    // The cache goes away and comes back empty — a container restart, a
    // failover, an eviction under memory pressure. Any of them used to end this
    // family's onboarding with "that code is invalid".
    await harness.cache.close();
    expect(harness.cache.size).toBe(0);

    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);
    expect(link.status).toBe('pending');
  });

  it('writes the code as a row, not a cache entry', async () => {
    const { student } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });

    const stored = await harness.postgres.client.query<{ code: string; expires_at: Date }>(
      'select code, expires_at from link_codes where student_user_id = $1',
      [student],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.code).toBe(issued.code);
    // NULL rather than a timestamp — migration 0007. The point of this test is
    // that the code is a ROW, and it still is.
    expect(stored.rows[0]?.expires_at).toBeNull();
  });

  it('ISSUING TWICE leaves exactly one active row under the partial unique index', async () => {
    const { student } = await pair();
    const first = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const second = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });

    expect(second.code).not.toBe(first.code);
    expect(await activeCodeRows(student)).toBe(1);

    // The retired row is CONSUMED, never deleted: it is the audit record of a
    // code that was issued, and the partial index ignores it once it is spent.
    const total = await harness.postgres.client.query<{ count: string }>(
      'select count(*)::text as count from link_codes where student_user_id = $1',
      [student],
    );
    expect(Number(total.rows[0]?.count)).toBe(2);
  });

  it('issuing twice REPLACES: the new code works and the old one does not', async () => {
    const { student, parent } = await pair();
    const first = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    const second = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });

    await expect(
      service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, first.code),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION });

    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, second.code);
    expect(link.status).toBe('pending');
  });


  it('accepts the same code one millisecond before it expires', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });

    harness.clock.advanceMs(LINK_CODE_TTL_MS - 1);

    const link = await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);
    expect(link.status).toBe('pending');
  });

  it('A CONSUMED CODE CANNOT BE REUSED', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);

    const second = await signupAndVerify('dad@example.test', 'parent', {
      ipHash: 'ip-dad',
      userAgent: null,
    });

    await expect(
      service.submitLinkCode({ userId: second.userId, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION });
  });

  it('TWO PARENTS RACING ON ONE CODE — exactly one wins', async () => {
    const { student, parent } = await pair();
    const second = await signupAndVerify('dad2@example.test', 'parent', {
      ipHash: 'ip-dad2',
      userAgent: null,
    });
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });

    const results = await Promise.allSettled([
      service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code),
      service.submitLinkCode({ userId: second.userId, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code),
    ]);

    // `FOR UPDATE` inside the consume transaction serialises them: the loser
    // finds `consumed_at` already set and gets the same message as any other
    // bad code. Without the lock both would read "unconsumed", and a child who
    // meant to link one parent would have linked two.
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const links = await harness.postgres.client.query<{ count: string }>(
      'select count(*)::text as count from parent_child_links where student_user_id = $1',
      [student],
    );
    expect(Number(links.rows[0]?.count)).toBe(1);
  });

  it('marks the code consumed the moment it is redeemed', async () => {
    const { student, parent } = await pair();
    const issued = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);

    expect(await activeCodeRows(student)).toBe(0);
  });

  it('lets the student issue a fresh code for a second parent', async () => {
    const { student, parent } = await pair();
    const first = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });
    await service.submitLinkCode({ userId: parent, role: 'parent', tenantId: TEST_TENANT_ID }, first.code);

    const second = await signupAndVerify('dad3@example.test', 'parent', {
      ipHash: 'ip-dad3',
      userAgent: null,
    });
    const fresh = await service.generateLinkCode({ userId: student, role: 'student', tenantId: TEST_TENANT_ID });

    const link = await service.submitLinkCode({ userId: second.userId, role: 'parent', tenantId: TEST_TENANT_ID }, fresh.code);
    expect(link.status).toBe('pending');
  });
});

describe('getActiveLinkCode', () => {
  async function newStudent(): Promise<string> {
    const created = await signupAndVerify('kid@example.test', 'student');
    return created.userId;
  }

  it('returns the outstanding code, so a screen can show it again', async () => {
    const userId = await newStudent();
    const issued = await service.generateLinkCode({ userId, role: 'student', tenantId: TEST_TENANT_ID });

    const active = await service.getActiveLinkCode({ userId, role: 'student', tenantId: TEST_TENANT_ID });

    expect(active?.code).toBe(issued.code);
    expect(active?.expiresAt).toBeNull();
  });

  it('returns null when no code has been issued', async () => {
    const userId = await newStudent();
    expect(await service.getActiveLinkCode({ userId, role: 'student', tenantId: TEST_TENANT_ID })).toBeNull();
  });

  /*
   * MIGRATION 0007 — a code does not expire, so the only way it stops being
   * active is being SPENT (the test below). This one asserts the other half:
   * time passing does not retire it.
   *
   * The null-expiry branch of the query matters here. `expires_at > now` is NULL
   * for a persistent row, which is not true — so without an explicit null check
   * the student's own screen could not see their own code and would mint a
   * replacement on every render.
   */
  it('keeps returning the code however long the clock runs', async () => {
    const userId = await newStudent();
    const issued = await service.generateLinkCode({ userId, role: 'student', tenantId: TEST_TENANT_ID });

    harness.clock.advanceMs(30 * 24 * 60 * 60 * 1000);

    const active = await service.getActiveLinkCode({ userId, role: 'student', tenantId: TEST_TENANT_ID });
    expect(active?.code).toBe(issued.code);
  });

  it('returns null once the code has been redeemed', async () => {
    const userId = await newStudent();
    const parent = await signupAndVerify('mum2@example.test', 'parent', OTHER_IP);
    const issued = await service.generateLinkCode({ userId, role: 'student', tenantId: TEST_TENANT_ID });
    await service.submitLinkCode({ userId: parent.userId, role: 'parent', tenantId: TEST_TENANT_ID }, issued.code);

    expect(await service.getActiveLinkCode({ userId, role: 'student', tenantId: TEST_TENANT_ID })).toBeNull();
  });

  it('refuses a parent', async () => {
    const parent = await signupAndVerify('mum3@example.test', 'parent', OTHER_IP);
    await expect(
      service.getActiveLinkCode({ userId: parent.userId, role: 'parent', tenantId: TEST_TENANT_ID }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });
});

// ---------------------------------------------------------------------------
// THE RATE-LIMIT COUNTS, DRIVEN BY LITERALS — D-292.
//
// Every rate-limit test above this line loops `attempt < SOME_RATE_LIMIT.limit`
// and then asserts the next attempt is refused. That asserts the limiter is
// internally consistent and NOTHING about the number: an auditor changed SIGNUP
// 3 -> 300, LOGOUT 30 -> 3000 and TOKEN_ENDPOINT 10 -> 1000, and all 2,530 tests
// passed, because the loops simply ran 300 times and still watched the next one
// get refused.
//
// The tests below count in HARDCODED LITERALS. They read like the policy —
// "three signups an hour, the fourth is refused" — and they go red the moment
// the policy changes without the test changing with it. That is the property the
// existing loops cannot have, and it is why `SIGNUP_RATE_LIMIT` and friends are
// deliberately NOT referenced anywhere in this block.
//
// `identity.rate-limit-policy.test.ts` pins the same numbers as a table. Two
// independent kinds of test, so an inflation has to defeat both.
// ---------------------------------------------------------------------------

describe('THE RATE-LIMIT COUNTS, NAMED — D-292', () => {
  it('SIGNUP: allows THREE from one IP in an hour and REJECTS THE FOURTH', async () => {
    const context: RequestContext = { ipHash: 'signup-literal', userAgent: null };

    // Three. Not `SIGNUP_RATE_LIMIT.limit` — the whole point is that this test
    // knows the number and the implementation does not get to tell it.
    await service.signup(
      { email: 'lit-1@example.test', password: GOOD_PASSWORD, role: 'student' },
      context,
    );
    await service.signup(
      { email: 'lit-2@example.test', password: GOOD_PASSWORD, role: 'student' },
      context,
    );
    await service.signup(
      { email: 'lit-3@example.test', password: GOOD_PASSWORD, role: 'student' },
      context,
    );

    // At 300/hour this resolves, three accounts are farmed instead of stopped,
    // and three more verification emails leave the building.
    await expect(
      service.signup(
        { email: 'lit-4@example.test', password: GOOD_PASSWORD, role: 'student' },
        context,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.RATE_LIMIT });

    expect(await countRows('users')).toBe(3);
  });

  it('LOGOUT: allows THIRTY from one IP in an hour and REJECTS THE THIRTY-FIRST', async () => {
    // D-220 — logout is unauthenticated by design and reaches the `auth` pool,
    // the one §3.1's bulkhead keeps free so that login always has a connection.
    // 30 is a flood bound; 3000 is not a bound.
    const context: RequestContext = { ipHash: 'logout-literal', userAgent: null };

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      await expect(service.logout(undefined, context)).resolves.toBeUndefined();
    }

    await expect(service.logout(undefined, context)).rejects.toMatchObject({
      code: ERROR_CODES.RATE_LIMIT,
    });
  });

  it('TOKEN ENDPOINTS: allow TEN from one IP in an hour and REJECT THE ELEVENTH', async () => {
    // `TOKEN_ENDPOINT_RATE_LIMIT` had NO test at all. It guards every endpoint
    // that redeems or re-mails a credential: verify, reset-password, and the
    // resend added by D-291.
    const context: RequestContext = { ipHash: 'token-literal', userAgent: null };

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await expect(service.verifyEmail('not-a-real-token', context)).rejects.toMatchObject({
        // The token is refused, not the request — this attempt was ADMITTED by
        // the limiter and spent one of the ten.
        code: ERROR_CODES.VALIDATION,
      });
    }

    await expect(service.verifyEmail('not-a-real-token', context)).rejects.toMatchObject({
      code: ERROR_CODES.RATE_LIMIT,
    });
  });

  it('TOKEN ENDPOINTS: verify, reset and resend all spend the SAME ten', async () => {
    /**
     * One budget across the three, which is what makes the number meaningful:
     * three separate ten-per-hour counters would be thirty attempts an hour at
     * redeeming or re-mailing a credential from one host.
     */
    const context: RequestContext = { ipHash: 'token-shared-literal', userAgent: null };

    await service.verifyEmail('not-a-real-token', context).catch(() => undefined);
    await service
      .resetPassword({ token: 'not-a-real-token', password: GOOD_PASSWORD }, context)
      .catch(() => undefined);
    await service.resendVerification({ email: 'nobody@example.test' }, context);

    // Seven of the ten are left; the eighth past them is the eleventh overall.
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      await service.verifyEmail('not-a-real-token', context).catch(() => undefined);
    }

    await expect(service.verifyEmail('not-a-real-token', context)).rejects.toMatchObject({
      code: ERROR_CODES.RATE_LIMIT,
    });
  });

  it('RESEND-VERIFICATION: allows TEN for one address in an hour and REJECTS THE ELEVENTH', async () => {
    // The EMAIL-keyed counter (D-291), which is the mail-bomb bound: without it
    // an attacker with eleven hosts mails one victim eleven times.
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await service.resendVerification(
        { email: 'victim@example.test' },
        { ipHash: `resend-rotating-${attempt}`, userAgent: null },
      );
    }

    await expect(
      service.resendVerification(
        { email: 'victim@example.test' },
        { ipHash: 'resend-rotating-fresh', userAgent: null },
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.RATE_LIMIT });
  });
});
