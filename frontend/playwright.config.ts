import { defineConfig, devices } from '@playwright/test';

/**
 * ===========================================================================
 * CI RUNS THE BUILT APP; LOCAL RUNS THE DEV SERVER.
 *
 * §10.7's gates — first-load JS, LCP, TBT — are properties of the PRODUCTION
 * bundle. Measuring them against `next dev` would measure the dev overlay, the
 * HMR client and unminified React, so CI starts `next start` over a real build.
 *
 * Locally the dev server is used, because `next build` currently dies at worker
 * teardown on Windows (root PROGRESS.md open item 33) and a suite nobody can
 * run locally is a suite that rots.
 *
 * THE TIMEOUTS ARE FOR THE DEV SERVER, NOT FOR SLOW ASSERTIONS. `next dev`
 * compiles a route ON FIRST REQUEST — measured at 3-4 seconds on this machine —
 * and until it finishes the route renders its `loading.tsx` skeleton. With the
 * 5-second default that reads as "the heading never appeared", which is
 * indistinguishable from a real rendering failure and cost an hour of chasing
 * one. The production server has no such phase.
 * ===========================================================================
 */

const isCi = process.env.CI === 'true' || process.env.CI === '1';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  reporter: 'html',
  // Generous per test, because a cold route compile lands inside the first one
  // to touch it. Not generous per assertion — see `expect` below.
  timeout: isCi ? 60_000 : 120_000,
  expect: {
    timeout: isCi ? 10_000 : 20_000,
    toHaveScreenshot: {
      /*
       * Anti-aliasing differs between machines and between headless runs. A
       * zero-tolerance comparison fails on a font-rendering difference nobody
       * can see, and a suite that cries wolf stops being read.
       */
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 5'], viewport: { width: 360, height: 800 } },
    },
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: {
    command: isCi ? 'npm run start' : 'npm run dev',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !isCi,
    timeout: 120_000,
  },
});
