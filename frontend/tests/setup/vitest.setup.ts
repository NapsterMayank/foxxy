import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * A NO-OP APP ROUTER, for every test that does not care about navigation.
 *
 * `useRouter` throws "invariant expected app router to be mounted" outside a
 * Next tree, and shared components legitimately use it — the language switch
 * calls `router.refresh()` so that server components re-render in the new
 * language. Without this, adding that switch to a shell breaks every test that
 * renders the shell, for a reason that has nothing to do with what they assert.
 *
 * A test that DOES care declares its own `vi.mock('next/navigation', …)`, which
 * takes precedence over this one.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * Unmount between tests.
 *
 * Testing Library registers this itself ONLY when Vitest runs with
 * `globals: true`, and this project does not — so without this line every
 * render accumulates in the same document. The failure mode is not a clear
 * error either: queries start finding several matches, and the test that broke
 * is the one AFTER the one at fault.
 */
afterEach(cleanup);

/**
 * The API base URL, before any module reads it.
 *
 * `lib/config/env.ts` THROWS when `NEXT_PUBLIC_API_URL` is absent — deliberately,
 * so a misconfigured build fails at boot rather than pointing every request at a
 * machine that is not there. Setup files run before test modules are imported,
 * which is the only window in which this can be set.
 *
 * A value that is obviously not a real host: nothing in the suite may reach the
 * network, and a test that accidentally does should fail loudly rather than hit
 * a developer's local backend and pass on their machine alone.
 */
process.env.NEXT_PUBLIC_API_URL ??= 'http://api.test';
