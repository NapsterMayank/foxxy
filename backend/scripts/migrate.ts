/**
 * Applies every pending migration in drizzle/migrations, in order.
 *
 * Run with `npm run db:migrate`. Idempotent: Drizzle records what it has
 * applied in `drizzle.__drizzle_migrations`.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from '../src/platform/db/index';
import { config } from '../src/platform/config/index';

async function main(): Promise<void> {
  const handle = createDb(config.db);
  try {
    await migrate(handle.db, { migrationsFolder: './drizzle/migrations' });
    process.stdout.write('Migrations applied.\n');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Migration failed: ${message}\n`);
  process.exit(1);
});
