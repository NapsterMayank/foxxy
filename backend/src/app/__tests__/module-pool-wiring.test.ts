import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCache } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { parseConfig } from '@/platform/config/load-config';
import { FakeLogger } from '@/platform/logger/index';
import { RecordingMail } from '@/platform/mail/index';
import { createFakePayments, type FakePayments } from '@/platform/payments/index';
import {
  MODULE_POOLS,
  type Database,
  type DbExecutor,
  type ModuleName,
  type NamedDbHandle,
} from '@/platform/db/index';
import type { Actor } from '@/platform/authz/index';
import { createContainer, type Container } from '../container';
import { buildModules, type Modules } from '../routes';

/**
 * =============================================================================
 * WHICH HANDLE EACH MODULE WAS ACTUALLY HANDED — §3.1, ASSERTED AT LAST (D-322).
 *
 * WHY THIS FILE EXISTS, AND WHY `routes.test.ts` DID NOT COVER IT.
 *
 * `routes.test.ts` carries a test titled "hands each module the pool §3.1
 * assigns it". IT NEVER CALLS `buildModules`. Its eleven assertions read
 * `built.poolFor('foxy').name === 'ai'` — a restatement of the `MODULE_POOLS`
 * lookup table, evaluated against the container, with the composition root
 * absent from the test entirely. The very next test in that file re-asserts the
 * same table directly. So the table was checked TWICE and the wiring zero times.
 *
 * That is not a theoretical gap. An audit changed one line of `buildModules`
 * from `container.poolFor('foxy')` to `container.poolFor('identity')` — putting
 * a Foxy turn, which holds its connection across a model call, onto the ten
 * connections reserved for login, the precise failure §3.1 exists to prevent —
 * and ran the whole app suite: 164 of 164 passed.
 *
 * -----------------------------------------------------------------------------
 * HOW DELIVERY IS OBSERVED, GIVEN THAT NO MODULE EXPOSES ITS HANDLE.
 *
 * A module receives a `NamedDbHandle` and hides it in a repository. There is no
 * getter and there should not be one — a module that could show you its pool is
 * a module that could choose it.
 *
 * So `poolFor` is replaced with a factory that issues a TRAP HANDLE TAGGED WITH
 * THE MODULE NAME IT WAS ASKED FOR. The tag is the module, not the pool, which
 * is what makes the assertion exact: `poolFor('foxy')` and `poolFor('identity')`
 * are different tags even when they resolve to the same pool, so the audit's
 * mutation is caught by identity and foxy being confusable at all — not merely
 * by `auth` and `ai` differing.
 *
 * A trap's `db` records its tag and throws, which ends the driver at the first
 * database access. Each driver is therefore chosen so the module's OWN
 * repository is the first thing it touches. That is a CONSTRAINT ON THE DRIVER,
 * not an accident: `foxy.listSessions` resolves the tenant through identity
 * before it reads anything of its own, so it would report `identity` no matter
 * how foxy was wired — permanently green, permanently meaningless, the same
 * defect one layer down. `foxy.getTranscript` loads the session from foxy's own
 * repository first, so it reports foxy.
 *
 * The driver table is TOTAL over `ModuleName`: a module added to §3.1 with no
 * way to observe its handle does not compile.
 * =============================================================================
 */

/** The webhook secret the container's fake payments port is built with here. */
const WEBHOOK_SECRET = 'module-pool-wiring-secret';

let container: Container | undefined;
let payments: FakePayments | undefined;

function makeContainer(): Container {
  const clock = new FixedClock('2026-06-01T09:00:00.000Z');
  const config = parseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5433/unused',
    REDIS_URL: 'redis://localhost:6379',
    CORS_READ_ORIGINS: 'http://localhost:3000',
    CORS_WRITE_ORIGINS: 'http://localhost:3000',
    SESSION_COOKIE_NAME: 'foxxy_session',
    APP_URL: 'http://app.test',
    API_URL: 'http://api.test',
  });
  // Held so the billing driver can produce a GENUINELY SIGNED delivery. An
  // unsigned one is rejected before billing's repository is reached, which
  // would make that driver observe nothing at all.
  payments = createFakePayments({ secret: WEBHOOK_SECRET, planCodes: ['monthly', 'yearly'] });
  container = createContainer(config, {
    clock,
    cache: new MemoryCache(clock),
    mail: new RecordingMail(),
    logger: new FakeLogger(),
    payments,
  });
  return container;
}

afterEach(async () => {
  await container?.shutdown();
  container = undefined;
  payments = undefined;
});

const ACTOR: Actor = {
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'student',
  tenantId: '22222222-2222-4222-8222-222222222222',
};

/** What `poolFor` was asked for, or `'worker'` for the direct `pools.worker`. */
type HandleTag = ModuleName | 'worker';

/** A handle whose every database access records its tag and then refuses. */
function trapHandle(real: NamedDbHandle, tag: HandleTag, touched: HandleTag[]): NamedDbHandle {
  const boom = (): never => {
    touched.push(tag);
    throw new Error(`HANDLE:${tag}`);
  };
  // ANY property read counts. Drizzle statements start at `db.select`,
  // `db.insert`, `db.query…`; a repository that reached for one of them has
  // already committed to this handle.
  const db = new Proxy({}, { get: () => boom(), apply: () => boom() }) as unknown as Database;

  return {
    ...real,
    db,
    withTransaction<T>(_fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
      touched.push(tag);
      return Promise.reject(new Error(`HANDLE:${tag}`));
    },
  };
}

/**
 * The container with every handle it can hand out replaced by a trap tagged
 * with the NAME IT WAS ASKED FOR.
 */
function withTaggedHandles(real: Container, touched: HandleTag[]): Container {
  const worker = trapHandle(real.pools.worker, 'worker', touched);

  return {
    ...real,
    pools: { ...real.pools, worker },
    poolFor: (module: ModuleName): NamedDbHandle =>
      trapHandle(real.pools[MODULE_POOLS[module]], module, touched),
  };
}

/**
 * One repository-backed call per module, chosen so the module's OWN repository
 * is the first database it reaches. See the header — a driver whose first touch
 * belongs to an injected edge passes regardless of the wiring.
 */
const DRIVERS: Readonly<Record<ModuleName, (modules: Modules) => Promise<unknown>>> = Object.freeze(
  {
    // No authz at all — a raw `users` read, identity's own table.
    identity: (m) => m.identity.service.getTenantOfUser(ACTOR.userId),
    // A SELF read: learner short-circuits the tenant lookup for `actor.userId`,
    // so the identity edge is never called and the first touch is learner's own.
    learner: (m) => m.learner.service.getProfile(ACTOR, ACTOR.userId),
    // `content` is the one resource kind with no tenant and no owner, so the
    // guard decides without reading anything.
    content: (m) => m.content.service.getChapter(ACTOR, '33333333-3333-4333-8333-333333333333'),
    // Loads the session from practice's own repository, then authorises off the
    // row — `getHistory` would resolve the tenant through identity first.
    practice: (m) => m.practice.service.getSession(ACTOR, '66666666-6666-4666-8666-666666666666'),
    // The digest source: parent's own repository, and it takes no actor.
    parent: (m) => m.parent.digestSource.findParentsDue(new Date('2026-05-25T00:00:00.000Z')),
    // The ONE billing entry point that is not authorised through identity first.
    // The signature verifies (see `payments` above), so it reaches rule 2's
    // transaction — every other method resolves a tenant through identity.
    billing: (m) =>
      m.billing.service.handleWebhook(
        requirePayments().delivery({
          id: 'evt_module_pool_wiring',
          event: 'subscription.charged',
          subscriptionId: 'sub_wiring',
          currentPeriodEnd: '2026-09-01T00:00:00.000Z',
        }),
      ),
    // The delivery handler reads the notification from notify's own repository
    // before it resolves a recipient through identity.
    notify: (m) =>
      m.notify.service.deliver({
        id: 'job_module_pool_wiring',
        kind: 'notify.deliver',
        idempotencyKey: 'module-pool-wiring',
        payload: { notificationId: '77777777-7777-4777-8777-777777777777', channels: [] },
        attempts: 1,
        maxAttempts: 3,
        runAt: new Date('2026-06-01T09:00:00.000Z'),
        createdAt: new Date('2026-06-01T09:00:00.000Z'),
      }),
    // No cross-module edges at all — knowledge owns every table it reads.
    knowledge: (m) =>
      m.knowledge.service.getConceptsForChapter('44444444-4444-4444-8444-444444444444'),
    signals: (m) =>
      m.signals.service.detectAnomalies(ACTOR.userId, {
        from: new Date('2026-05-25T00:00:00.000Z'),
        to: new Date('2026-06-01T00:00:00.000Z'),
      }),
    // Embeds first (deterministic, no database), then reads `rag_chunks`.
    retrieval: (m) =>
      m.retrieval.service.search('photosynthesis', { grade: '8', subject: 'science' }),
    // Loads the session from foxy's OWN repository before it authorises — unlike
    // `listSessions`, which resolves the tenant through identity first.
    foxy: (m) => m.foxy.service.getTranscript(ACTOR, '55555555-5555-4555-8555-555555555555'),
  },
);

function requirePayments(): FakePayments {
  if (payments === undefined) throw new Error('the container was not built for this case');
  return payments;
}

const MODULE_NAMES = Object.keys(MODULE_POOLS) as readonly ModuleName[];

describe('buildModules hands each module the handle issued in ITS OWN name', () => {
  it.each(MODULE_NAMES)('%s reaches for its own handle first', async (module) => {
    const touched: HandleTag[] = [];
    const modules = buildModules(withTaggedHandles(makeContainer(), touched));

    await DRIVERS[module](modules).catch(() => undefined);

    // Under the audit's mutation — `poolFor('foxy')` becoming
    // `poolFor('identity')` — foxy reports `identity` here and this case is the
    // one that goes red.
    expect({ module, reached: touched[0] }).toEqual({ module, reached: module });
  });

  it.each(MODULE_NAMES)('%s is on the worker pool in the worker process', async (module) => {
    /**
     * §3.1: "digests must never compete with live traffic". `forWorker` swaps
     * the handle for every module at once, and the failure mode of missing one
     * is invisible — that module simply competes with live traffic forever.
     */
    const touched: HandleTag[] = [];
    const modules = buildModules(withTaggedHandles(makeContainer(), touched), { forWorker: true });

    await DRIVERS[module](modules).catch(() => undefined);

    expect({ module, reached: touched[0] }).toEqual({ module, reached: 'worker' });
  });
});

describe('buildModules asks for every module’s pool BY NAME', () => {
  it('requests all eleven module names', () => {
    /**
     * The cheaper half of the same proof. `buildModules` obtains a pool ONLY
     * through `poolFor(<module>)`, so the names it passes are a complete
     * statement of what it asked for; the mutation shows up as `foxy` never
     * being asked for at all, with no module needing to be driven.
     *
     * Asserted as a SET rather than a sequence: `notify` legitimately asks
     * twice (the module and its write-through preferences store), and pinning
     * the multiset would turn a second, correct call into a failure.
     */
    const asked: ModuleName[] = [];
    const real = makeContainer();
    const spied: Container = {
      ...real,
      poolFor: (module: ModuleName): NamedDbHandle => {
        asked.push(module);
        return real.poolFor(module);
      },
    };

    buildModules(spied);

    expect([...new Set(asked)].sort()).toEqual([...MODULE_NAMES].sort());
  });

  it('resolves every module name to the pool MODULE_POOLS assigns', () => {
    // So the table and `poolFor` cannot disagree — the lookup is the only
    // source of the assignment, which is what makes the table worth reading.
    const built = makeContainer();
    for (const module of MODULE_NAMES) {
      expect({ module, pool: built.poolFor(module).name }).toEqual({
        module,
        pool: MODULE_POOLS[module],
      });
    }
  });
});
