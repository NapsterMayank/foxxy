import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * The admin app's test config.
 *
 * Deliberately thinner than `frontend/vitest.config.ts`, which carries per-area
 * coverage floors: this app has one user and no coverage gate, and inventing
 * one here would be a number nobody is accountable to.
 *
 * What it DOES run is the drift check — see `contracts-drift.test.ts`.
 */
export default defineConfig({
  test: { environment: 'node', include: ['src/**/__tests__/**/*.test.ts'] },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
});
