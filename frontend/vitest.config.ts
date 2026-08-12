import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * ===========================================================================
 * COVERAGE FLOORS — 02-FRONTEND-IMPLEMENTATION-PLAN.md §10.5, enforced as a
 * §10.7 CI gate.
 *
 * The floors are PER AREA, not one global number, because a single global
 * figure is satisfied by testing the easy half. 90% overall with every
 * primitive untested and every utility exhaustively tested is a number that
 * says nothing about the risk it is supposed to bound.
 *
 * The globs are DISJOINT ON PURPOSE. Vitest applies one glob's thresholds to
 * the files it matches; overlapping patterns make it ambiguous which floor
 * applies, and an ambiguous gate is one people argue with instead of fix.
 *
 * Two areas the plan's table does not name get a floor anyway, stated here
 * rather than left to the global default:
 *   `src/lib/api`      the typed client and the error table — the error table
 *                      in particular is a switch every screen depends on
 *   `src/lib/session`  the bootstrap, the expiry path and the loop guard
 * Both are held at the hook floor of 85%.
 * ===========================================================================
 */

const PURE_FUNCTION_FLOOR = { statements: 95, branches: 90, functions: 95, lines: 95 };
const HOOK_FLOOR = { statements: 85, branches: 80, functions: 85, lines: 85 };
const COMPONENT_FLOOR = { statements: 80, branches: 75, functions: 80, lines: 80 };
const PRIMITIVE_FLOOR = { statements: 90, branches: 85, functions: 90, lines: 90 };

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'jsdom',
    exclude: ['tests/e2e/**', 'node_modules/**'],
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    setupFiles: ['./tests/setup/vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      /*
       * EVERY source file, not only the ones a test happened to import.
       * Without this an untested file is invisible rather than at 0%, which is
       * the difference between a floor and a self-congratulation.
       */
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        // The backend's own code, copied in by `contracts:sync`. Its tests live
        // in the backend; measuring it here would report the backend's coverage
        // as the frontend's.
        'src/lib/api/generated/**',
        // Routing only, and thin by rule (§2: "a page component is thin"). The
        // behaviour they compose is covered where it lives; the routes
        // themselves are covered end to end by Playwright, which this provider
        // cannot see.
        'src/app/**',
        'src/**/__tests__/**',
        'src/**/*.d.ts',
        'src/types/**',
      ],
      thresholds: {
        'src/lib/utils/**': PURE_FUNCTION_FLOOR,
        'src/features/*/lib/**': PURE_FUNCTION_FLOOR,
        'src/features/*/hooks/**': HOOK_FLOOR,
        'src/lib/api/**': HOOK_FLOOR,
        'src/lib/session/**': HOOK_FLOOR,
        'src/features/*/*.tsx': COMPONENT_FLOOR,
        'src/features/*/components/**': COMPONENT_FLOOR,
        'src/components/layout/**': COMPONENT_FLOOR,
        'src/components/ui/**': PRIMITIVE_FLOOR,
      },
    },
  },
});
