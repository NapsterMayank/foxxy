import type { FastifyInstance } from 'fastify';
import type { LinkStatus } from '../platform/authz/index';
import { createContentModule, type ContentModule } from '../modules/content/index';
import { createIdentityModule, type IdentityModule } from '../modules/identity/index';
import { createLearnerModule, type LearnerModule } from '../modules/learner/index';
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
  readonly notify: NotifyModule;
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
   * The weekly-digest content seam (§8.7), supplied once the `parent` module
   * exists.
   *
   * Absent today, and its absence is load-bearing: with no source the worker
   * registers no digest handlers, so a stray digest job is refused loudly
   * instead of succeeding without doing the work (PROGRESS.md §7).
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
    ...(options.digest === undefined ? {} : { digest: options.digest }),
  });

  return { identity, learner, content, notify };
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
  modules.notify?.registerRoutes(app);
}
