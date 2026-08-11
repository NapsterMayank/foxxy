import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCache } from '../../platform/cache/index';
import { FixedClock } from '../../platform/clock/index';
import { parseConfig } from '../../platform/config/load-config';
import { CounterIdGen } from '../../platform/id-gen/index';
import { FakeLogger } from '../../platform/logger/index';
import { RecordingMail } from '../../platform/mail/index';
import { createContainer, type Container, type ContainerOverrides } from '../container';

/**
 * =============================================================================
 * WHAT `createContainer` REFUSES TO BOOT WITHOUT — D-226 and D-231.
 *
 * THE PATTERN. Three adapter choices in this file were already gated at boot —
 * `embed`, `llm` and `payments` — because each has a fake that is
 * interchangeable to the type system and produces a SILENT wrong answer in
 * production. Mail was the fourth and had no gate at all, and it was the worst
 * of them:
 *
 *   - `signup` wrote a verification token and printed its link to STDOUT.
 *   - `forgotPassword` did the same with a reset link.
 *   - `mail.send` resolved, so the breaker never opened and no probe changed.
 *
 * The entire acquisition funnel was dead and the system reported itself
 * perfectly healthy. `RESEND_API_KEY` was being passed by the deployment and
 * silently ignored, which is how it went unnoticed: the variable's PRESENCE was
 * the evidence people were reading.
 *
 * A console mailer in production is not a degraded mode. It is a total failure
 * of signup and password reset with no symptom.
 * =============================================================================
 */

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://foxxy:pw@127.0.0.1:1/foxxy',
  REDIS_URL: 'redis://localhost:6379',
  CORS_READ_ORIGINS: 'https://foxxy.app',
  CORS_WRITE_ORIGINS: 'https://foxxy.app',
  SESSION_COOKIE_NAME: 'foxxy_session',
  APP_URL: 'https://foxxy.app',
  API_URL: 'https://api.foxxy.app',
  // Deliberately NOT overriding any DATABASE_POOL_* variable: the arithmetic
  // asserted below is the SHIPPED default profile, and a test that tuned it
  // would be checking its own fixture rather than the deployment.
};

/** Everything a production boot needs EXCEPT mail. */
const PRODUCTION_ENV: Record<string, string> = {
  ...BASE_ENV,
  NODE_ENV: 'production',
  VOYAGE_API_KEY: 'voy-test',
  LLM_API_KEY: 'llm-test',
  RAZORPAY_KEY_ID: 'rzp_test_id',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: 'rzp_test_webhook',
  SESSION_SECRET: 'a'.repeat(64),
  IP_HASH_SALT: 'b'.repeat(32),
};

const SMTP_ENV: Record<string, string> = {
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: '587',
  SMTP_USER: 'no-reply@foxxy.app',
  SMTP_PASSWORD: 'app-password',
  SMTP_FROM: 'Foxxy <no-reply@foxxy.app>',
};

const built: Container[] = [];

afterEach(async () => {
  await Promise.allSettled(built.splice(0).map((container) => container.shutdown()));
});

function boot(env: Record<string, string>, overrides: ContainerOverrides = {}): Container {
  const clock = new FixedClock('2026-08-09T09:00:00.000Z');
  const container = createContainer(parseConfig(env), {
    clock,
    idGen: new CounterIdGen(),
    logger: new FakeLogger(),
    cache: new MemoryCache(clock),
    ...overrides,
  });
  built.push(container);
  return container;
}

describe('production refuses to boot without SMTP — D-226', () => {
  it.each([
    ['SMTP_HOST', 'SMTP_HOST'],
    ['SMTP_USER', 'SMTP_USER'],
    ['SMTP_PASSWORD', 'SMTP_PASSWORD'],
    ['SMTP_FROM', 'SMTP_FROM'],
  ])('throws, naming %s, when it is missing', (variable, expected) => {
    // Named individually because "I set the credentials" and "I set the visible
    // From address" are different states — Google Workspace allows sending as
    // an alias, so `SMTP_FROM` is genuinely separate from `SMTP_USER` and a
    // generic "SMTP is not configured" would not say which one this is.
    // Rebuilt without the one variable rather than deleted from a copy: a
    // dynamic delete is banned here, and filtering states the intent better
    // anyway — "boot with everything except this".
    const env = Object.fromEntries(
      Object.entries({ ...PRODUCTION_ENV, ...SMTP_ENV }).filter(([key]) => key !== variable),
    );

    expect(() => boot(env)).toThrow(new RegExp(`^${expected} is required in production`, 'u'));
  });

  it('says WHY, in terms of the failure that has no symptom', () => {
    // The gate exists because the degraded mode is invisible. An error that
    // said only "configuration missing" would be read as pedantry and worked
    // around with a default.
    expect(() => boot(PRODUCTION_ENV)).toThrow(/PRINTS verification and password-reset links/u);
  });

  it('boots when every SMTP setting is present', () => {
    expect(() => boot({ ...PRODUCTION_ENV, ...SMTP_ENV })).not.toThrow();
  });

  it('boots without SMTP outside production, so signup still works with no credentials', () => {
    // The console adapter remains the default OUTSIDE production, deliberately:
    // the signup flow has to be exercisable end to end with no credentials and
    // no external call. The GATE is what makes that safe rather than a hazard.
    expect(() => boot({ ...BASE_ENV, NODE_ENV: 'development' })).not.toThrow();
  });

  it('accepts an explicit mail override in production — a test is not a misconfiguration', () => {
    // "No credentials were set" and "this caller supplied its own adapter" are
    // different facts, and only one of them is a defect. Same reasoning as the
    // `embed`, `llm` and `payments` gates directly above it.
    expect(() => boot(PRODUCTION_ENV, { mail: new RecordingMail() })).not.toThrow();
  });
});

describe('production refuses to boot without the migration journal — D-231', () => {
  it('throws when the journal cannot be read', () => {
    // Without it, readiness silently falls back to the old, useless rule — "at
    // least one row in the migrations table" — which is exactly the check that
    // let a half-applied deploy report ready and take live traffic into a
    // schema missing four modules' tables. A fallback that is right in
    // development and wrong in production, with no way to tell which one you
    // are running, is the same defect wearing a different hat.
    expect(() =>
      boot({
        ...PRODUCTION_ENV,
        ...SMTP_ENV,
        DRIZZLE_MIGRATIONS_DIR: './drizzle/does-not-exist',
      }),
    ).toThrow(/migration journal could not be read/u);
  });

  it('boots against the journal this repository actually ships', () => {
    // The folder travels with the image (`COPY drizzle ./drizzle`) so the SQL
    // matches the code. Asserting against the REAL path means a move or a
    // rename fails here rather than in production.
    const container = boot({ ...PRODUCTION_ENV, ...SMTP_ENV });

    expect(container.databaseProbe.manifest.known).toBe(true);
    expect(container.databaseProbe.manifest.expected.length).toBeGreaterThan(0);
  });

  it('does NOT throw outside production, where a fallback is honest', () => {
    expect(() =>
      boot({
        ...BASE_ENV,
        NODE_ENV: 'test',
        DRIZZLE_MIGRATIONS_DIR: './drizzle/does-not-exist',
      }),
    ).not.toThrow();
  });
});

describe('the pools are sized for the process role — D-228', () => {
  it('an api process trims the worker pool it only enqueues onto', () => {
    const sizes = boot({ ...BASE_ENV, NODE_ENV: 'test' }).pools.stats();

    expect(sizes.find((pool) => pool.name === 'worker')?.max).toBe(2);
  });

  it('a worker process trims auth and core, which it barely touches', () => {
    const sizes = boot({ ...BASE_ENV, NODE_ENV: 'test' }, { role: 'worker' }).pools.stats();

    expect(sizes.find((pool) => pool.name === 'auth')?.max).toBe(2);
    expect(sizes.find((pool) => pool.name === 'core')?.max).toBe(4);
  });

  it('honours DATABASE_POOL_MAX, which was previously read by nothing', () => {
    // The variable existed, was validated, and no code consulted it. The only
    // budget in the codebase was a sentence in a comment, and that sentence was
    // counting one process out of two.
    const stats = boot({ ...BASE_ENV, NODE_ENV: 'test', DATABASE_POOL_MAX: '12' }).pools.stats();
    const total = stats.reduce((sum, pool) => sum + pool.max, 0);

    expect(total).toBeLessThanOrEqual(12);
  });

  it('keeps two processes inside a default max_connections of 100', () => {
    // THE ACTUAL DEFECT. Both entry points call `createContainer`, so the real
    // figure was 44 + 44 = 88 with a single replica of each, and a rolling api
    // deploy — which by construction runs two api processes at once — made it
    // 132. Crossing the server limit presents as every pool failing at the same
    // instant, plus a `psql` that cannot connect to find out why.
    const api = boot({ ...BASE_ENV, NODE_ENV: 'test' })
      .pools.stats()
      .reduce((sum, pool) => sum + pool.max, 0);
    const worker = boot({ ...BASE_ENV, NODE_ENV: 'test' }, { role: 'worker' })
      .pools.stats()
      .reduce((sum, pool) => sum + pool.max, 0);

    expect(api + worker).toBe(60);
    // Room for a rolling api deploy's overlap plus administrative access.
    expect(api * 2 + worker).toBeLessThanOrEqual(100);
  });
});
