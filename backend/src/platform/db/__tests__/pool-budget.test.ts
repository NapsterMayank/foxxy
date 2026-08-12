import { describe, expect, it } from 'vitest';
import { poolBudgetTotal, resolvePoolSizes } from '../pool-budget';
import type { DbPoolSizes } from '../pools';

/**
 * =============================================================================
 * THE PER-PROCESS CONNECTION BUDGET — D-228.
 *
 * WHAT WAS WRONG. `pools.ts` carried the sentence "44 total, comfortably inside
 * a default `max_connections` of 100 with room for administrative access". 44
 * is ONE process's sum, and there are two: `main.ts` and `worker-main.ts` both
 * call `createContainer`, which both calls `createDbPools`, which builds all
 * four pools in each. So a single-replica deployment held 88 of 100 before
 * anything went wrong, and a rolling api deploy — which by construction runs
 * the old and the new process at once — held 132.
 *
 * Crossing `max_connections` does not present as one slow module. It is
 * `FATAL: sorry, too many clients already` on every checkout in every pool at
 * the same instant, plus a `psql` that cannot connect to diagnose it. The
 * bulkheads are perfect and the product is down — the exact failure §3.1 exists
 * to prevent, arrived at from the server side.
 *
 * `DATABASE_POOL_MAX` was also parsed and read by nothing at all.
 *
 * These are arithmetic assertions on a pure function on purpose. The thing that
 * was wrong before was ARITHMETIC IN A COMMENT, and a comment cannot be tested.
 * =============================================================================
 */

/** The configured defaults: what §3.1's table asks for, before any trimming. */
const REQUESTED: DbPoolSizes = { auth: 10, core: 20, ai: 8, worker: 6 };

/** `DATABASE_POOL_MAX`'s default. */
const CEILING = 40;

describe('role awareness — each process opens only what it can use', () => {
  it('caps the api process on the WORKER pool, which it only enqueues onto', () => {
    // An api never claims a job. It writes one indexed INSERT per enqueue and
    // one buffered multi-row insert from the metrics sink. Six connections were
    // reserved for work this process is structurally incapable of doing.
    const sizes = resolvePoolSizes(REQUESTED, 'api', CEILING);

    expect(sizes.worker).toBe(2);
    expect(sizes.auth).toBe(10);
    expect(sizes.core).toBe(20);
    expect(sizes.ai).toBe(8);
  });

  it('caps the worker process on AUTH and CORE, which it barely touches', () => {
    // The worker holds no sessions and serves no login, and
    // `buildModules({ forWorker: true })` puts every repository on
    // `pools.worker`. Ten auth connections sized for login concurrency are dead
    // weight in a process that never authenticates anybody.
    const sizes = resolvePoolSizes(REQUESTED, 'worker', CEILING);

    expect(sizes.auth).toBe(2);
    expect(sizes.core).toBe(4);
    expect(sizes.worker).toBe(6);
  });

  it('does NOT cap `ai` in the worker — starving it is a silent quality loss', () => {
    // Retrieval runs on `pools.worker` in this process today, but a future job
    // that embeds or searches would go through `ai`, and a starved vector pool
    // presents as slow, thin results rather than as a failure.
    expect(resolvePoolSizes(REQUESTED, 'worker', CEILING).ai).toBe(8);
  });

  it('makes the two roles sum to less than two full profiles — the actual defect', () => {
    // The number that mattered: 40 + 20 = 60 of a default max_connections of
    // 100, leaving room for psql and for a rolling deploy's overlap. Before the
    // role profiles existed it was 44 + 44 = 88 with one replica of each.
    const api = poolBudgetTotal(resolvePoolSizes(REQUESTED, 'api', CEILING));
    const worker = poolBudgetTotal(resolvePoolSizes(REQUESTED, 'worker', CEILING));

    expect(api).toBe(40);
    expect(worker).toBe(20);
    expect(api + worker).toBeLessThan(88);
  });
});

describe('the ceiling is enforced, not documented', () => {
  it('never opens more than DATABASE_POOL_MAX across all four pools', () => {
    // The property `DATABASE_POOL_MAX` was supposed to have and did not, being
    // parsed and read by nothing. Swept across every plausible setting rather
    // than asserted at one, because a budget that holds at 40 and not at 17 is
    // not a budget.
    for (let ceiling = 4; ceiling <= 100; ceiling += 1) {
      for (const role of ['api', 'worker'] as const) {
        const total = poolBudgetTotal(resolvePoolSizes(REQUESTED, role, ceiling));
        expect(total).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('scales PROPORTIONALLY, preserving the §3.1 ratios', () => {
    // The ratios between the four pools ARE the policy: `auth` must never be
    // starved, `ai` must stay capped relative to the others. Taking the excess
    // off the biggest pool would silently rewrite that policy at whichever
    // ceiling an operator happened to pick.
    const sizes = resolvePoolSizes(REQUESTED, 'api', 20);

    expect(poolBudgetTotal(sizes)).toBeLessThanOrEqual(20);
    expect(sizes.core).toBeGreaterThan(sizes.auth);
    expect(sizes.auth).toBeGreaterThan(sizes.ai);
    expect(sizes.ai).toBeGreaterThanOrEqual(sizes.worker);
  });

  it('never floors a pool to zero, at any ceiling', () => {
    // A pool with no connections is not a smaller bulkhead, it is a module that
    // cannot run — and it presents as an unexplained hang rather than as a
    // misconfiguration.
    for (let ceiling = 1; ceiling <= 100; ceiling += 1) {
      const sizes = resolvePoolSizes(REQUESTED, 'api', ceiling);
      expect(Math.min(sizes.auth, sizes.core, sizes.ai, sizes.worker)).toBeGreaterThanOrEqual(1);
    }
  });

  it('leaves a set that already fits completely untouched', () => {
    // The ceiling must not be a tax on a correctly-sized deployment.
    const small: DbPoolSizes = { auth: 2, core: 2, ai: 2, worker: 2 };
    expect(resolvePoolSizes(small, 'api', 100)).toEqual(small);
  });
});

describe('the result is frozen', () => {
  it('cannot be mutated by a caller after the budget has been decided', () => {
    // The whole point is that one function decides. A caller that could adjust
    // a pool afterwards would be a second place for the ceiling to be forgotten.
    const sizes = resolvePoolSizes(REQUESTED, 'api', CEILING);
    expect(Object.isFrozen(sizes)).toBe(true);
  });
});
