import type { DbPoolSizes, PoolName } from './pools';

/**
 * THE PER-PROCESS CONNECTION BUDGET — D-228.
 *
 * ===========================================================================
 * WHAT THE ARITHMETIC USED TO SAY, AND WHY IT WAS WRONG.
 *
 * `pools.ts` carried this sentence: "44 total, comfortably inside a default
 * `max_connections` of 100 with room for administrative access."
 *
 * 44 is one process's sum. There are TWO processes. `src/main.ts` and
 * `src/worker-main.ts` both call `createContainer`, which both calls
 * `createDbPools`, which builds all four pools in each — so a single-replica
 * deployment held 88 of 100 before anything went wrong, and a rolling deploy,
 * which by construction runs the old and new api at once, held 132. The
 * symptom of crossing `max_connections` is not one slow module: it is
 * `FATAL: sorry, too many clients already` on every checkout in every pool
 * simultaneously, plus a `psql` that cannot connect to diagnose it. The
 * bulkheads are perfect and the product is down, which is the exact failure
 * §3.1 exists to prevent, arrived at from the server side.
 *
 * ===========================================================================
 * TWO CORRECTIONS.
 *
 * 1. ROLE AWARENESS. An api process never claims a job — it only ENQUEUES —
 *    so it does not need six worker connections; it needs enough for one
 *    indexed insert and the metrics sink. A worker process serves no requests,
 *    so it does not need ten auth connections sized for login concurrency. The
 *    caps below are not a tuning preference, they are what each role can
 *    actually use.
 *
 * 2. AN ENFORCED CEILING. `DATABASE_POOL_MAX` was parsed and read by nothing.
 *    It is now the ceiling this process may open across all four pools, and
 *    `resolvePoolSizes` scales the whole set down proportionally when the role
 *    profile still exceeds it. A budget that is checked is a budget; a budget
 *    in a comment is a wish, and the comment above is what a wish looks like
 *    eighteen months later.
 *
 * ===========================================================================
 * TOTAL ACROSS REPLICAS IS STILL THE OPERATOR'S SUM. It cannot be enforced from
 * inside one process, so it is stated where it can be checked:
 *
 *     api_replicas x api_budget  +  worker_replicas x worker_budget
 *       + headroom for psql and for a rolling deploy's overlap
 *       <=  the server's max_connections
 *
 * At the defaults (`DATABASE_POOL_MAX=40`): api 40, worker 20. One of each is
 * 60 of 100. A rolling api deploy briefly makes that 100 — which is why the
 * ceiling is a variable and why this paragraph exists.
 */

export type ProcessRole = 'api' | 'worker';

/**
 * What each role may hold per pool, before the ceiling is applied.
 *
 * `null` means "no role cap — take what is configured". A number is a hard cap
 * on a pool this role barely uses.
 */
const ROLE_CAPS: Readonly<Record<ProcessRole, Readonly<Record<PoolName, number | null>>>> = {
  /**
   * The api enqueues jobs and writes metrics on `worker`, and does neither in
   * request volume: an enqueue is one indexed INSERT and the metrics sink
   * writes one buffered multi-row insert at a time. Two connections is
   * generous for both, and every connection above that was reserved for work
   * this process is structurally incapable of doing.
   */
  api: { auth: null, core: null, ai: null, worker: 2 },
  /**
   * The worker holds no sessions and serves no login. It touches `auth` only
   * through the expired-session sweeper and `core` not at all in request
   * shape — `buildModules({ forWorker: true })` puts every repository on
   * `pools.worker`. Both are capped to what a background sweep needs.
   *
   * `ai` is NOT capped: retrieval runs on `pools.worker` in this process, but
   * a future job that embeds or searches would go through `ai`, and starving
   * it would be a silent quality regression rather than a loud failure.
   */
  worker: { auth: 2, core: 4, ai: null, worker: null },
};

const POOL_ORDER: readonly PoolName[] = ['auth', 'core', 'ai', 'worker'];

function applyRoleCaps(requested: DbPoolSizes, role: ProcessRole): Record<PoolName, number> {
  const caps = ROLE_CAPS[role];
  const sizes: Record<PoolName, number> = { auth: 0, core: 0, ai: 0, worker: 0 };
  for (const name of POOL_ORDER) {
    const cap = caps[name];
    sizes[name] = cap === null ? requested[name] : Math.min(requested[name], cap);
  }
  return sizes;
}

function total(sizes: Record<PoolName, number>): number {
  return POOL_ORDER.reduce((sum, name) => sum + sizes[name], 0);
}

/**
 * Scales every pool down until the sum fits, never below one connection.
 *
 * PROPORTIONAL rather than "take it off the biggest", because the ratios
 * between the four pools ARE the §3.1 policy — `auth` must never be starved,
 * `ai` must stay capped relative to the others. Reducing one pool to fit would
 * silently rewrite that policy at whichever ceiling an operator happened to
 * pick.
 *
 * A floor of one, because a pool with zero connections is not a smaller
 * bulkhead, it is a module that cannot run at all, and it would present as an
 * unexplained hang rather than as a misconfiguration.
 */
function scaleToCeiling(sizes: Record<PoolName, number>, ceiling: number): Record<PoolName, number> {
  const current = total(sizes);
  if (current <= ceiling) return sizes;

  const ratio = ceiling / current;
  const scaled: Record<PoolName, number> = { auth: 0, core: 0, ai: 0, worker: 0 };
  for (const name of POOL_ORDER) {
    scaled[name] = Math.max(1, Math.floor(sizes[name] * ratio));
  }

  // Flooring can still leave the sum above the ceiling when every pool floors
  // to 1 and there are more pools than connections. Shave the largest first,
  // which preserves the ordering the ratios expressed.
  let remaining = total(scaled) - ceiling;
  while (remaining > 0) {
    const largest = POOL_ORDER.reduce((a, b) => (scaled[a] >= scaled[b] ? a : b));
    if (scaled[largest] <= 1) break;
    scaled[largest] -= 1;
    remaining -= 1;
  }
  return scaled;
}

/**
 * The requested sizes, trimmed by role and then fitted inside the ceiling.
 *
 * Pure and exported so the budget can be asserted directly. The thing that was
 * wrong before was arithmetic in a comment; arithmetic in a comment cannot be
 * tested, and this can.
 */
export function resolvePoolSizes(
  requested: DbPoolSizes,
  role: ProcessRole,
  ceiling: number,
): DbPoolSizes {
  const scaled = scaleToCeiling(applyRoleCaps(requested, role), ceiling);
  return Object.freeze({
    auth: scaled.auth,
    core: scaled.core,
    ai: scaled.ai,
    worker: scaled.worker,
  });
}

/** The sum a single process of this role will hold. For reporting and tests. */
export function poolBudgetTotal(sizes: DbPoolSizes): number {
  return sizes.auth + sizes.core + sizes.ai + sizes.worker;
}
