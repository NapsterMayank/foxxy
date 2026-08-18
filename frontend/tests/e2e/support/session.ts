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
 * Where the app under test is. Mirrors `playwright.config.ts`.
 *
 * A COOKIE IS SET FOR A URL, so this cannot be a constant: the cookie was being
 * planted on `127.0.0.1:3000` while the run targeted a container on another
 * port, which sets it on an origin the browser never visits. Every Hindi
 * assertion would then have silently tested English.
 */
export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';

/**
 * Sets the display language for a browser context.
 *
 * The SAME cookie the switch writes and the server reads, so a test in Hindi
 * exercises the real path — including the server render — rather than a
 * client-side override the deployed app never uses.
 */
export async function useLanguage(context: BrowserContext, language: 'en' | 'hi'): Promise<void> {
  await context.addCookies([{ name: 'foxxy_lang', value: language, url: BASE_URL }]);
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

/**
 * ===========================================================================
 * THE STUDENT DASHBOARD'S OWN READS — added when `/student` stopped being a
 * fixture (open item 51).
 *
 * Until then the screen rendered from constants in the file, so a browser test
 * that stubbed only the bootstrap saw a complete page. It now issues three
 * requests, and with no backend in these tests all three fail at the transport
 * layer — which the screen correctly renders as "your dashboard could not
 * load", a state with no `h1` and nothing worth a baseline.
 *
 * THE FIXTURES ARE FROZEN IN TIME ON PURPOSE. `lastPractisedAt` is rendered as
 * a day and a month, so a relative date would change the screenshot without
 * anybody changing the product — a baseline that fails once a month teaches
 * everyone to re-record without looking.
 * ===========================================================================
 */
const STUDENT_CHAPTER_ID = '44444444-4444-4444-8444-444444444444';

export async function stubStudentData(page: Page): Promise<void> {
  await page.route('**/api/v1/practice/mission', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mission: {
          chapterId: STUDENT_CHAPTER_ID,
          chapterNumber: 6,
          chapterTitleEn: 'Life Processes',
          chapterTitleHi: 'जैव प्रक्रम',
          subjectCode: 'science',
          reason: 'due_review',
          reasonEn: 'You practised this three days ago and it is due for review.',
          reasonHi: 'आपने इसे तीन दिन पहले किया था और अब दोहराव का समय है।',
          evidence: 'developing',
          suggestedQuestionCount: 8,
        },
      }),
    }),
  );

  await page.route('**/api/v1/practice/progress', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        chapters: [
          {
            chapterId: STUDENT_CHAPTER_ID,
            chapterTitleEn: 'Life Processes',
            chapterTitleHi: 'जैव प्रक्रम',
            evidence: 'developing',
            attempts: 3,
            lastPractisedAt: '2026-08-12T09:00:00.000Z',
            nextReviewAt: '2026-08-21T09:00:00.000Z',
          },
        ],
        totalXp: 420,
        xpToday: 30,
        sessionsCompleted: 7,
      }),
    }),
  );

  await page.route('**/api/v1/me/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        profile: {
          userId: USER_IDS.student,
          displayName: 'Meera',
          grade: '10',
          board: 'CBSE',
          preferredLanguage: 'en',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-12T09:00:00.000Z',
        },
      }),
    }),
  );
}
