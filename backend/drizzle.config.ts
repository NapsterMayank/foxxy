import { defineConfig } from 'drizzle-kit';

// Tooling config: drizzle-kit runs outside the application process, so it
// reads the environment directly. The application itself never does — that is
// platform/config's job alone.
const url = process.env.DATABASE_URL;

if (url === undefined || url.length === 0) {
  throw new Error('DATABASE_URL is required to run drizzle-kit. Copy .env.example to .env.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/platform/db/schema/index.ts',
  out: './drizzle/migrations',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
