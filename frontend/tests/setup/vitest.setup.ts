import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

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
