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

export function createDb(cfg: DbConfig): DbHandle {
  const pool = new pg.Pool({
    connectionString: cfg.url,
    max: cfg.poolMax,
    ...(cfg.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
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
