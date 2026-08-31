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
import { createFakeLlm, type FakeLlm, type LlmProvider } from '@/platform/llm/index';
import { createAdminModule, type AdminModule } from '../../src/modules/admin/index';
import { createContentModule, type ContentModule } from '../../src/modules/content/index';
import { createFoxyModule, type ChunkSearch, type FoxyModule } from '../../src/modules/foxy/index';
import {
  CANDIDATE_LIMIT,
  createRetrievalModule,
  type AbstainThreshold,
  type RetrievalModule,
} from '../../src/modules/retrieval/index';
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
  readonly retrieval: RetrievalModule;
  readonly foxy: FoxyModule;
  readonly admin: AdminModule;
  /**
   * The scripted language model the harness wired.
   *
   * Exposed so a test can assert `recorder.callCount() === 0` — which is how
   * "abstention NEVER calls the model" is proved. That assertion is the single
   * most important one in the foxy suite, and it is only possible if the test
   * holds the same object the service does.
   */
  readonly llm: FakeLlm;
  /**
   * Swaps the scripted model for THIS test.
   *
   * ===========================================================================
   * WHY A SWAP RATHER THAN A SECOND HARNESS.
   *
   * Every interesting foxy test needs a different scripted answer — one citing a
   * real chunk, one citing an invented id, one that dies after two tokens — and
   * starting a fresh harness per case means a fresh database per case. That is
   * minutes of CI time for a difference of one string, and a suite that is slow
   * is a suite people stop running.
   *
   * The module is built ONCE, with the production wiring, around a delegating
   * provider. `reset()` restores the default, so a test that forgets to clean up
   * cannot leak its script into the next one.
   * ===========================================================================
   */
  useLlm(next: FakeLlm): void;
  /**
   * Swaps retrieval for THIS test. `null` restores the real pipeline.
   *
   * Needed for exactly one case — `below-threshold` — which this harness cannot
   * provoke, because it runs `HARNESS_ABSTAIN_THRESHOLD` (zero, never abstain on
   * score) rather than the shipped measured floor. See `AppHarnessOptions.search`
   * and `HARNESS_ABSTAIN_THRESHOLD`.
   */
  useSearch(next: ChunkSearch | null): void;
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
  // foxy's three, children first. `retrieval_traces.message_id` is ON DELETE
  // cascade and `chat_messages.session_id` likewise, so the order is belt and
  // braces — but `chat_sessions.chapter_id` is ON DELETE RESTRICT against
  // `chapters`, which IS truncated below, so a stray session would make
  // truncating `chapters` fail with an error that reads like a harness bug
  // rather than the deliberate protection it is (D-043).
  'retrieval_traces',
  'chat_messages',
  'chat_sessions',
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

/**
 * =============================================================================
 * "NEVER ABSTAIN ON SCORE", EXPLICITLY, IN THE HARNESS ONLY — AND IT IS NOT A
 * WEAKENING OF ANYTHING.
 * =============================================================================
 *
 * The shipped floor is MEASURED (0.029877369007803793, 10 August 2026) against
 * the real 4,403-chunk corpus with REAL voyage-3 query embeddings, at a stated
 * 5% in-corpus false-abstention budget. It is a good number and production
 * keeps it — `app/routes.ts` passes no override and therefore runs it, which
 * `app/__tests__/wiring.test.ts` now asserts rather than assumes.
 *
 * THIS HARNESS EMBEDS WITH `createDeterministicEmbed`. Its vectors are
 * reproducible hashes of the input text; they carry NO SEMANTICS. A fused score
 * computed from a meaningless vector is a meaningless number, and comparing a
 * meaningless number against a floor measured on meaningful ones does not test
 * the floor — it makes every unrelated assertion in every suite built on this
 * harness contingent on the arrangement of a fake.
 *
 * That is not hypothetical. Inheriting the measured floor turned exactly one
 * foxy test — `sends the ACTION's budget and temperature when a button produced
 * the turn` — into an abstention, so `llm.stream` was never called and the test
 * failed with "the model was never called". The test was right and the wiring
 * was wrong: the turn had a perfectly good seeded chunk, and the only reason it
 * abstained was that a hash landed a hair too low. Every other test in that
 * describe block passed, which is the worst version of this — the failure is a
 * coin flip on text, so the suite's colour tracks the fixtures rather than the
 * behaviour.
 *
 * WHAT THIS DOES NOT COST US. Abstention keeps its coverage, all of it:
 *   - `no-candidates` — seed no chunks for the grade. It is not a score
 *     comparison, so a zero floor exercises it in full, through the real
 *     pipeline (`foxy.service.test.ts`, "abstains when nothing was retrieved").
 *   - `below-threshold` — injected through `AppHarnessOptions.search` /
 *     `useSearch`, which returns the abstention directly (`foxy.service.test.ts`,
 *     "abstains BELOW THE THRESHOLD without calling the model either").
 *   - the safety refusals — upstream of retrieval entirely.
 *   - the decision itself — `retrieval/__tests__/abstain-threshold.test.ts`.
 *   - the distributions — the golden-set harness in `eval/retrieval/`.
 *
 * A test that genuinely wants the SCORE-BASED path should pass its own
 * `AppHarnessOptions.threshold` and say why, rather than lean on whatever this
 * default happens to be. That is the whole point of naming the value here: an
 * inherited floor is invisible, a stated one is arguable.
 *
 * `assertThresholdOnFusedScale` permits zero deliberately — "never abstain on
 * score" is a statable position, and this is a place that states it.
 */
export const HARNESS_ABSTAIN_THRESHOLD: AbstainThreshold = Object.freeze({
  value: 0,
  candidateLimit: CANDIDATE_LIMIT,
  provenance: Object.freeze({
    state: 'UNCALIBRATED',
    reason:
      'service-test harness — retrieval runs over `createDeterministicEmbed`, whose ' +
      'vectors are semantics-free hashes, so its fused scores come from a different ' +
      'distribution than the measured floor was observed on. Comparing them would ' +
      'turn unrelated tests into abstentions on the arrangement of a fake. ' +
      'Abstention is covered by `no-candidates` (no score comparison), by an ' +
      'injected below-threshold search, and by the unit and golden-set suites.',
  }),
});
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
  /**
   * The scripted model. Defaults to `createFakeLlm()`.
   *
   * Supplied by a test that needs a specific answer — one containing a real
   * `[chunk:<id>]` marker, or one containing a fabricated id — or that needs the
   * stream to fail after two tokens.
   */
  readonly llm?: FakeLlm;
  /**
   * Substitute retrieval.
   *
   * DEFAULTS TO THE REAL `retrieval.search`, wired exactly as `app/routes.ts`
   * wires it, over the real Postgres and the deterministic embedder. Most foxy
   * tests use that: seeding no chunks for a grade produces a genuine
   * `no-candidates` abstention through the production path, which is a far
   * better test than a stub returning `shouldAbstain: true`.
   *
   * The override exists for the ONE case this harness cannot produce through
   * the real pipeline: `below-threshold`. The shipped floor IS measured now
   * (10 August 2026), but the harness deliberately does not run it — see
   * `HARNESS_ABSTAIN_THRESHOLD` for why deterministic embeddings make a
   * score-based floor meaningless here — so a below-threshold abstention has to
   * be stated rather than provoked.
   */
  readonly search?: ChunkSearch;
  /**
   * The abstention floor retrieval runs under, for THIS harness instance.
   *
   * Defaults to `HARNESS_ABSTAIN_THRESHOLD` — zero, "never abstain on score",
   * reasoned at its declaration. Supply this (with a reason) if a test wants to
   * exercise the score comparison itself; do not change the default to suit one
   * test, because the default is what every other suite silently inherits.
   *
   * Production passes nothing here and nothing like it: `app/routes.ts` runs
   * the shipped MEASURED threshold, asserted in `app/__tests__/wiring.test.ts`.
   */
  readonly threshold?: AbstainThreshold;
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

  /**
   * ===========================================================================
   * THE DELEGATING MODEL IS BUILT BEFORE THE CONTAINER, SO THE CONTAINER CAN
   * GUARD IT — D-326.
   *
   * `currentLlm` is what a test swaps with `useLlm`; `delegatingLlm` is the
   * stable object the module holds. Passing the DELEGATOR to `createContainer`
   * (rather than handing it straight to `createFoxyModule`) is what puts the
   * bulkhead, the breaker and both §4 timeouts between foxy and the script —
   * exactly as production does. See the note on the container below.
   * ===========================================================================
   */
  const defaultLlm = options.llm ?? createFakeLlm();
  let currentLlm: FakeLlm = defaultLlm;
  const delegatingLlm: LlmProvider = {
    stream: (req) => currentLlm.stream(req),
    complete: (req) => currentLlm.complete(req),
  };

  const container = createContainer(config, {
    clock,
    cache,
    mail,
    logger,
    idGen: new CounterIdGen(),
    llm: delegatingLlm,
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

  /**
   * ===========================================================================
   * THE GUARDED PORTS, AS PRODUCTION HANDS THEM OVER — D-326.
   *
   * This harness used to pass the RAW `cache`, `mail` and delegating `llm`
   * objects straight to the modules, while `app/routes.ts` passes
   * `container.cache`, `container.mail` and `container.llm` — every one of
   * which leaves the composition root already wrapped in its concurrency
   * limit, its circuit breaker and its timeouts (04-RESILIENCE-PLAN.md §3.3,
   * §4, §5). The container's own header states the property that made the
   * difference invisible: "no downstream caller can hold an unguarded port —
   * not because they were told not to, but because one is never handed out".
   * The harness was handing them out.
   *
   * So no service test in the repository exercised the breaker, the
   * concurrency limiter or either LLM timeout on the paths that actually carry
   * them, and "the same wiring as `app/routes.ts`" — which this file asserts of
   * itself three times — was false for the three ports most likely to fail in
   * production.
   *
   * The RAW objects are still returned on the harness (`harness.cache`,
   * `harness.mail`, `harness.llm`) because a test has to be able to READ what
   * was recorded and to clear it between cases. What the MODULES get is the
   * guarded wrapper around those same objects.
   * ===========================================================================
   */
  const identity = createIdentityModule({
    db: container.poolFor('identity'),
    cache: container.cache,
    mail: container.mail,
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

  /**
   * THE SAME WIRING AS `app/routes.ts`, including the actor retrieval hydrates
   * chunks as. `content` is the one resource kind `platform/authz` does not
   * scope by tenant or owner, so this grants exactly what any logged-in student
   * already has.
   */
  const retrieval = createRetrievalModule({
    db: container.poolFor('retrieval'),
    embed: container.embed,
    readChunks: (ids) =>
      content.service.getChunksByIds(
        { userId: 'system:retrieval', role: 'student', tenantId: config.tenancy.defaultTenantId },
        ids,
      ),
    clock,
    logger,
    /**
     * THE ONE PLACE THIS HARNESS DELIBERATELY DIVERGES FROM `app/routes.ts`,
     * and it is stated rather than inherited. See `HARNESS_ABSTAIN_THRESHOLD`.
     */
    threshold: options.threshold ?? HARNESS_ABSTAIN_THRESHOLD,
  });

  /**
   * THE SAME WIRING AS `app/routes.ts`, and it has to be the same.
   *
   * In particular `search` narrows the real retrieval result rather than
   * stubbing it, and `readTenantOfStudent` reads `users.tenant_id` through
   * identity rather than echoing `actor.tenantId` — which is the D-091/D-125
   * mistake and the one `foxy.authz-mutation.test.ts` installs deliberately.
   */
  const productionSearch: ChunkSearch = async (query, filters) => {
    const result = await retrieval.service.search(query, {
      grade: filters.grade,
      subject: filters.subject,
    });
    return {
      chunks: result.chunks.map((chunk) => ({
        id: chunk.id,
        chunkText: chunk.chunkText,
        chapterNumber: chunk.chapterNumber,
        chapterTitle: chunk.chapterTitle,
        score: chunk.score,
        rank: chunk.rank,
      })),
      shouldAbstain: result.shouldAbstain,
      confidence: result.confidence,
      normalisedQuery: result.trace.normalisedQuery,
      abstainReason: result.trace.abstainReason,
    };
  };

  const defaultSearch = options.search ?? productionSearch;
  let currentSearch: ChunkSearch = defaultSearch;

  const foxy = createFoxyModule({
    db: container.poolFor('foxy'),
    clock,
    logger,
    // GUARDED, exactly as `app/routes.ts` hands them over — see the note above
    // the identity module (D-326). `container.llm` wraps `delegatingLlm`, so
    // `useLlm` still swaps the script underneath the guard.
    llm: container.llm,
    cache: container.cache,
    requireSession: identity.requireSession,
    search: (query, filters) => currentSearch(query, filters),
    readTenantOfStudent: (studentUserId) => identity.service.getTenantOfUser(studentUserId),
    readStudentContext: async (actor, studentUserId) => {
      const [profile, subjects] = await Promise.all([
        learner.service.getProfile(actor, studentUserId),
        learner.service.getSubjects(actor, studentUserId),
      ]);
      return { grade: profile.grade, subjects };
    },
    readLanguage: async (actor, studentUserId) =>
      (await learner.service.getProfile(actor, studentUserId)).preferredLanguage,
    /**
     * THE HARNESS BUILDS NO BILLING MODULE, so there is no `getEntitlements` to
     * ask and every harness account is on the free allowance.
     *
     * That is a statement about this harness, not about the product: `readPlan`
     * is a REQUIRED dependency as of D-257 precisely so that a construction
     * site which has not answered the plan question fails to compile rather
     * than silently inheriting the cheapest tier — which is what
     * `app/routes.ts` did to every paying customer. The paid-limit behaviour is
     * covered where the seam actually is, in `foxy.service.test.ts`.
     */
    readPlan: (): Promise<'free'> => Promise.resolve('free'),
    model: 'harness-model',
  });

  const notify = createNotifyModule({
    db: container.poolFor('notify'),
    clock,
    logger,
    metrics: container.metrics,
    cache: container.cache,
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

  /**
   * admin — BUILT HERE BECAUSE ITS ABSENCE WAS INVISIBLE.
   *
   * `admin-routes-are-gated.test.ts` asserts that a student gets 404 from every
   * admin route. With no admin module in this harness those 404s came from
   * FASTIFY'S ROUTE-NOT-FOUND, so the entire behavioural half of that suite
   * passed while proving nothing — a gate cannot be observed refusing a route
   * that was never registered.
   *
   * The harness therefore builds what production builds. `readinessUrl` points
   * at a port nothing is listening on, deliberately: the readiness signal is
   * then UNMEASURED rather than falsely green, which is the state the blind-spot
   * assertions want to see.
   */
  const admin = createAdminModule({
    db: container.poolFor('admin'),
    clock,
    logger,
    audit: container.audit,
    cache: container.cache,
    requireSession: identity.requireSession,
    readinessUrl: 'http://127.0.0.1:1/health/ready',
  });

  const app = await createServer(container, {
    modules: { identity, learner, content, practice, parent, notify, foxy, admin },
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
    retrieval,
    foxy,
    admin,
    llm: defaultLlm,
    useLlm(next: FakeLlm): void {
      currentLlm = next;
    },
    useSearch(next: ChunkSearch | null): void {
      currentSearch = next ?? defaultSearch;
    },
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
      // Restored between tests, so a test that forgets to clean up cannot leak
      // its scripted answer or its stubbed retrieval into the next one.
      currentLlm = defaultLlm;
      currentSearch = defaultSearch;
      defaultLlm.recorder.requests.length = 0;
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
