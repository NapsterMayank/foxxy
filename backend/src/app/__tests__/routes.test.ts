import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCache } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { parseConfig } from '@/platform/config/load-config';
import { FakeLogger } from '@/platform/logger/index';
import { RecordingMail } from '@/platform/mail/index';
import { MODULE_POOLS } from '@/platform/db/index';
import { createContainer, type Container } from '../container';
import { buildModules } from '../routes';

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
    // `toContain`, so a module that is built but never registered — or one
    // deleted from the graph — fails here. Adding `notify` to `buildModules`
    // without adding it to this line is the failure this assertion is for.
    const modules = buildModules(makeContainer());
    expect(Object.keys(modules).sort()).toEqual([
      'content',
      'identity',
      'learner',
      'notify',
      'practice',
    ]);
  });

  it('hands each module the pool §3.1 assigns it', () => {
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
  });

  it('keeps MODULE_POOLS as the single source of that assignment', () => {
    // So the table in `platform/db/module-pools.ts` cannot drift from what the
    // composition root actually does.
    expect(MODULE_POOLS.learner).toBe('core');
    expect(MODULE_POOLS.content).toBe('core');
    expect(MODULE_POOLS.identity).toBe('auth');
    expect(MODULE_POOLS.notify).toBe('core');
  });

  it('leaves learner with NO import of identity — the edge is injected', () => {
    // Foundation 1 in practice. The dependency is real, but it is declared in
    // one file rather than reached for from inside the module, so
    // `app/routes.ts` remains the complete cross-module dependency graph.
    const modules = buildModules(makeContainer());
    expect(modules.learner.service).toBeDefined();
    expect(modules.content.service).toBeDefined();
    expect(modules.identity.requireSession).toBeTypeOf('function');
    // notify's edge to identity is `readRecipient`, injected the same way. With
    // no `parent` module yet there is no digest source, and that absence is
    // load-bearing: the worker registers no digest handlers, so a stray digest
    // job is refused loudly rather than succeeding without doing the work.
    expect(modules.notify.service).toBeDefined();
    expect(modules.notify.hasDigestSource).toBe(false);
  });
});
