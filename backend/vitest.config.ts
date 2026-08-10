import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Coverage floors come from 01-BACKEND-IMPLEMENTATION-PLAN.md section 9.4.
// They are floors, not goals. `platform/authz` is a gate: 100%, no exceptions.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts', 'tests/**/*.test.ts'],
    /**
     * ONE Postgres container for the whole run, with a fresh database per test
     * file (see tests/helpers/global-postgres.ts).
     *
     * Before this, each database-backed file started its own container, and
     * concurrent starts raced on testcontainers' Ryuk reaper — the run failed
     * with "Failed to connect to Reaper" while every test was in fact fine.
     * A red run that says nothing about the code is worse than no run.
     *
     * The setup is skipped automatically when no test file asks for a database,
     * because `inject` is only ever called from the helper.
     */
    globalSetup: ['tests/helpers/global-postgres.ts'],
    // Container-backed tests get a long leash on hooks. `npm test` runs
    // everything; `npm run test:unit` runs only the fast half.
    testTimeout: 15_000,
    hookTimeout: 180_000,
    // `threads` rather than the default `forks`: on Windows + Node 22 the fork
    // pool emits an unhandled `kill EPERM` during teardown after an otherwise
    // green run, which makes a passing suite look broken.
    pool: 'threads',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/*.test.ts',
        'src/**/index.ts',
        'src/main.ts',
        'src/**/*.types.ts',
        'src/platform/db/schema/**',
      ],
      thresholds: {
        // Everything else — section 9.4, final row.
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 70,

        // An access-control gap is not a bug, it is an incident.
        'src/platform/authz/**/*.ts': {
          lines: 100,
          functions: 100,
          statements: 100,
          branches: 100,
        },
        // Pure functions. There is no excuse.
        'src/modules/*/domain/**/*.ts': {
          lines: 95,
          functions: 95,
          statements: 95,
          branches: 95,
        },
        // Use-case orchestration.
        'src/modules/*/*.service.ts': {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 80,
        },
      },
    },
  },
});
