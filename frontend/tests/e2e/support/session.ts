import type { BrowserContext, Page } from '@playwright/test';

/**
 * Session control for browser tests.
 *
 * ===========================================================================
 * THE BOOTSTRAP IS INTERCEPTED, NOT THE WHOLE API.
 *
 * `SessionGate` decides what to render from ONE request — `GET /auth/me`,
 * §5.5's single source of truth. Faking that one response is enough to put the
 * browser in either state, and it keeps the fake honest: a test cannot
 * accidentally authenticate itself by stubbing a screen's own data.
 *
 * Without a route handler the request reaches a backend that is not running in
 * these tests, fails at the transport layer, and the gate correctly concludes
 * "unauthenticated" — so an un-stubbed protected route redirects to login.
 * That is the real behaviour and `expectRedirectedToLogin` asserts it.
 * ===========================================================================
 */

const BOOTSTRAP_ROUTE = '**/api/v1/auth/me';

export type BrowserRole = 'student' | 'parent';

const USER_IDS: Readonly<Record<BrowserRole, string>> = {
  student: '11111111-1111-4111-8111-111111111111',
  parent: '22222222-2222-4222-8222-222222222222',
};

/**
 * Sets the display language for a browser context.
 *
 * The SAME cookie the switch writes and the server reads, so a test in Hindi
 * exercises the real path — including the server render — rather than a
 * client-side override the deployed app never uses.
 */
export async function useLanguage(context: BrowserContext, language: 'en' | 'hi'): Promise<void> {
  await context.addCookies([
    { name: 'foxxy_lang', value: language, url: 'http://127.0.0.1:3000' },
  ]);
}

/** Answers the bootstrap with a verified account in the given role. */
export async function signInAs(page: Page, role: BrowserRole): Promise<void> {
  await page.route(BOOTSTRAP_ROUTE, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: USER_IDS[role],
          email: `${role}@example.test`,
          role,
          emailVerifiedAt: '2026-08-01T00:00:00.000Z',
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      }),
    }),
  );
}

/** Answers the bootstrap the way an expired or absent session does. */
export async function signOut(page: Page): Promise<void> {
  await page.route(BOOTSTRAP_ROUTE, (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
      }),
    }),
  );
}

/**
 * Holds the bootstrap open, so a test can observe the `loading` state.
 *
 * The state §5.5 cares most about: a redirect here would sign out every user on
 * every refresh, and it is invisible on a fast local network because the
 * request settles before anything renders.
 */
export async function holdBootstrap(page: Page): Promise<void> {
  await page.route(BOOTSTRAP_ROUTE, () => {
    // Never fulfilled, never aborted. The request simply stays in flight.
  });
}
