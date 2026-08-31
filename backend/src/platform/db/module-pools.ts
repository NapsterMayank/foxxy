import type { DbPools, NamedDbHandle, PoolName } from './pools';

/**
 * WHICH MODULE GETS WHICH CONNECTION POOL — 04-RESILIENCE-PLAN.md §3.1.
 *
 * §3.1 states the assignment in a table in a document. A table in a document
 * is not a bulkhead; it is a hope. This file is the same table as code, so the
 * assignment is looked up rather than remembered, and a module added without a
 * pool fails to compile instead of silently inheriting somebody else's.
 *
 * The table, and why each row is what it is:
 *
 *   auth   | identity                | Must never be starved. If login fails
 *          |                         | the product is down regardless of what
 *          |                         | else works.
 *   core   | learner content practice| Ordinary request traffic.
 *          | parent billing notify   |
 *          | knowledge signals       |
 *   ai     | retrieval foxy          | Vector search is expensive and spiky.
 *          |                         | Capped so it CANNOT exhaust the others.
 *   worker | (background jobs)       | Digests must never compete with live
 *          |                         | traffic. Reached through `pools.worker`
 *          |                         | from the worker entry point, not from a
 *          |                         | module.
 *
 * THE CONCRETE FAILURE THIS PREVENTS: `retrieval` and `content` both read
 * `rag_chunks`. If retrieval were handed `core` because that is where the
 * table's owner lives, a slow HNSW scan under load would hold `core`
 * connections, and a chapter listing — then a progress screen, then everything
 * — would queue behind vector search. The pool follows the CALLER's cost
 * profile, not the table's owner. That is the one thing about §3.1 that is
 * easy to get backwards.
 */

export type ModuleName =
  | 'identity'
  | 'learner'
  | 'content'
  | 'practice'
  | 'parent'
  | 'billing'
  | 'notify'
  | 'knowledge'
  | 'signals'
  | 'retrieval'
  | 'foxy'
  | 'admin';

/**
 * Exhaustive by construction: `Record<ModuleName, PoolName>` means adding a
 * module to the union without adding it here is a type error, and no module
 * can be wired up with its bulkhead missing.
 */
export const MODULE_POOLS: Readonly<Record<ModuleName, PoolName>> = Object.freeze({
  identity: 'auth',

  learner: 'core',
  content: 'core',
  practice: 'core',
  parent: 'core',
  billing: 'core',
  notify: 'core',

  /**
   * `knowledge` FOLLOWS `content`, and `signals` FOLLOWS `practice` — the two
   * modules whose tables they read.
   *
   * Both are small indexed reads (a chapter's concepts, a student's recent
   * sessions), so the pool that carries the read they sit next to is the one
   * whose cost profile they share. That is NOT the same rule as "the table's
   * owner": `retrieval` reads `content`'s `rag_chunks` and still gets `ai`,
   * because a slow HNSW scan has nothing in common with a chapter listing.
   * Here the profiles genuinely do match, which is why the answer coincides.
   */
  knowledge: 'core',
  signals: 'core',

  retrieval: 'ai',
  foxy: 'ai',

  /**
   * `admin` GETS `core`, AND THE OBVIOUS ALTERNATIVE IS FORBIDDEN FOR A REASON.
   *
   * By cost profile alone it does not belong here: the overview is nine
   * `count(*)` over whole tables and the metrics screen sums a window of
   * `metrics_events`, all of it refreshed by an operator during exactly the
   * incident when `core` has least to spare. `worker` looked like the answer.
   *
   * IT IS NOT AVAILABLE. `worker` is reached from the worker ENTRY POINT, not
   * from a module — a module on it would be live traffic competing with
   * background jobs, which is the thing §3.2 separates the processes to avoid,
   * and `module-pools.test.ts` asserts no module is on it.
   *
   * So `core` it is, knowingly. If an admin screen is ever measured starving
   * learner traffic the fix is a real `ops` pool with its own budget and role
   * caps — a change to `pool-budget.ts` and the config schema, which is an ADR
   * and not a one-line edit to this table.
   */
  admin: 'core',
});

/**
 * The pool a module's repositories must be given.
 *
 * Called at the composition root. A module never chooses its own pool — a
 * module that could choose would eventually choose `auth`, "just for this one
 * quick query", and the bulkhead §3.1 exists for would be gone.
 */
export function poolFor(pools: DbPools, module: ModuleName): NamedDbHandle {
  return pools[MODULE_POOLS[module]];
}
