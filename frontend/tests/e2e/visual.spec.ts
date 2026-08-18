import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signInAs, stubStudentData, useLanguage } from './support/session';

/**
 * ===========================================================================
 * VISUAL REGRESSION AND CONTRAST — 02-FRONTEND-IMPLEMENTATION-PLAN.md §10.7.
 *
 * §10.7 asks for two journeys x two breakpoints x two languages x two themes,
 * and explains why: "sixteen renderings per screen cannot be reviewed by hand
 * ... the minimum that catches a Hindi string overflowing a button or a
 * parent-theme component that hard-coded purple".
 *
 * ALL FOUR AXES EXIST HERE.
 *   breakpoints  the two Playwright projects, 360 px and 1280 px
 *   themes       the two route groups — `data-theme` is set by the layout, so
 *                `/student` IS the purple theme and `/parent` IS the orange one
 *   journeys     the student dashboard and the parent dashboard
 *   languages    the cookie the switch writes and the server reads
 *
 * THE LANGUAGE AXIS The language one landed with build-order step 5:
 * both dictionaries are real, so a Hindi run screenshots Hindi strings and the
 * gate can finally catch what §10.7 says it is for — "a Hindi string
 * overflowing a button". Hindi runs longer than English, and the shell, the
 * navigation and every button were laid out against the shorter one.
 *
 * ON BASELINES. Playwright names snapshots per platform, so a baseline taken on
 * Windows is not the one Linux CI compares against — font hinting and
 * anti-aliasing genuinely differ. The first CI run generates and commits the
 * Linux baselines; until then this gate is real locally and unproven in CI.
 * ===========================================================================
 */

/**
 * `role: null` MEANS A PUBLIC ROUTE, and signing in first would defeat the
 * test — an authenticated visit to `/login` is a redirect, so the screen under
 * review never renders.
 *
 * THE AUTH AND ONBOARDING SCREENS ARE HERE BECAUSE THEY WERE NOT. Build-order
 * steps 7-8 replaced their bespoke fields with `FormField`, removed a control
 * and changed the shell header, and nothing in this suite was looking at them:
 * the list covered two dashboards, both of which still render fixtures. A gate
 * that watches the screens nobody is changing is a gate that reports green
 * through the whole build.
 */
const journeys = [
  { name: 'student-dashboard', path: '/student', role: 'student' },
  { name: 'student-profile', path: '/student/profile', role: 'student' },
  { name: 'parent-dashboard', path: '/parent', role: 'parent' },
  { name: 'auth-login', path: '/login?role=student', role: null },
  { name: 'auth-signup', path: '/signup?role=parent', role: null },
  { name: 'onboarding-student', path: '/onboarding?role=student', role: null },
  { name: 'onboarding-parent', path: '/onboarding?role=parent', role: null },
] as const;

const languages = ['en', 'hi'] as const;

/**
 * Signing in is no longer enough for a student route.
 *
 * `/student` and `/student/profile` read their own data now, and with no
 * backend behind these tests an unstubbed read renders an error state — no
 * `h1`, and nothing a baseline should be taken of. The parent journeys are
 * unchanged: their screen already handled its own empty and error states when
 * it was built.
 */
async function enter(page: Page, journey: (typeof journeys)[number]): Promise<void> {
  if (journey.role === null) return;
  await signInAs(page, journey.role);
  if (journey.role === 'student') await stubStudentData(page);
}

test.describe('visual regression', () => {
  for (const journey of journeys) {
    for (const language of languages) {
      test(`${journey.name} in ${language} looks the way it was last reviewed`, async ({
        context,
        page,
      }) => {
        await useLanguage(context, language);
        await enter(page, journey);
        await page.goto(journey.path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

        /*
         * Full page, not the viewport: a layout that breaks below the fold
         * breaks for the person scrolling, and this is the only gate that would
         * see it.
         */
        await expect(page).toHaveScreenshot(`${journey.name}-${language}.png`, { fullPage: true });
      });
    }
  }
});

test.describe('Hindi does not break the layout', () => {
  for (const journey of journeys) {
    test(`${journey.name} has no horizontal overflow in Hindi`, async ({ context, page }) => {
      /*
       * THE FAILURE §10.7 NAMES. Hindi is longer than English almost everywhere,
       * and every one of these screens was laid out against the English string.
       * A button that fits "Submit" may not fit its Hindi equivalent, and the
       * symptom at 360px is a page that scrolls sideways.
       */
      await useLanguage(context, 'hi');
      await enter(page, journey);
      await page.goto(journey.path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflows, `${journey.path} overflows in Hindi`).toBe(false);
    });
  }

  test('the page really is in Hindi, so the check above means something', async ({
    context,
    page,
  }) => {
    await useLanguage(context, 'hi');
    await signInAs(page, 'student');
    await stubStudentData(page);
    await page.goto('/student');

    // `lang` drives screen-reader pronunciation and hyphenation, and it is set
    // by the server from the same cookie.
    await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('नमस्ते');
  });
});

test.describe('contrast, in both themes', () => {
  for (const journey of journeys) {
    test(`${journey.name} meets WCAG AA`, async ({ page }) => {
      await enter(page, journey);
      await page.goto(journey.path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      /*
       * Both themes must be checked SEPARATELY and this is what makes that
       * real: the semantic tokens resolve to different values per
       * `data-theme`, so a colour pair that passes on purple can fail on
       * orange. Checking one theme and assuming the other is how the dashboard
       * hero shipped at 4.32:1 once already.
       */
      const contrast = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
      expect(contrast.violations, `${journey.path} contrast`).toEqual([]);
    });
  }

  test('the two themes really are different, so the check above means something', async ({
    page,
  }) => {
    await signInAs(page, 'student');
    await stubStudentData(page);
    await page.goto('/student');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const studentBrand = await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-theme]') as Element).getPropertyValue('--brand'),
    );

    await signInAs(page, 'parent');
    await page.goto('/parent');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const parentBrand = await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-theme]') as Element).getPropertyValue('--brand'),
    );

    // If these ever match, every "both themes" assertion in this file is
    // silently testing one theme twice.
    expect(studentBrand.trim()).not.toBe(parentBrand.trim());
    expect(studentBrand.trim()).not.toBe('');
  });
});
