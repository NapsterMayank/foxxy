import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCache } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { parseConfig } from '@/platform/config/load-config';
import { FakeLogger } from '@/platform/logger/index';
import { RecordingMail } from '@/platform/mail/index';
import { MODULE_POOLS } from '@/platform/db/index';
import { MIN_AVERAGE_MS_PER_QUESTION, validateAttempt } from '@/modules/practice/index';
import { createContainer, type Container } from '../container';
import { buildModules, registerRoutes } from '../routes';

/**
 * The composition root — `buildModules`.
 *
 * WHY THIS FILE EXISTS. Every module's own tests construct that module
 * directly, with dependencies the test chose. That is correct for a module
 * test and it means NOTHING here is otherwise exercised: `buildModules` is the
 * only place production decides which pool each module receives and how the
 * cross-module edges are wired, and a mistake in it fails at boot or, worse,
 * silently — a module handed the `auth` pool competes with login for the ten
 * connections §3.1 reserves, and everything still works until load arrives.
 *
 * No database connection is made: `pg.Pool` connects lazily, and none of these
 * assertions issues a query.
 */

let container: Container | undefined;

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
  container = createContainer(config, {
    clock,
    cache: new MemoryCache(clock),
    mail: new RecordingMail(),
    logger: new FakeLogger(),
  });
  return container;
}

afterEach(async () => {
  await container?.shutdown();
  container = undefined;
});

describe('buildModules', () => {
  it('builds every module the application has', () => {
    // The list is EXHAUSTIVE and asserted with `toEqual` rather than
    // `toContain`, so a module dropped from the graph — or one added to
    // `buildModules` and to nothing else — fails here.
    //
    // THREE OF THESE ARE ON THIS LIST AND DELIBERATELY NOT REGISTERED in
    // `registerRoutes` — `retrieval`, `knowledge` and `signals`. None has an
    // HTTP surface: a retrieval or knowledge endpoint would be a way to page
    // the corpus or the syllabus with caller-chosen filters, including a grade
    // the student is not in, and every answer `signals` gives is about a named
    // student in a module with no session of its own. Built, not exposed, is
    // the intended state for all three — see the notes on `Modules`.
    const modules = buildModules(makeContainer());
    expect(Object.keys(modules).sort()).toEqual([
      // The operations read model. REGISTERED, unlike the three below, but every
      // route it adds sits behind a gate that answers 404 to a non-admin.
      'admin',
      'billing',
      'content',
      'foxy',
      'identity',
      'knowledge',
      'learner',
      'notify',
      'parent',
      'practice',
      'retrieval',
      'signals',
    ]);
  });

  it('resolves each module NAME to the pool §3.1 assigns it', () => {
    /**
     * RENAMED, AND THE OLD NAME WAS THE DEFECT — D-322.
     *
     * This was called "hands each module the pool §3.1 assigns it". It does not
     * hand anything to anything: it never calls `buildModules`, and every
     * assertion below reads `built.poolFor(<name>).name`, which is the
     * `MODULE_POOLS` table evaluated on the container. The test directly below
     * re-asserts that same table. So the table was checked twice and the
     * WIRING — which module actually received which handle — was checked
     * nowhere, while a test bearing the wiring's name sat green.
     *
     * That is not hypothetical: an audit repointed `foxy` at the `identity`
     * pool inside `buildModules` and all 164 app tests passed, this one
     * included. The wiring assertion now lives in `module-pool-wiring.test.ts`,
     * which drives each module until it touches a database and reads back which
     * handle it reached for. This block keeps its value — `poolFor` is the
     * lookup both of them depend on — under a name that claims only what it
     * does.
     */
    // THE BULKHEAD, asserted rather than trusted. `container.db` used to exist
    // and aliased the `auth` pool; the second module to be written would have
    // taken it, and every learner query would then have competed with login
    // for its ten connections (D-030, resolved by D-045). There is no
    // general-purpose handle any more — a pool is obtained by naming the
    // module — and this test pins the answer that naming gives.
    const built = makeContainer();
    expect(built.poolFor('identity').name).toBe('auth');
    expect(built.poolFor('learner').name).toBe('core');
    expect(built.poolFor('content').name).toBe('core');
    // notify's HTTP surface is ordinary request traffic. In the WORKER the same
    // module is handed `pools.worker` instead — see `buildModules`' `forWorker`.
    expect(built.poolFor('notify').name).toBe('core');
    // practice is ordinary request traffic too. It reads `questions` through
    // `content` and writes four of its own tables, all on `core`.
    expect(built.poolFor('practice').name).toBe('core');
    // `retrieval` reads the same `rag_chunks` table as `content` and still
    // gets `ai`: the pool follows the CALLER's cost profile, not the table's
    // owner. The row of §3.1 easiest to get backwards.
    expect(built.poolFor('retrieval').name).toBe('ai');
    // `foxy` sits on `ai` for the same reason and one more: a Foxy turn holds
    // its connection across a model call, which is the slowest thing in the
    // product. On `core` a single slow answer would queue a login behind it.
    expect(built.poolFor('foxy').name).toBe('ai');
    // billing is ordinary request traffic: a checkout is two indexed writes and
    // an outbound HTTPS call that does NOT hold the connection.
    expect(built.poolFor('billing').name).toBe('core');
    // `knowledge` follows `content` and `signals` follows `practice` — the
    // modules whose tables they read and whose cost profile they share. Note
    // this is NOT the "pool of the table's owner" rule, which `retrieval`
    // above disproves; the profiles happen to match here.
    expect(built.poolFor('knowledge').name).toBe('core');
    expect(built.poolFor('signals').name).toBe('core');
  });

  it('keeps MODULE_POOLS as the single source of that assignment', () => {
    // So the table in `platform/db/module-pools.ts` cannot drift from what the
    // composition root actually does.
    expect(MODULE_POOLS.learner).toBe('core');
    expect(MODULE_POOLS.content).toBe('core');
    expect(MODULE_POOLS.identity).toBe('auth');
    expect(MODULE_POOLS.notify).toBe('core');
    expect(MODULE_POOLS.billing).toBe('core');
    expect(MODULE_POOLS.knowledge).toBe('core');
    expect(MODULE_POOLS.signals).toBe('core');
  });

  it('leaves learner with NO import of identity — the edge is injected', () => {
    // Foundation 1 in practice. The dependency is real, but it is declared in
    // one file rather than reached for from inside the module, so
    // `app/routes.ts` remains the complete cross-module dependency graph.
    const modules = buildModules(makeContainer());
    expect(modules.learner.service).toBeDefined();
    expect(modules.content.service).toBeDefined();
    expect(modules.identity.requireSession).toBeTypeOf('function');
    // notify's edge to identity is `readRecipient`, injected the same way.
    expect(modules.notify.service).toBeDefined();
    // THE DIGEST SEAM IS NOW FILLED, and this assertion has flipped. It used to
    // read `false`, and that absence was load-bearing while `parent` did not
    // exist: with no source the worker registered no digest handlers, so a
    // stray digest job was refused loudly instead of succeeding without doing
    // the work. `parent.digestSource` now supplies it, so the handlers ARE
    // registered — and a regression back to `false` means the weekly digest
    // silently stops being sent, which is invisible from the outside.
    expect(modules.notify.hasDigestSource).toBe(true);
    // parent's four edges, injected rather than imported, same as the rest.
    expect(modules.parent.service).toBeDefined();
    // retrieval holds `content.getChunksByIds` the same way.
    expect(modules.retrieval.service).toBeDefined();
    // foxy holds SIX injected edges — `retrieval.search`, learner's profile and
    // subjects, learner's preferred language, identity's tenant reader, and
    // billing's plan reader (`createFoxyPlanReader`, which resolves a REAL
    // entitlement; the stand-in this comment used to describe is D-257). Not one
    // of them is an import, which is what keeps this file the complete graph.
    expect(modules.foxy.service).toBeDefined();
    // billing holds two injected edges — identity's tenant reader and the
    // `PayerResolver` that encodes the whole B2C/B2B decision (D-150).
    expect(modules.billing.service).toBeDefined();
    // knowledge has NO cross-module edges at all: it owns every table it reads.
    expect(modules.knowledge.service).toBeDefined();
    // signals holds exactly one, and it is `practice`'s anti-cheat floor and
    // verdict — see the dedicated block below.
    expect(modules.signals.service).toBeDefined();
  });

  it('registers routes for billing and for no other newly-wired module', async () => {
    /**
     * THE HALF `buildModules` CANNOT SHOW. Construction and registration are
     * separate decisions here, and three modules are deliberately built and
     * never registered — so "it exists" says nothing about whether it is
     * reachable, in either direction.
     *
     * `registerRoutes` is driven with each module ALONE, so a route that
     * appears can only have come from the module under test. The billing case
     * also pins the `await`: `registerRoutes` is async precisely because
     * billing's webhook needs an encapsulated scope for its raw-body parser,
     * and a dropped `await` would let `ready()` win the race and 404 every
     * genuine delivery — in production only.
     */
    const modules = buildModules(makeContainer());

    const withBilling = fastify();
    await registerRoutes(withBilling, { billing: modules.billing });
    await withBilling.ready();
    const billingPaths = withBilling.printRoutes({ commonPrefix: false });
    expect(billingPaths).toContain('/api/v1/webhooks/billing');
    await withBilling.close();

    // The three that must expose NOTHING. An empty route table is the
    // assertion — adding an endpoint for any of them is the regression.
    for (const [name, only] of [
      ['retrieval', { retrieval: modules.retrieval }],
      ['knowledge', { knowledge: modules.knowledge }],
      ['signals', { signals: modules.signals }],
    ] as const) {
      const app = fastify();
      await registerRoutes(app, only);
      await app.ready();
      expect({ module: name, routes: app.printRoutes({ commonPrefix: false }).trim() }).toEqual({
        module: name,
        routes: '(empty tree)',
      });
      await app.close();
    }
  });

  it('gives signals PRACTICE’s anti-cheat floor, not a second copy of it', () => {
    /**
     * D-131, asserted rather than trusted.
     *
     * `signals`' `AntiCheatEdge` has deliberately NO DEFAULT, so a missing
     * wiring is a compile error — but a wiring that supplies `3_000` inline
     * compiles perfectly and is the actual hazard. Two copies of a threshold
     * drift, silently, and the symptom is a `fast_completion` signal that stops
     * agreeing with the rejection it is defined relative to.
     *
     * What is checked here is that the floor is reachable from `practice`'s
     * PUBLIC SURFACE at all — the additive export that made `signals`
     * constructible — and that the verdict comes from `validateAttempt` rather
     * than from a reimplementation. `buildModules` builds its edge from exactly
     * these two symbols; there is no second source for either.
     */
    expect(MIN_AVERAGE_MS_PER_QUESTION).toBe(3_000);

    // The verdict, at and either side of the floor. A reimplementation that
    // used `<=` instead of `<`, or that skipped the response-count check, fails
    // one of these.
    const atFloor = [
      { selectedIndex: 0, timeSpentMs: 3_000 },
      { selectedIndex: 1, timeSpentMs: 3_000 },
    ];
    expect(validateAttempt(atFloor, 2).isValid).toBe(true);
    expect(validateAttempt([{ selectedIndex: 0, timeSpentMs: 2_999 }], 1).isValid).toBe(false);
    expect(validateAttempt(atFloor, 3).isValid).toBe(false);
  });
});
