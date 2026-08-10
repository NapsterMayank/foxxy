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
import { createParentModule, type ParentModule } from '../../src/modules/parent/index';
import { createPracticeModule, type PracticeModule } from '../../src/modules/practice/index';
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
  readonly practice: PracticeModule;
  readonly parent: ParentModule;
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
 * `practice_responses` (renamed from `question_responses` by migration 0002,
 * D-057) is listed because its question foreign key is ON DELETE RESTRICT, so a
 * stray row would make truncating `questions` fail with an error that reads
 * like a bug in the harness rather than like the deliberate protection it is
 * (D-043). `practice_sessions` sits above it for the same reason against
 * `chapters`, and `practice_retention` likewise.
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
  // `weekly_digests` is the ONE table `parent` writes. It carries a unique
  // constraint on (parent, child, week) — which is what makes digest generation
  // idempotent — so a row surviving into the next test would make a fresh
  // generation report `created: false` and look like the idempotence it is
  // meant to be proving.
  'weekly_digests',
  // The queue. `notify.send` enqueues a delivery job, and `(kind,
  // idempotency_key)` is UNIQUE — so a row left behind by one test makes the
  // next test's enqueue report `created: false` and look like a duplicate,
  // which is exactly the property several of these tests assert on.
  'jobs',
  'practice_responses',
  'xp_ledger',
  'practice_retention',
  'practice_sessions',
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

/**
 * A deterministic replacement for `Math.random` in the option shuffle.
 *
 * The default `() => 0.5` is NOT arbitrary: with four options it produces a map
 * that genuinely reorders, so every test that goes through a session is
 * exercising the D-058 translation rather than the identity permutation. A
 * fixed 0 or a real `Math.random` would each leave the reordering case
 * untested — one because it never moves anything interesting, the other because
 * it is not reproducible.
 */
export type HarnessRandom = () => number;

export interface AppHarnessOptions {
  /** Overrides the shuffle randomness. See `HarnessRandom`. */
  readonly random?: HarnessRandom;
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

  const practice = createPracticeModule({
    db: container.poolFor('practice'),
    clock,
    logger,
    requireSession: identity.requireSession,
    // The SAME wiring as `app/routes.ts`, and the same omission: only
    // `getQuestionsForChapter` is passed, so no test can accidentally prove
    // that practice serves the held-out reserve by handing it the function that
    // would.
    readQuestions: (actor, query) => content.service.getQuestionsForChapter(actor, query),
    readChapter: async (actor, chapterId) => {
      try {
        return await content.service.getChapter(actor, chapterId);
      } catch {
        return null;
      }
    },
    listChapters: (actor, filter) =>
      content.service.listChapters(actor, {
        grade: filter.grade,
        subject: filter.subjectCode,
        limit: filter.limit,
      }),
    readStudentContext: async (actor, studentUserId) => {
      const [profile, subjects] = await Promise.all([
        learner.service.getProfile(actor, studentUserId),
        learner.service.getSubjects(actor, studentUserId),
      ]);
      return { grade: profile.grade, subjects };
    },
    readMastery: (actor, studentUserId) => learner.service.getMastery(actor, studentUserId),
    writeMastery: (actor, input) => learner.service.updateMastery(actor, input),
    readTenantOfStudent: (studentUserId) => identity.service.getTenantOfUser(studentUserId),
    random: options.random ?? ((): number => 0.5),
  });

  /**
   * THE SAME WIRING AS `app/routes.ts`, and it has to be the same.
   *
   * `parent` is the only cross-user data path in the product, and every one of
   * its five edges is an injected function — so a test that built it with
   * convenient stand-ins would be testing a module that production never
   * assembles. In particular `readTenantOfStudent` reads `users.tenant_id`
   * through identity rather than echoing `actor.tenantId`, which is the D-091
   * mistake and the one `parent.authz-mutation.test.ts` installs deliberately.
   */
  const parent = createParentModule({
    db: container.poolFor('parent'),
    clock,
    logger,
    requireSession: identity.requireSession,
    readLinkStatus: async (parentUserId, studentUserId) =>
      (await identity.service.isLinkApproved(parentUserId, studentUserId)) ? 'approved' : null,
    readTenantOfStudent: (studentUserId) => identity.service.getTenantOfUser(studentUserId),
    listLinkedChildren: (actor) => identity.service.getLinkedChildren(actor),
    readChildProfile: async (actor, studentUserId) => {
      const profile = await learner.service.getProfile(actor, studentUserId);
      return {
        displayName: profile.displayName,
        grade: profile.grade,
        preferredLanguage: profile.preferredLanguage,
      };
    },
    revokeLink: async (actor, linkId) => {
      await identity.service.revokeLink(actor, linkId);
    },
    // The REAL Postgres audit port, same object identity gets. The transcript
    // read and the consent revocation both write `audit_log`, and the
    // properties worth asserting — that the row lands, and that it carries no
    // PII — are properties of the row in the database.
    audit,
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
    // `app/routes.ts` defaults this to `parent.digestSource`. The harness keeps
    // the override-or-absent shape so a digest test can observe what notify asks
    // for without building a real digest — see `AppHarnessOptions.digest`.
    ...(options.digest === undefined ? {} : { digest: options.digest }),
  });

  const app = await createServer(container, {
    modules: { identity, learner, content, practice, parent, notify },
  });
  await app.ready();

  return {
    postgres,
    container,
    app,
    identity,
    learner,
    content,
    practice,
    parent,
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
