import { describe, expect, it } from 'vitest';
import { MODULE_POOLS, poolFor, type ModuleName } from '../module-pools';
import type { DbPools, NamedDbHandle, PoolName } from '../pools';

/**
 * The pool assignment in 04-RESILIENCE-PLAN.md §3.1, asserted.
 *
 * §3.1 calls connection-pool separation "the highest-value isolation", and its
 * value is entirely in the assignment being RIGHT. A module wired to the wrong
 * pool does not fail — it works perfectly until the day load arrives, and then
 * it takes down whatever else shares that pool. There is no way to notice by
 * running the application, so it is asserted here instead.
 */

function fakePools(): DbPools {
  const handle = (name: PoolName): NamedDbHandle =>
    ({ name, max: 1 }) as unknown as NamedDbHandle;

  const auth = handle('auth');
  const core = handle('core');
  const ai = handle('ai');
  const worker = handle('worker');

  return {
    auth,
    core,
    ai,
    worker,
    all: () => [auth, core, ai, worker],
    stats: () => [],
    close: () => Promise.resolve(),
  };
}

describe('MODULE_POOLS — the §3.1 table', () => {
  it('gives identity the auth pool, which must never be starved', () => {
    // "If login fails, the product is down regardless of what else works."
    expect(poolFor(fakePools(), 'identity').name).toBe('auth');
  });

  it('gives retrieval and foxy the ai pool', () => {
    // Vector search is expensive and spiky, and is capped so it CANNOT
    // exhaust the others.
    const pools = fakePools();
    expect(poolFor(pools, 'retrieval').name).toBe('ai');
    expect(poolFor(pools, 'foxy').name).toBe('ai');
  });

  it('gives learner, content and practice the core pool', () => {
    const pools = fakePools();
    expect(poolFor(pools, 'learner').name).toBe('core');
    expect(poolFor(pools, 'content').name).toBe('core');
    expect(poolFor(pools, 'practice').name).toBe('core');
  });

  it('puts NO module on the worker pool', () => {
    // `worker` is reached from the worker entry point, not from a module. A
    // module on the worker pool would be a background job competing with live
    // traffic, which is the exact thing §3.2 separates the processes to avoid.
    expect(Object.values(MODULE_POOLS)).not.toContain('worker');
  });

  it('does NOT put retrieval on core just because content owns rag_chunks', () => {
    // The trap. `retrieval` and `content` read the same table, so following
    // the table's owner would put a slow HNSW scan on the pool that serves
    // chapter listings and progress screens. The pool follows the CALLER's
    // cost profile, not the table's owner.
    expect(MODULE_POOLS.retrieval).not.toBe(MODULE_POOLS.content);
  });

  it('assigns a pool to every module, with nothing left unbulkheaded', () => {
    const modules: ModuleName[] = [
      'identity',
      'learner',
      'content',
      'practice',
      'parent',
      'billing',
      'notify',
      // `knowledge` follows `content` and `signals` follows `practice` — the
      // modules whose tables they read and whose cost profile they share.
      // Neither has an HTTP surface, and neither is exempt from needing a
      // bulkhead for it: an in-process caller can saturate a pool exactly as a
      // request can.
      'knowledge',
      'signals',
      'retrieval',
      'foxy',
    ];
    for (const module of modules) {
      expect(MODULE_POOLS[module]).toBeDefined();
    }
    expect(Object.keys(MODULE_POOLS)).toHaveLength(modules.length);
  });

  it('is frozen, so nothing can repoint a module at runtime', () => {
    expect(Object.isFrozen(MODULE_POOLS)).toBe(true);
  });
});
