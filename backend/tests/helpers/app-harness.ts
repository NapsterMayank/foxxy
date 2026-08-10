import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createPostgresAudit, type AuditPort } from '@/platform/audit/index';
import { MemoryCache } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { parseConfig } from '@/platform/config/load-config';
import { CounterIdGen } from '@/platform/id-gen/index';
import { FakeLogger } from '@/platform/logger/index';
import { RecordingMail } from '@/platform/mail/index';
import { createContainer, type Container } from '../../src/app/container';
import { createServer } from '../../src/app/server';
import { createContentModule, type ContentModule } from '../../src/modules/content/index';
import { createIdentityModule, type IdentityModule } from '../../src/modules/identity/index';
import { createLearnerModule, type LearnerModule } from '../../src/modules/learner/index';
import {
  createNotifyModule,
  type DigestSource,
  type NotifyModule,
} from '../../src/modules/notify/index';
import {
  FakeHasher,
  OTHER_TENANT_ID,
  TEST_COOKIE_NAME,
  TEST_TENANT_ID,
  createSecondTenant,
  sessionCookieFrom,
} from '../../src/modules/identity/__tests__/harness';
import { applyAllMigrations, startTestPostgres, type TestPostgres } from './postgres';

/**
 * The service-test harness for `learner` and `content`.
 *
 * A REAL Postgres, in a container (§9.1) — the database is never faked, because
 * a fake hides exactly what is worth finding here: the CHECK that refuses a
 * grade of '13', the `ON CONFLICT DO NOTHING` that makes onboarding idempotent,
 * and whether an index-backed filter really excludes the held-out reserve.
 * Everything else is faked: clock, cache, mailer, id generator, password hasher.
 *
 * WHY THIS IS SHARED RATHER THAN ONE HARNESS PER MODULE, unlike identity's.
 * Both modules need a real, logged-in session, and a session is identity's to
 * issue. Two copies of "sign up, verify, log in, keep the cookie" would be two
 * places to update the day the auth flow changes — and the copy belonging to
 * whichever module was not being worked on is the one that silently rots. It
 * builds all three modules because that is also what production builds, so a
 * wiring mistake in `app/routes.ts` shows up here rather than at boot.
 */

export interface AppHarness {
  readonly postgres: TestPostgres;
  readonly container: Container;
  readonly app: FastifyInstance;
  readonly identity: IdentityModule;
  readonly learner: LearnerModule;
  readonly content: ContentModule;
  readonly notify: NotifyModule;
  readonly clock: FixedClock;
  readonly cache: MemoryCache;
  readonly mail: RecordingMail;
  readonly logger: FakeLogger;
  /** Empties every table these modules touch. Call between tests. */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Truncated between tests, children before parents.
 *
 * `question_responses` is listed even though no test here writes to it: its
 * question foreign key is ON DELETE RESTRICT, so a stray row would make
 * truncating `questions` fail with an error that reads like a bug in the
 * harness rather than like the deliberate protection it is (D-043).
 */
const TABLES = [
  // `tenants` is NOT truncated: migration 0004 seeds the default tenant and
  // every `tenant_id` column references it with ON DELETE RESTRICT, so emptying
  // it between tests would make the next insert fail on a foreign key. A second
  // tenant added by `createSecondTenant` is idempotent for the same reason.
  // TRUNCATE, and it has to be. `audit_log` refuses DELETE by trigger
  // (migration 0005), so truncation is the only legal way to clear it — which
  // is exactly why TRUNCATE was deliberately left unblocked: it needs table
  // ownership, so it is a DBA operation in production and available here.
  'audit_log',
  'notifications',
  // The queue. `notify.send` enqueues a delivery job, and `(kind,
  // idempotency_key)` is UNIQUE — so a row left behind by one test makes the
  // next test's enqueue report `created: false` and look like a duplicate,
  // which is exactly the property several of these tests assert on.
  'jobs',
  'question_responses',
  'chapter_mastery',
  'student_subjects',
  'students',
  'rag_chunks',
  'questions',
  'chapters',
  'sessions',
  'email_verification_tokens',
  'password_reset_tokens',
  'parent_child_links',
  'link_codes',
  'users',
] as const;

export const HARNESS_ORIGIN = 'http://app.test';
export const HARNESS_START = '2026-06-01T09:00:00.000Z';
export { TEST_COOKIE_NAME, TEST_TENANT_ID, OTHER_TENANT_ID, createSecondTenant, sessionCookieFrom };

export interface AppHarnessOptions {
  /**
   * The weekly-digest content seam (§8.7).
   *
   * Supplied by the digest tests and by nothing else, which mirrors production:
   * with no source the digest handlers are not registered and the weekly scan
   * is not scheduled. A harness that always wired a fake would hide the fact
   * that the default posture is "absent and loud".
   */
  readonly digest?: DigestSource;
}

export async function startAppHarness(options: AppHarnessOptions = {}): Promise<AppHarness> {
  const postgres = await startTestPostgres();
  // Every migration, discovered from the directory — never a list written out
  // here. A harness that names its migrations is a harness that runs a whole
  // suite against a schema missing a table, and stays green (D-046).
  await applyAllMigrations(postgres.client);

  const clock = new FixedClock(HARNESS_START);
  const cache = new MemoryCache(clock);
  const mail = new RecordingMail();
  const logger = new FakeLogger();

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

  /**
   * A REAL audit port, not a recording fake.
   *
   * The four privileged actions this harness exercises — password reset,
   * logout-all, link approve, link revoke — are the only writers `audit_log`
   * has, and the properties worth testing (the append-only trigger, the jsonb
   * object CHECK, the scrub landing before the INSERT) are properties of the
   * DATABASE. A fake would let all four tests pass against a table that does
   * not exist.
   */
  const audit: AuditPort = createPostgresAudit({
    db: container.poolFor('identity'),
    clock,
    logger,
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
    // Argon2 at the OWASP parameters costs tens of milliseconds by design, and
    // these suites create a dozen accounts each. The real hasher is exercised
    // where it is the thing under test, in the identity suite.
    hasher: new FakeHasher(),
  });

  const learner = createLearnerModule({
    db: container.poolFor('learner'),
    clock,
    logger,
    requireSession: identity.requireSession,
    // The SAME wiring as `app/routes.ts`: `isLinkApproved` collapsed to
    // `'approved' | null`, because that is the only distinction the authz
    // boundary is allowed to make (telling pending from revoked from absent
    // would reveal whether a student account exists).
    readLinkStatus: async (parentUserId, studentUserId) =>
      (await identity.service.isLinkApproved(parentUserId, studentUserId)) ? 'approved' : null,
    // The SAME wiring as `app/routes.ts`: the resource side of the tenant
    // comparison, read from `users` through identity rather than from a copy.
    readTenantOfStudent: (studentUserId) => identity.service.getTenantOfUser(studentUserId),
  });

  const content = createContentModule({
    db: container.poolFor('content'),
    logger,
    requireSession: identity.requireSession,
  });

  const notify = createNotifyModule({
    db: container.poolFor('notify'),
    clock,
    logger,
    metrics: container.metrics,
    cache,
    // The SAME wiring as `app/routes.ts`: the in-app adapter directly (it is
    // the durable record, written in the request) and the dispatcher for the
    // remote fan-out.
    inAppChannel: container.channels['in-app'],
    dispatcher: container.notify,
    queue: container.jobQueue,
    requireSession: identity.requireSession,
    readRecipient: (userId) => identity.service.getNotificationRecipient(userId),
    ...(options.digest === undefined ? {} : { digest: options.digest }),
  });

  const app = await createServer(container, { modules: { identity, learner, content, notify } });
  await app.ready();

  return {
    postgres,
    container,
    app,
    identity,
    learner,
    content,
    notify,
    clock,
    cache,
    mail,
    logger,
    async reset(): Promise<void> {
      await postgres.client.query(`truncate table ${TABLES.join(', ')} restart identity cascade`);
      await cache.close();
      mail.sent.length = 0;
      logger.lines.length = 0;
      clock.setTo(HARNESS_START);
    },
    async stop(): Promise<void> {
      await app.close();
      await container.shutdown();
      await postgres.stop();
    },
  };
}

const HARNESS_PASSWORD = 'vermillion-otter-49';

export interface HarnessAccount {
  readonly userId: string;
  readonly cookie: string;
}

/**
 * signup -> verify -> login, returning a live session and the user id.
 *
 * Through the real HTTP surface rather than by inserting a `users` row and
 * forging a session. A forged session is a session the auth code has never
 * seen, so a test built on one proves nothing about whether these endpoints
 * are actually reachable by a real logged-in user.
 */
export async function onboardAccount(
  harness: AppHarness,
  email: string,
  role: 'student' | 'parent',
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
  await harness.app.inject({
    method: 'GET',
    url: `/api/v1/auth/verify?token=${encodeURIComponent(token)}`,
  });

  const login = await post('/api/v1/auth/login', { email, password: HARNESS_PASSWORD });
  const cookie = sessionCookieFrom(login.headers['set-cookie']);
  if (cookie === null) throw new Error(`onboardAccount: no session cookie for ${email}`);

  const actor = await harness.identity.service.validateSession(cookie);
  return { userId: actor.userId, cookie };
}
