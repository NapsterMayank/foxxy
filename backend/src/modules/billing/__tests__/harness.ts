import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { RecordingAudit } from '@/platform/audit/index';
import { MemoryCache } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { parseConfig } from '@/platform/config/load-config';
import { CounterIdGen } from '@/platform/id-gen/index';
import { FakeLogger } from '@/platform/logger/index';
import { RecordingMail } from '@/platform/mail/index';
import { createFakePayments, type FakePayments, type Payer } from '@/platform/payments/index';
import { createContainer, type Container } from '../../../app/container';
import { createServer } from '../../../app/server';
import { createIdentityModule, type IdentityModule } from '../../identity/index';
import {
  FakeHasher,
  OTHER_TENANT_ID,
  TEST_COOKIE_NAME,
  TEST_TENANT_ID,
  createSecondTenant,
  sessionCookieFrom,
} from '../../identity/__tests__/harness';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from '../../../../tests/helpers/postgres';
import { createBillingModule, type BillingModule } from '../index';

/**
 * ============================================================================
 * THE BILLING TEST HARNESS — LOCAL, and deliberately not the shared one.
 *
 * `tests/helpers/app-harness.ts` builds every module through the same wiring
 * `app/routes.ts` uses. This file constructs `billing` DIRECTLY instead, and
 * the reason has changed since it was written.
 *
 * IT USED TO BE A GAP. `billing` was built while `app/routes.ts` and
 * `app/container.ts` were owned by another change in flight, so the module was
 * absent from `Modules` and its composition-root wiring was reported rather
 * than committed — and nothing proved that production assembled it the way this
 * file does.
 *
 * THAT GAP IS CLOSED. `billing` is now constructed in `buildModules` on the
 * `core` pool and awaited in `registerRoutes`, and `src/app/__tests__/
 * routes.test.ts` pins both halves: that it is a member of `Modules`, and that
 * driving `registerRoutes` with billing alone produces `/api/v1/webhooks/
 * billing`. The container owns the payments port, chosen with a production boot
 * refusal, and `wiring.test.ts` pins that too.
 *
 * THIS HARNESS STAYS LOCAL FOR A DIFFERENT REASON: it needs the CONCRETE
 * `FakePayments`, not the `PaymentsPort` the container exposes, because half
 * these tests have to SIGN a delivery. A shared harness returning the port
 * would make "a forged signature is rejected" untestable — which is the one
 * assertion this file cannot do without.
 *
 * ============================================================================
 * THE PAYMENT PROVIDER IS THE DETERMINISTIC FAKE, AND IT VERIFIES SIGNATURES
 * FOR REAL.
 *
 * There is no Razorpay account. The fake shares `platform/payments/signature.ts`
 * with the Razorpay adapter — same HMAC, same timing-safe comparison — so
 * "a forged signature is rejected" is a claim about real cryptography here,
 * not about a stub that was told to say no.
 * ============================================================================
 */

const HARNESS_ORIGIN = 'http://app.test';
const HARNESS_START = '2026-08-10T09:00:00.000Z';
const WEBHOOK_SECRET = 'whsec_harness';
const HARNESS_PASSWORD = 'vermillion-otter-49';

export {
  HARNESS_ORIGIN,
  HARNESS_START,
  OTHER_TENANT_ID,
  TEST_COOKIE_NAME,
  TEST_TENANT_ID,
  WEBHOOK_SECRET,
  createSecondTenant,
};

/**
 * Truncated between tests, children before parents.
 *
 * `payment_events` first: its `subscription_id` foreign key is ON DELETE
 * RESTRICT (a financial record does not vanish because a row above it went), so
 * truncating `subscriptions` first fails with an error that reads like a bug in
 * the harness rather than like the deliberate protection it is.
 *
 * `subscriptions.subject_user_id` is RESTRICT for the same reason, which is why
 * both billing tables sit above `users` here.
 */
const TABLES = [
  'audit_log',
  'payment_events',
  'subscriptions',
  'sessions',
  'email_verification_tokens',
  'password_reset_tokens',
  'parent_child_links',
  'link_codes',
  'users',
] as const;

export interface BillingHarnessOptions {
  /**
   * WHO PAYS. Defaults to the B2C answer (the beneficiary pays for themselves).
   *
   * Overridable because the B2B school pilot is the case most likely to be
   * assumed away, and a harness that could only express "a user pays" would
   * quietly make the module's central design decision untestable.
   */
  readonly resolvePayer?: (subjectUserId: string) => Promise<Payer | null>;
}

export interface BillingHarness {
  readonly postgres: TestPostgres;
  readonly container: Container;
  readonly app: FastifyInstance;
  readonly identity: IdentityModule;
  readonly billing: BillingModule;
  readonly payments: FakePayments;
  readonly clock: FixedClock;
  readonly cache: MemoryCache;
  readonly mail: RecordingMail;
  readonly logger: FakeLogger;
  readonly audit: RecordingAudit;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startBillingHarness(
  options: BillingHarnessOptions = {},
): Promise<BillingHarness> {
  const postgres = await startTestPostgres();
  // Every migration, discovered from the directory — never a list written out
  // here. A harness that names its migrations runs a whole suite against a
  // schema missing a table and stays green (D-046, D-075).
  await applyAllMigrations(postgres.client);

  const clock = new FixedClock(HARNESS_START);
  const cache = new MemoryCache(clock);
  const mail = new RecordingMail();
  const logger = new FakeLogger();
  const audit = new RecordingAudit();

  const config = parseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: postgres.url,
    REDIS_URL: 'redis://localhost:6379',
    CORS_READ_ORIGINS: 'http://localhost:3000',
    CORS_WRITE_ORIGINS: 'http://localhost:3000',
    SESSION_COOKIE_NAME: TEST_COOKIE_NAME,
    APP_URL: HARNESS_ORIGIN,
    API_URL: 'http://api.test',
  });

  const container = createContainer(config, {
    clock,
    cache,
    mail,
    logger,
    idGen: new CounterIdGen(),
  });

  const identity = createIdentityModule({
    db: container.poolFor('identity'),
    cache,
    mail,
    clock,
    logger,
    audit,
    session: { name: TEST_COOKIE_NAME, ttlDays: config.session.ttlDays, secure: true },
    defaultTenantId: config.tenancy.defaultTenantId,
    urls: { apiBaseUrl: 'http://api.test', appBaseUrl: HARNESS_ORIGIN },
    hasher: new FakeHasher(),
  });

  const payments = createFakePayments({
    secret: WEBHOOK_SECRET,
    planCodes: ['monthly', 'yearly'],
  });

  const billing = createBillingModule({
    db: container.poolFor('billing'),
    clock,
    logger,
    requireSession: identity.requireSession,
    payments,
    /**
     * THE D-091 WIRING, identical to what `app/routes.ts` must carry.
     *
     * `users.tenant_id`, read through identity, for the SUBJECT — never
     * `actor.tenantId`. Echoing the actor's own tenant back as the resource
     * tenant makes `assertTenantMatch` compare a value with itself, which is
     * the defect `billing.authz-mutation.test.ts` installs deliberately.
     */
    readTenantOfUser: (userId) => identity.service.getTenantOfUser(userId),
    resolvePayer:
      options.resolvePayer === undefined
        ? // The B2C default: the beneficiary pays for themselves. This ONE LINE
          // is the whole B2C/B2B decision, which is why it lives at the
          // composition root and not inside the module.
          (subjectUserId): Promise<Payer | null> =>
            Promise.resolve({ kind: 'user', id: subjectUserId })
        : (subjectUserId): Promise<Payer | null> => {
            const resolve = options.resolvePayer;
            return resolve === undefined
              ? Promise.resolve(null)
              : resolve(subjectUserId);
          },
    audit,
  });

  // `billing` is not a member of `Modules`, so it cannot be passed to
  // `createServer` — it is registered directly, BEFORE `ready()`. Identity goes
  // through the normal path because its registration installs `@fastify/cookie`,
  // which every `requireSession` preHandler needs.
  const app = await createServer(container, { modules: { identity } });
  await billing.registerRoutes(app);
  await app.ready();

  return {
    postgres,
    container,
    app,
    identity,
    billing,
    payments,
    clock,
    cache,
    mail,
    logger,
    audit,
    async reset(): Promise<void> {
      await postgres.client.query(`truncate table ${TABLES.join(', ')} restart identity cascade`);
      await cache.close();
      mail.sent.length = 0;
      logger.lines.length = 0;
      audit.clear();
      payments.reset();
      clock.setTo(HARNESS_START);
    },
    async stop(): Promise<void> {
      await app.close();
      await container.shutdown();
      await postgres.stop();
    },
  };
}

export interface HarnessAccount {
  readonly userId: string;
  readonly cookie: string;
}

let emailCounter = 0;
export function nextEmail(prefix: string): string {
  emailCounter += 1;
  return `${prefix}${emailCounter}@example.test`;
}

/**
 * signup -> verify -> login, returning a live session and the user id.
 *
 * Through the real HTTP surface rather than by inserting a `users` row and
 * forging a session: a forged session is a session the auth code has never
 * seen, so a test built on one proves nothing about whether these endpoints are
 * reachable by a real logged-in user.
 */
export async function onboard(
  harness: BillingHarness,
  role: 'student' | 'parent' = 'parent',
  email = nextEmail('bill'),
): Promise<HarnessAccount> {
  const post = (url: string, payload: unknown): Promise<LightMyRequestResponse> =>
    harness.app.inject({
      method: 'POST',
      url,
      headers: { origin: HARNESS_ORIGIN },
      payload: payload as Record<string, unknown>,
    });

  await post('/api/v1/auth/signup', { email, password: HARNESS_PASSWORD, role });

  const verifyUrl = harness.mail.sent.at(-1)?.data.verifyUrl;
  const token =
    typeof verifyUrl === 'string' ? (new URL(verifyUrl).searchParams.get('token') ?? '') : '';
  await harness.app.inject({ method: 'GET', url: `/api/v1/auth/verify?token=${encodeURIComponent(token)}` });

  const login = await post('/api/v1/auth/login', { email, password: HARNESS_PASSWORD });
  const cookie = sessionCookieFrom(login.headers['set-cookie']);
  if (cookie === null) throw new Error(`onboard: no session cookie for ${email}`);

  // The id comes from validating the REAL cookie, the same way every
  // authenticated request does — not from a database read the auth code has
  // never been part of.
  const actor = await harness.identity.service.validateSession(cookie);

  // Clears the signup/login rate-limit counters. The CLOCK IS NOT WOUND
  // FORWARD: every entitlement assertion in this suite is about time, so a
  // harness that advanced it between accounts would move the thing under test.
  await harness.cache.close();

  return { userId: actor.userId, cookie };
}

/** Moves an account into the second tenant. Used by the cross-tenant tests. */
export async function moveToOtherTenant(
  harness: BillingHarness,
  userId: string,
): Promise<string> {
  const tenantId = await createSecondTenant(harness);
  await harness.postgres.client.query('update users set tenant_id = $1 where id = $2', [
    tenantId,
    userId,
  ]);
  return tenantId;
}
