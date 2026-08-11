import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index';

export type Database = NodePgDatabase<typeof schema>;

/**
 * A transaction handle. Structurally the same surface as `Database`, so a
 * repository method can accept either and callers need not care whether they
 * are already inside a transaction.
 */
export type DbExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DbConfig {
  readonly url: string;
  readonly poolMax: number;
  readonly ssl: boolean;
  /**
   * The provider's CA, PEM. Optional so a test or script that builds a config
   * by hand is not obliged to state it; absent means Node's trust store.
   */
  readonly sslCa?: string | null;
  /**
   * TLS with certificate verification DISABLED — D-238.
   *
   * This file used to do that unconditionally whenever `ssl` was on, exactly as
   * `pools.ts` did. `createDb` is what the MIGRATION RUNNER uses, so the
   * connection carrying schema changes and the full database credential was the
   * one with no certificate check at all. Verification is on by default now and
   * this is the explicit, named opt-out.
   */
  readonly sslInsecure?: boolean;
}

export interface DbHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
  /**
   * Runs `fn` inside a single transaction. It commits when `fn` resolves and
   * rolls back on any throw. Nothing partial ever lands.
   */
  withTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** See `DbConfig.sslInsecure`. Verification is the default; opting out is named. */
function sslOptions(cfg: DbConfig): pg.PoolConfig['ssl'] {
  if (!cfg.ssl) return undefined;
  if (cfg.sslInsecure === true) return { rejectUnauthorized: false };
  const ca = cfg.sslCa;
  return {
    rejectUnauthorized: true,
    ...(ca === undefined || ca === null ? {} : { ca }),
  };
}

export function createDb(cfg: DbConfig): DbHandle {
  const ssl = sslOptions(cfg);
  const pool = new pg.Pool({
    connectionString: cfg.url,
    max: cfg.poolMax,
    ...(ssl === undefined ? {} : { ssl }),
  });

  const db: Database = drizzle(pool, { schema });

  return {
    db,
    pool,
    withTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
      return db.transaction((tx) => fn(tx));
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
