import type { FastifyInstance } from 'fastify';
import type { LinkStatus } from '../platform/authz/index';
import type { Payer } from '../platform/payments/index';
import { createBillingModule, type BillingModule } from '../modules/billing/index';
import { createContentModule, type ContentModule } from '../modules/content/index';
import { createFoxyModule, type FoxyModule } from '../modules/foxy/index';
import { createIdentityModule, type IdentityModule } from '../modules/identity/index';
import { createKnowledgeModule, type KnowledgeModule } from '../modules/knowledge/index';
import { createLearnerModule, type LearnerModule } from '../modules/learner/index';
import { createParentModule, type ParentModule } from '../modules/parent/index';
import {
  MIN_AVERAGE_MS_PER_QUESTION,
  createPracticeModule,
  validateAttempt,
  type PracticeModule,
} from '../modules/practice/index';
import { createRetrievalModule, type RetrievalModule } from '../modules/retrieval/index';
import { createSignalsModule, type SignalsModule } from '../modules/signals/index';
import {
  createNotifyModule,
  type DigestSource,
  type NotifyModule,
  type NotifyRecipient,
} from '../modules/notify/index';
import type { Container } from './container';

/**
 * Route registration for every module.
 *
 * Modules are constructed HERE and nowhere else. A module is reached only
 * through its `index.ts`, so this file is also the complete, greppable list of
 * which modules exist, what they are given, and — since every cross-module
 * dependency is injected rather than imported — the complete dependency graph.
 *
 * ELEVEN MODULES, and every cross-module edge among them is a FUNCTION BOUND IN
 * `buildModules` BELOW — session validation, the parent-child link status, the
 * account tenant, the mastery write, the retrieval search, the anti-cheat floor.
 * Not one module imports another, which is the property that keeps this file
 * the complete dependency graph rather than a partial one (D-051).
 *
 * THREE OF THE ELEVEN REGISTER NO ROUTES — `retrieval`, `knowledge` and
 * `signals` — and that is a decision rather than an omission in each case. See
 * their entries below and the note at the foot of `registerRoutes`, which says
 * so explicitly because "built but never registered" reads exactly like a
 * mistake somebody would helpfully correct.
 *
 * `billing` and `identity` are the two whose registration is ASYNCHRONOUS and
 * must be awaited; every other module's is a plain call.
 */
export interface Modules {
  readonly identity: IdentityModule;
  readonly learner: LearnerModule;
  readonly content: ContentModule;
  readonly practice: PracticeModule;
  readonly parent: ParentModule;
  readonly notify: NotifyModule;
  /**
   * NO HTTP SURFACE, AND THAT IS NOT AN OVERSIGHT.
   *
   * `retrieval` is built here and never registered in `registerRoutes` below,
   * because a retrieval endpoint would be an unauthenticated way to page
   * through the corpus and a caller who chose the filters could choose a grade
   * the student is not in. It is reached in-process by `foxy`.
   *
   * It is nonetheless a member of `Modules` rather than a local: the type is
   * total, so the day `foxy` lands it cannot be handed a retrieval service that
   * was never constructed, and the `ai`-pool assignment below stays greppable.
   */
  readonly retrieval: RetrievalModule;
  /**
   * THE ONLY MODULE THAT CALLS AN EXTERNAL SERVICE INSIDE A USER REQUEST.
   *
   * Five endpoints, all `/api/v1/foxy/*`, one of which streams. It is the sole
   * consumer of `retrieval` — which has no HTTP surface precisely so that the
   * grade and subject filters are chosen by a module with a session rather than
   * by a caller.
   */
  readonly foxy: FoxyModule;
  /**
   * FOUR ENDPOINTS UNDER `/api/v1`, AND ITS `registerRoutes` IS AWAITED.
   *
   * It is the only module besides `identity` whose registration returns a
   * promise, because the webhook needs its OWN ENCAPSULATED FASTIFY SCOPE for
   * a raw-body parser — the HMAC is computed over the exact bytes Razorpay
   * sent, and a JSON parse followed by a re-serialise is not those bytes. A
   * missing `await` would let `app.ready()` run before the scope exists, and
   * the symptom is a webhook route that 404s in production only.
   */
  readonly billing: BillingModule;
  /**
   * NO HTTP SURFACE, AND THAT IS NOT AN OVERSIGHT — the same decision as
   * `retrieval` above (D-122).
   *
   * `knowledge` is the prerequisite concept graph: curriculum structure,
   * consumed in-process by whatever decides what a student does next. An
   * endpoint returning it would be a way to page the syllabus, and a caller who
   * chose the filters could choose a grade the student is not in — the same
   * reasoning that keeps `retrieval` off the wire.
   *
   * It is a member of `Modules` rather than a local for the same reason
   * `retrieval` is: the type is total, so the day something needs the graph it
   * cannot be handed a service that was never constructed, and the `core`-pool
   * assignment below stays greppable.
   */
  readonly knowledge: KnowledgeModule;
  /**
   * NO HTTP SURFACE EITHER, AND ALSO NOT AN OVERSIGHT.
   *
   * `signals` detects anomalies ABOUT A NAMED STUDENT — inactivity, a mastery
   * drop, suspiciously fast completion. An endpoint would be a way to ask about
   * a student the caller may not be entitled to see, and this module has no
   * session and no access guard of its own. Detection is called in-process by
   * whatever notifies a teacher or a parent, and THAT caller carries the
   * boundary.
   *
   * Its `antiCheat` edge below is the one wiring line worth reading twice.
   */
  readonly signals: SignalsModule;
}

export interface BuildModulesOptions {
  /**
   * True in the WORKER process.
   *
   * §3.1: "Separate process; digests must never compete with live traffic."
   * The modules are the same objects and the graph below is the same graph —
   * what changes is which bulkhead their repositories get. In the API a module
   * receives its assigned pool (`auth` for identity, `core` for the rest); in
   * the worker every one of them receives `worker`, capped at six connections,
   * so the worst outcome of a runaway digest is that jobs are slow.
   *
   * Expressed as a flag on the ONE function that owns the dependency graph,
   * rather than as a second `buildWorkerModules`. Two builders would be two
   * places to add the next module, and the one that is not being worked on is
   * the copy that silently rots.
   */
  readonly forWorker?: boolean;
  /**
   * The weekly-digest content seam (§8.7).
   *
   * NO LONGER OPTIONAL IN PRACTICE. It used to be absent, and that absence was
   * load-bearing: with no source the worker registered no digest handlers, so a
   * stray digest job was refused loudly instead of succeeding without doing the
   * work (PROGRESS.md §7). `parent` now fills the seam, so `buildModules`
   * supplies `parent.digestSource` and the digest handlers ARE registered.
   *
   * This override remains for tests that want to observe what notify asks for
   * without building a real digest. Production never passes it — a test asserts
   * that the source reaching notify is the parent module's own.
   */
  readonly digest?: DigestSource;
}

/**
 * Both origins now come from explicit configuration — resolves D-015.
 *
 * They used to be derived, and both derivations were wrong in the same
 * deployment:
 *
 *  - `apiBaseUrl` was built from `HOST` and `PORT`. `HOST` is a BIND address.
 *    Behind a reverse proxy it is `0.0.0.0` or a container IP, and `PORT` is
 *    the internal port — so the verification link mailed to a new user pointed
 *    at an address no browser can reach.
 *  - `appBaseUrl` was `corsOrigins[0]`. That is an allow-list entry that
 *    happens to be first. Adding a staging origin at the front of the list
 *    would have silently redirected every production signup to staging.
 *
 * Neither failure appears in development, where the derivations are correct,
 * and both land in the middle of the onboarding funnel — the one path that
 * cannot afford an intermittent bug. `APP_URL` and `API_URL` are required
 * variables, so a deployment that forgets them fails at boot instead.
 */
export function buildModules(container: Container, options: BuildModulesOptions = {}): Modules {
  const { config } = container;
  const forWorker = options.forWorker === true;

  const identity = createIdentityModule({
    // §3.1: identity gets the `auth` pool, which must never be starved. Named
    // rather than aliased — see the note on `Container.poolFor` (D-030).
    db: forWorker ? container.pools.worker : container.poolFor('identity'),
    cache: container.cache,
    mail: container.mail,
    clock: container.clock,
    logger: container.logger,
    /**
     * THE PRIVILEGED-ACTION TRAIL — 05-ROADMAP.md §8.
     *
     * Wired here rather than defaulted inside the module, so that the answer to
     * "is auditing on in production" is visible in the composition root instead
     * of buried in a `?? createNoopAudit()`. A test pins this line: it asserts
     * that a real audit port reaches the identity module through
     * `buildModules`, because the module's own default is a no-op and a
     * silently-unwired audit log is indistinguishable from one that is working
     * and has nothing to say.
     */
    audit: container.audit,
    /**
     * D-034 — the rate-limit in-process fallback metric finally has somewhere
     * to go. `MetricsSink` is identity's own one-method interface, written
     * before `platform/metrics` existed; the adapter is three lines and keeps
     * the module from depending on the metrics port directly.
     *
     * The metric matters: an in-process fallback means AUTHENTICATION HAS
     * SILENTLY DEGRADED to a per-instance limiter, and D-034's own words are
     * "a silent fallback is a silent security downgrade — the whole point is
     * that somebody finds out". Until now the only signal was a log line.
     */
    metrics: {
      increment: (metric: string, tags?: Readonly<Record<string, string>>): void => {
        container.metrics.counter(metric, 1, tags);
      },
    },
    /**
     * THE TENANT THIS DEPLOYMENT SERVES — D-073.
     *
     * Signup is the one insert path with no authenticated actor to inherit a
     * tenant from, so the value arrives here from configuration and is threaded
     * into `createUser` explicitly. It is NOT left to the column default: a
     * default cannot tell "not supplied" from "supplied and equal to the
     * default", so leaning on it would mean the day a second tenant exists,
     * every signup silently lands in the first — with no error and no way to
     * tell which rows were wrong.
     *
     * When multi-tenancy arrives, this line becomes a per-request resolution
     * (subdomain -> tenant). One line, in one file, because every insert path
     * downstream already takes the tenant as an argument.
     */
    defaultTenantId: config.tenancy.defaultTenantId,
    session: {
      name: config.session.cookieName,
      ttlDays: config.session.ttlDays,
      // `secure` is dropped ONLY for local http development. A secure cookie
      // is silently discarded by the browser over plaintext, which would make
      // local login appear to succeed and then fail on the next request.
      secure: config.env !== 'development',
    },
    urls: {
      apiBaseUrl: config.urls.api,
      appBaseUrl: config.urls.app,
    },
  });

  /**
   * The parent-child link status, read AT QUERY TIME for each authorization
   * decision (§7 rule 3) — so a revocation takes effect on the parent's very
   * next request rather than at their next login.
   *
   * WHY IT COLLAPSES TO `'approved' | null` RATHER THAN THE FULL THREE-VALUED
   * STATUS. `identity.isLinkApproved` answers the only question the authz
   * boundary actually asks. The guard treats `pending`, `revoked` and "no link
   * at all" identically and by design: telling them apart in a 403 would
   * reveal whether a given student account exists, which is the enumeration
   * leak §7 rule 2 exists to close. Widening this to return the real status
   * would hand every future call site the ability to leak that distinction,
   * for no behaviour that any of them needs.
   */
  const readLinkStatus = async (
    parentUserId: string,
    studentUserId: string,
  ): Promise<LinkStatus | null> =>
    (await identity.service.isLinkApproved(parentUserId, studentUserId)) ? 'approved' : null;

  const learner = createLearnerModule({
    // §3.1: ordinary request traffic, so the `core` pool. Named rather than
    // taken from a general-purpose handle — there is no longer any such thing
    // (D-045). Had `container.db` survived, this is the exact line that would
    // have quietly put learner queries in competition with login.
    db: forWorker ? container.pools.worker : container.poolFor('learner'),
    clock: container.clock,
    logger: container.logger,
    requireSession: identity.requireSession,
    readLinkStatus,
    /**
     * THE RESOURCE SIDE of the tenant comparison — D-073. The third cross-module
     * edge, and like the other two it is INJECTED rather than imported, so this
     * file stays the complete dependency graph.
     *
     * It reads `users.tenant_id`, which is identity's table and the
     * authoritative copy, rather than the denormalised copy on `students` — a
     * student who has not onboarded yet has no `students` row, and "the profile
     * does not exist" must not become "denied" for the caller creating it.
     */
    readTenantOfStudent: (studentUserId: string): Promise<string | null> =>
      identity.service.getTenantOfUser(studentUserId),
  });

  const content = createContentModule({
    // Also `core`. `retrieval` will read the SAME `rag_chunks` table on `ai`;
    // the pool follows the caller's cost profile, not the table's owner.
    db: forWorker ? container.pools.worker : container.poolFor('content'),
    logger: container.logger,
    requireSession: identity.requireSession,
  });

  /**
   * ==========================================================================
   * practice — THE MOST CONNECTED MODULE, AND STILL ZERO IMPORTS.
   *
   * Four edges, to three modules, all visible here: questions and chapters from
   * `content`, the student's grade/subjects/mastery and the mastery WRITE from
   * `learner`, and the account tenant from `identity`. That is more than any
   * other module has, which is exactly why every one of them is an injected
   * function rather than an import — otherwise this file would stop being the
   * complete dependency graph on the day practice was built (D-051).
   *
   * THE MOST IMPORTANT LINE BELOW IS `readQuestions`. It is bound to
   * `content.getQuestionsForChapter`, which has NO argument that could return a
   * held-out question, and `getHeldOutQuestionsForChapter` is deliberately NOT
   * passed. `practice` therefore cannot serve a reserved question by mistake:
   * it has no way to ask for one. A question served in ordinary practice may
   * have been memorised and can never measure anything again, for that student,
   * permanently — so the protection had to be structural rather than careful.
   * ==========================================================================
   */
  const practice = createPracticeModule({
    // §3.1: ordinary request traffic, so the `core` pool.
    db: forWorker ? container.pools.worker : container.poolFor('practice'),
    clock: container.clock,
    logger: container.logger,
    requireSession: identity.requireSession,

    readQuestions: (actor, query) => content.service.getQuestionsForChapter(actor, query),
    readChapter: async (actor, chapterId) => {
      try {
        return await content.service.getChapter(actor, chapterId);
      } catch {
        // A withdrawn chapter is a 404 inside `content`; practice wants "there
        // is no such chapter" as a VALUE, because it has its own message for it
        // and because a session whose chapter was withdrawn mid-flight must not
        // surface content's wording.
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
    /**
     * D-056 — the mastery write, enlisted in practice's SUBMISSION TRANSACTION.
     *
     * `input.executor` is an opaque `TransactionToken` that practice's
     * repository opened and that learner's repository unwraps. Neither service
     * can run a statement with it, and the transaction spans two modules'
     * tables — which is the only way §8.6's "all of it lands or none of it
     * does" can include `chapter_mastery`.
     */
    writeMastery: (actor, input) => learner.service.updateMastery(actor, input),

    // The SAME wiring as `learner` above: the resource side of the tenant
    // comparison, read from `users` through identity rather than from a copy,
    // and never echoed back off the actor (D-091).
    readTenantOfStudent: (studentUserId: string): Promise<string | null> =>
      identity.service.getTenantOfUser(studentUserId),
  });

  /**
   * ==========================================================================
   * parent — THE ONLY CROSS-USER DATA PATH IN THE PRODUCT.
   *
   * Five injected edges, to two modules, all visible here and none of them an
   * import: the link status and the account tenant from `identity`, the child's
   * profile from `learner`, and the link revocation back to `identity` because
   * `parent_child_links` is not this module's table.
   *
   * THE MOST IMPORTANT LINE BELOW IS `readTenantOfStudent`. It reads
   * `users.tenant_id` for the CHILD. Passing `actor.tenantId` instead would
   * type-check perfectly and turn `assertTenantMatch` into a comparison of a
   * value with itself — a check that always passes, wearing the shape of a
   * check that sometimes fails. That is not hypothetical: `notify` shipped
   * exactly that mistake (D-091), in a file with a comment explaining why the
   * check mattered.
   * ==========================================================================
   */
  const parent = createParentModule({
    // §3.1: ordinary request traffic, so the `core` pool.
    db: forWorker ? container.pools.worker : container.poolFor('parent'),
    clock: container.clock,
    logger: container.logger,
    requireSession: identity.requireSession,

    // The SAME collapsing to `'approved' | null` the learner and practice
    // modules get, and for the same reason: telling `pending` from `revoked`
    // from "no link at all" in a 403 is a child-existence oracle.
    readLinkStatus,
    // D-091 — read from the DATA, never echoed off the actor. See above.
    readTenantOfStudent: (studentUserId: string): Promise<string | null> =>
      identity.service.getTenantOfUser(studentUserId),
    listLinkedChildren: (actor) => identity.service.getLinkedChildren(actor),
    readChildProfile: async (actor, studentUserId) => {
      // `learner.getProfile` re-runs the guard on its own, so this is a second
      // independent check rather than a trusted call. The narrowing to three
      // fields is deliberate: a parent screen has no use for `board` or the
      // timestamps, and a wider shape is a wider thing to leak later.
      const profile = await learner.service.getProfile(actor, studentUserId);
      return {
        displayName: profile.displayName,
        grade: profile.grade,
        preferredLanguage: profile.preferredLanguage,
      };
    },
    revokeLink: async (actor, linkId): Promise<void> => {
      await identity.service.revokeLink(actor, linkId);
    },

    // Consent changes and transcript reads are audited. Wired here rather than
    // defaulted inside the module, for the same reason identity's is: the
    // module's own default is a no-op, and a silently-unwired audit log is
    // indistinguishable from one that is working and has nothing to say.
    audit: container.audit,
  });

  /**
   * ==========================================================================
   * retrieval — CONSTRUCTED HERE, REGISTERED NOWHERE.
   *
   * It has no routes by design (see `Modules.retrieval`), so it appears in
   * `buildModules` and not in `registerRoutes`. Two things about this block are
   * load-bearing:
   *
   *  1. THE `ai` POOL, not `core` — even though `content` owns `rag_chunks` and
   *     runs on `core`. The pool follows the CALLER's cost profile: a slow HNSW
   *     scan holding a `core` connection would put every chapter listing behind
   *     vector search. The `ai` pool is also the only one carrying
   *     `hnsw.ef_search = 100` (D-049); on any other pool the top-50 dense query
   *     silently returns 40 rows and the corpus reads as thin.
   *
   *  2. `readChunks` IS `content.getChunksByIds`, and the service re-ranks what
   *     it returns (D-060). That query is an `IN (...)`, so its row order is
   *     whatever the plan produced — trusting it would scramble the ranking
   *     while returning perfectly valid chunks, which errors nowhere and quietly
   *     stops putting the best passage first.
   * ==========================================================================
   */
  /**
   * The actor retrieval hydrates chunks as. See `readChunks` below.
   *
   * `student` because `platform/authz` IGNORES ROLE for `kind: 'content'` — the
   * rule is tenant + read — so this is the least-privileged role that can be
   * named, and naming a wider one would imply a capability that does not exist
   * and would become real the day content grows a role-sensitive rule.
   *
   * The id is not a user. It is deliberately not a UUID, so that if it ever
   * reaches a query that joins to `users` the join fails loudly instead of
   * matching nothing quietly.
   */
  const RETRIEVAL_ACTOR = Object.freeze({
    userId: 'system:retrieval',
    role: 'student',
    tenantId: config.tenancy.defaultTenantId,
  } as const);

  const retrieval = createRetrievalModule({
    db: forWorker ? container.pools.worker : container.poolFor('retrieval'),
    // Already behind its bulkhead, breaker and 5s timeout — the composition
    // root never hands out a bare adapter.
    embed: container.embed,
    /**
     * `ChunkReader` TAKES IDS AND NO ACTOR, so the actor is supplied here.
     *
     * That is not a bypass, and the reason it is not is worth stating rather
     * than assuming. `content` is the ONE resource kind in `platform/authz`
     * that is not tenant-scoped and not owned: the rule is "any authenticated
     * actor may read, nobody may write". So the actor below grants exactly what
     * every logged-in student already has, and nothing else — there is no
     * privilege here to escalate to.
     *
     * The reason retrieval does not carry the real caller instead: the actor
     * would be decorative. Hydration is a primary-key lookup of ids that
     * retrieval's own SQL already hard-filtered by grade and subject, and an
     * actor threaded through only to satisfy a check that cannot fail reads as
     * a boundary while being none. The authorisation that MATTERS for a
     * retrieval — which student, in which grade, may ask this — belongs to
     * `foxy`, which is the module with a request and a session.
     */
    readChunks: (ids) => content.service.getChunksByIds(RETRIEVAL_ACTOR, ids),
    clock: container.clock,
    logger: container.logger,
  });

  /**
   * ==========================================================================
   * foxy — THE ONLY EXTERNAL CALL INSIDE A USER REQUEST.
   *
   * Six injected edges, to four modules, all visible here and none of them an
   * import: the retrieval itself from `retrieval`, the grade/subjects and the
   * preferred language from `learner`, the account tenant from `identity`, and
   * the subscription plan from `billing` — which does not exist, so the reader
   * below reports "no subscription" and the service reads that as `free`.
   *
   * THREE LINES BELOW ARE LOAD-BEARING.
   *
   *  1. `search` IS BOUND TO `retrieval.service.search` AND THE FILTERS ARE NOT
   *     PASSED THROUGH FROM ANY REQUEST. `foxy` builds them from the session's
   *     subject and the student's own grade. This is the reason `retrieval` has
   *     no HTTP surface at all: a caller who could choose the filters could
   *     choose a grade the student is not in.
   *
   *  2. `readTenantOfStudent` READS `users.tenant_id`. Passing `actor.tenantId`
   *     would type-check perfectly and turn `assertTenantMatch` into a
   *     comparison of a value with itself — a check that always passes wearing
   *     the shape of one that sometimes fails. That is not hypothetical: it
   *     shipped in `notify` (D-091) and again, undetected, in `parent`'s
   *     `authoriseSelf` (D-125).
   *
   *  3. `model` COMES FROM CONFIGURATION AND IS STAMPED ON EVERY TRACE. The
   *     model id is an environment variable, so which model produced a given
   *     answer is not derivable from the code afterwards. Per-row is the only
   *     place it can be true.
   * ==========================================================================
   */
  const foxy = createFoxyModule({
    // §3.1: the `ai` pool, like `retrieval` and for the same reason — a Foxy
    // turn is a retrieval plus a model call, and a slow one must not be able to
    // hold a connection that a login needs.
    db: forWorker ? container.pools.worker : container.poolFor('foxy'),
    clock: container.clock,
    logger: container.logger,
    // Already behind its bulkhead, breaker and both timeout rules — the
    // composition root never hands out a bare adapter.
    llm: container.llm,
    // Usage counters. In `platform/cache`, never in process memory (§7).
    cache: container.cache,
    requireSession: identity.requireSession,

    search: async (query, filters) => {
      const result = await retrieval.service.search(query, {
        grade: filters.grade,
        subject: filters.subject,
      });
      // NARROWED, not passed through. `foxy` needs the text, the citation
      // fields and the ranking; it has no use for the embedding model name or
      // the duplicate groups, and a wider shape is a wider thing to leak into a
      // prompt later.
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
    },

    // D-091 / D-125 — read from the DATA, never echoed off the actor.
    readTenantOfStudent: (studentUserId: string): Promise<string | null> =>
      identity.service.getTenantOfUser(studentUserId),

    readStudentContext: async (actor, studentUserId) => {
      const [profile, subjects] = await Promise.all([
        learner.service.getProfile(actor, studentUserId),
        learner.service.getSubjects(actor, studentUserId),
      ]);
      return { grade: profile.grade, subjects };
    },
    readLanguage: async (actor, studentUserId) =>
      (await learner.service.getProfile(actor, studentUserId)).preferredLanguage,

    // `billing` is build step 13. Until it exists every account reports no
    // subscription, which the service reads as `free` — stated here rather than
    // defaulted invisibly inside the module.
    readPlan: (): Promise<null> => Promise.resolve(null),

    model: config.ai.llmModel ?? 'unset',
  });

  const notify = createNotifyModule({
    // §3.1: notify's HTTP surface is ordinary request traffic, so `core`. In
    // the worker it is background work and gets `worker` — the delivery job
    // reads `notifications`, which the badge poll on every screen also reads.
    db: forWorker ? container.pools.worker : container.poolFor('notify'),
    clock: container.clock,
    logger: container.logger,
    metrics: container.metrics,
    // Frequency-cap counters, and preferences until they have a table.
    cache: container.cache,
    /**
     * THE IN-APP ADAPTER, HANDED OVER DIRECTLY rather than reached through the
     * dispatcher.
     *
     * In-app is not a routing choice; it is the durable record that the system
     * decided to tell somebody something, and `notify.send` writes it
     * synchronously before any remote channel is attempted. Routing it through
     * the dispatcher would put it in the same fan-out as email, which runs
     * later in a different process, and would give the worker a second chance
     * to write the same row.
     */
    inAppChannel: container.channels['in-app'],
    dispatcher: container.notify,
    // The API only ever ENQUEUES. It never claims — that is the worker's job,
    // and the separation is what keeps a slow provider out of a request.
    queue: container.jobQueue,
    requireSession: identity.requireSession,
    /**
     * THE FOURTH CROSS-MODULE EDGE, and like the other three it is INJECTED
     * rather than imported, so this file stays the complete dependency graph.
     *
     * It reads `users`, which is identity's table and the authoritative copy of
     * both the address and the tenant. Resolving the tenant HERE, from the
     * recipient, is D-084's named mechanism for giving `notifications.tenant_id`
     * a real value instead of leaning on the column default — which cannot tell
     * "not supplied" from "supplied and equal to the default", and would file
     * every notification under the first tenant the day a second one exists.
     */
    readRecipient: (userId: string): Promise<NotifyRecipient | null> =>
      identity.service.getNotificationRecipient(userId),
    /**
     * THE WEEKLY-DIGEST SEAM, NOW FILLED — §8.7 into §8.9.
     *
     * `parent.digestSource` satisfies notify's `DigestSource` structurally, and
     * the two interfaces are deliberately NOT the same declaration: `parent`
     * importing a type from `@/modules/notify` would be the cross-module import
     * this file exists to prevent (D-051). The compiler checks the shapes agree
     * at exactly this line, which is the only place that should care.
     *
     * The override is for tests that want to observe what notify asks for
     * without building a real digest. Production never passes it.
     */
    digest: options.digest ?? parent.digestSource,
  });

  /**
   * ==========================================================================
   * billing — TWO EDGES, AND THE SECOND ONE IS A COMMERCIAL DECISION.
   *
   * `readTenantOfUser` is the same D-091 wiring every other module gets: the
   * resource tenant read from `users` through `identity`, never echoed off the
   * actor. `billing.authz-mutation.test.ts` installs the broken version
   * deliberately and proves a cross-tenant read then succeeds, so this line is
   * load-bearing rather than ceremonial.
   *
   * `resolvePayer` IS THE B2C/B2B ANSWER, and it is one line HERE precisely so
   * that it is not a hundred lines inside the module. `billing` never
   * constructs a payer, so it cannot assume a parent is paying; a subscription
   * carries `subject_user_id` (whose entitlements) and a payer as INDEPENDENT
   * facts, with a database CHECK making any other combination unrepresentable
   * (D-150). Changing the product to a B2B school pilot is an edit to the
   * function below and to nothing else.
   *
   * The `payments` port arrives from the container ALREADY GUARDED and already
   * chosen: Razorpay when credentials exist, the deterministic fake otherwise,
   * and a production boot refusal in between. That refusal is why this line can
   * be read as "the real gateway" — see `Container.payments`.
   * ==========================================================================
   */
  const billing = createBillingModule({
    // §3.1: ordinary request traffic, so the `core` pool.
    db: forWorker ? container.pools.worker : container.poolFor('billing'),
    clock: container.clock,
    logger: container.logger,
    requireSession: identity.requireSession,
    payments: container.payments,

    // D-091 / D-125 — read from the DATA, never echoed off the actor.
    readTenantOfUser: (userId: string): Promise<string | null> =>
      identity.service.getTenantOfUser(userId),

    /**
     * THE B2C ANSWER: the beneficiary pays for themselves.
     *
     * `subjectUserId` and NOT `actor.userId`, even though today they are equal
     * for every path that reaches here. They are equal because
     * `authoriseSubscription` has already refused any actor who is not the
     * subject — so writing `actor.userId` would be relying on a guard elsewhere
     * to keep two values in step, and the day a parent may subscribe FOR a
     * child that reliance silently bills the wrong person. Naming the subject
     * makes the row say what it means.
     *
     * The B2B pilot replaces this with a school lookup returning
     * `{ kind: 'school', id }`, and returning null refuses the checkout rather
     * than falling back to charging the actor.
     */
    resolvePayer: (subjectUserId: string): Promise<Payer | null> =>
      Promise.resolve({ kind: 'user', id: subjectUserId }),

    // Subscription creation, cancellation and REJECTED WEBHOOKS are audited.
    // Wired here rather than defaulted inside the module, for the same reason
    // identity's and parent's are: the module's own default is a no-op, and a
    // silently-unwired audit log is indistinguishable from one that is working
    // and has nothing to say.
    audit: container.audit,
  });

  /**
   * ==========================================================================
   * knowledge — CONSTRUCTED HERE, REGISTERED NOWHERE. Deliberate; see
   * `Modules.knowledge`.
   *
   * ONE dependency and no cross-module edges at all: it owns `concept_graph`,
   * `chapter_concepts` and the chapter rows it projects onto, and it asks
   * nobody anything. The 176 graph edges were imported with the corpus and,
   * until this module, NOTHING READ THEM.
   *
   * THE `core` POOL, following `content` — these are small indexed curriculum
   * reads, the same cost profile as a chapter listing. Note this is not the
   * same rule as "the pool of the table's owner": `retrieval` also reads a
   * table `content` owns and still gets `ai`, because a vector scan has nothing
   * in common with a chapter listing. Here the profiles genuinely match.
   * ==========================================================================
   */
  const knowledge = createKnowledgeModule({
    db: forWorker ? container.pools.worker : container.poolFor('knowledge'),
    logger: container.logger,
  });

  /**
   * ==========================================================================
   * signals — CONSTRUCTED HERE, REGISTERED NOWHERE. Deliberate; see
   * `Modules.signals`.
   *
   * THE ONE LINE THAT MATTERS IS `antiCheat`, and what matters about it is that
   * it is a REFERENCE rather than a value.
   *
   * `signals`' `fast_completion` rule is defined relative to the floor that
   * `practice` rejects a submission by. There is DELIBERATELY NO DEFAULT on the
   * edge (D-131), so a missing wiring is a compile error rather than a silent
   * second copy of `3_000` — and both fields below come from
   * `practice/index.ts` rather than being restated here. Two copies of a
   * threshold drift, and the symptom of that drift is a signal that quietly
   * stops agreeing with the rejection it is defined relative to: sessions
   * refused as too fast that raise no anomaly, or anomalies raised for sessions
   * nobody refused. Neither errors.
   *
   * `isAttemptValid` DISCARDS THE REASON on purpose. `validateAttempt` returns
   * which of the three checks failed, and that reason belongs to `practice` —
   * it is written to `practice_sessions.invalid_reason` and read by a human
   * deciding what to say to a student. `signals` needs the VERDICT to decide
   * whether a fast session was already rejected; giving it the reason would
   * invite it to grow its own opinion about what the reason means, in a second
   * place, from evidence it did not gather.
   *
   * THE `core` POOL, following `practice` — small indexed reads over one
   * student's recent sessions.
   * ==========================================================================
   */
  const signals = createSignalsModule({
    db: forWorker ? container.pools.worker : container.poolFor('signals'),
    antiCheat: {
      minimumAverageMsPerQuestion: MIN_AVERAGE_MS_PER_QUESTION,
      isAttemptValid: (responses, questionCount): boolean =>
        validateAttempt(responses, questionCount).isValid,
    },
    clock: container.clock,
    logger: container.logger,
  });

  return {
    identity,
    learner,
    content,
    practice,
    parent,
    notify,
    retrieval,
    foxy,
    billing,
    knowledge,
    signals,
  };
}

/**
 * Registers whichever modules were built.
 *
 * `Partial<Modules>` here, `Modules` on `buildModules` above — and the
 * asymmetry is deliberate. Production goes through `buildModules`, whose
 * return type is total, so a module cannot be dropped from a real deployment
 * without a compile error. A TEST HARNESS, on the other hand, legitimately
 * wants one module and no others: the identity suite has no interest in
 * learner's routes, and forcing it to construct them would couple every
 * identity test to every future module's dependencies.
 */
export async function registerRoutes(
  app: FastifyInstance,
  modules: Partial<Modules>,
): Promise<void> {
  // IDENTITY FIRST, and this ordering is load-bearing: it registers
  // `@fastify/cookie`, which every other module's `requireSession` preHandler
  // needs in order to read the session cookie. Registered second, the learner
  // routes would parse no cookies and every authenticated request would 401.
  if (modules.identity !== undefined) {
    await modules.identity.registerRoutes(app);
  }
  modules.learner?.registerRoutes(app);
  modules.content?.registerRoutes(app);
  modules.practice?.registerRoutes(app);
  modules.parent?.registerRoutes(app);
  modules.notify?.registerRoutes(app);
  modules.foxy?.registerRoutes(app);
  /**
   * AWAITED, unlike every module above it except `identity`.
   *
   * `billing.registerRoutes` returns a promise because the webhook is
   * registered inside its OWN ENCAPSULATED FASTIFY SCOPE, which needs a raw-body
   * content-type parser: the HMAC is computed over the exact bytes Razorpay
   * sent, and a JSON parse followed by a re-serialise is not those bytes.
   * `app.register` is asynchronous, so dropping the `await` here lets
   * `app.ready()` run before the scope is installed — and the symptom is a
   * webhook that 404s, in production only, for every genuine delivery.
   */
  if (modules.billing !== undefined) {
    await modules.billing.registerRoutes(app);
  }
  /**
   * `retrieval`, `knowledge` AND `signals` ARE DELIBERATELY ABSENT — all three
   * are constructed in `buildModules` and none of them is registered here.
   *
   * Stated explicitly because "built but never registered" reads exactly like
   * an oversight, and the next person to notice will otherwise close the
   * apparent gap by adding three lines. Each one is a decision:
   *
   *   retrieval  an endpoint would be an unauthenticated way to page the
   *              corpus, and a caller who chose the filters could choose a
   *              grade the student is not in (D-122). Reached in-process by
   *              `foxy`, which has a session.
   *   knowledge  an endpoint would be a way to page the syllabus, for the same
   *              filter-choosing reason. Curriculum structure consumed by
   *              whatever plans a student's next step.
   *   signals    every answer it gives is ABOUT A NAMED STUDENT, and the module
   *              has no session and no access guard of its own. The caller that
   *              notifies a teacher or a parent carries that boundary.
   *
   * Adding a line here for any of the three is the regression, not the fix.
   */
}
