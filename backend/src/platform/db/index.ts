/**
 * platform/db — the database port.
 *
 * Reachable only from `*.repository.ts` files (and from platform itself),
 * enforced by a `no-restricted-imports` rule. Without that rule someone
 * eventually writes a query that skips the authorization check.
 *
 * The database is NEVER faked. Service and integration tests run against a
 * real Postgres in a container (§9.1).
 *
 * Two entry points, and the choice matters:
 *  - `createDbPools` — the four bulkheaded pools (§3.1). What the application
 *    uses. A repository receives the pool its module is assigned.
 *  - `createDb` — one unnamed pool. For migrations, scripts and tests, where
 *    there is a single caller and nothing to isolate it from.
 */
export { createDb } from './client';
export type { Database, DbHandle, DbConfig, DbExecutor } from './client';
/**
 * D-056 — the opaque executor a service may carry across a module boundary.
 *
 * The TOKEN type lives in `platform/tx` (which modules may import); these two
 * functions, which are the only way to turn a token back into something that
 * can run a statement, live here, where only a repository may reach them.
 */
export { wrapExecutor, unwrapExecutor } from './transaction-token';
export { createDbPools, POOL_NAMES } from './pools';
export type {
  DbPools,
  DbPoolSizes,
  DbPoolStats,
  DbPoolsConfig,
  NamedDbHandle,
  PoolName,
} from './pools';
export { MODULE_POOLS, poolFor } from './module-pools';
export type { ModuleName } from './module-pools';
export { createDatabaseProbe } from './health';
export type { DatabaseHealth, DatabaseProbe } from './health';
export { citext, vector } from './column-types';
export * as schema from './schema/index';
