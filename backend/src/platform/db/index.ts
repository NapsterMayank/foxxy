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
