import type { FastifyInstance } from 'fastify';
import type { LinkStatus } from '../platform/authz/index';
import { createContentModule, type ContentModule } from '../modules/content/index';
import { createIdentityModule, type IdentityModule } from '../modules/identity/index';
import { createLearnerModule, type LearnerModule } from '../modules/learner/index';
import { createParentModule, type ParentModule } from '../modules/parent/index';
import { createPracticeModule, type PracticeModule } from '../modules/practice/index';
import { createRetrievalModule, type RetrievalModule } from '../modules/retrieval/index';
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
 * There are exactly two edges today, both from `learner`/`content` to
 * `identity`, and both are visible in `buildModules` below: session validation
 * and the parent-child link status. Neither module imports `@/modules/identity`.
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

  return { identity, learner, content, practice, parent, notify, retrieval };
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
  // `retrieval` is deliberately absent. It has no HTTP surface — see the note
  // on `Modules.retrieval`. Adding a line for it here is the regression.
}
