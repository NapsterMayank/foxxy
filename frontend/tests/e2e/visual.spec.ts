import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { signInAs } from './support/session';

/**
 * ===========================================================================
 * VISUAL REGRESSION AND CONTRAST — 02-FRONTEND-IMPLEMENTATION-PLAN.md §10.7.
 *
 * §10.7 asks for two journeys x two breakpoints x two languages x two themes,
 * and explains why: "sixteen renderings per screen cannot be reviewed by hand
 * ... the minimum that catches a Hindi string overflowing a button or a
 * parent-theme component that hard-coded purple".
 *
 * THREE OF THE FOUR AXES EXIST HERE.
 *   breakpoints  the two Playwright projects, 360 px and 1280 px
 *   themes       the two route groups — `data-theme` is set by the layout, so
 *                `/student` IS the purple theme and `/parent` IS the orange one
 *   journeys     the student dashboard and the parent dashboard
 *
 * THE LANGUAGE AXIS DOES NOT EXIST YET and is not faked. Build-order step 5
 * (i18n scaffold and both dictionaries) has not been done; there is one English
 * dictionary, so a "Hindi" run would screenshot the same English strings and
 * report a green gate for a property nothing checks. Added the day the Hindi
 * dictionary lands — see `frontend/PROGRESS.md`.
 *
 * ON BASELINES. Playwright names snapshots per platform, so a baseline taken on
 * Windows is not the one Linux CI compares against — font hinting and
 * anti-aliasing genuinely differ. The first CI run generates and commits the
 * Linux baselines; until then this gate is real locally and unproven in CI.
 * ===========================================================================
 */

const journeys = [
  { name: 'student-dashboard', path: '/student', role: 'student' },
  { name: 'parent-dashboard', path: '/parent', role: 'parent' },
] as const;

test.describe('visual regression', () => {
  for (const journey of journeys) {
    test(`${journey.name} looks the way it was last reviewed`, async ({ page }) => {
      await signInAs(page, journey.role);
      await page.goto(journey.path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      /*
       * Full page, not the viewport: a layout that breaks below the fold breaks
       * for the person scrolling, and this is the only gate that would see it.
       */
      await expect(page).toHaveScreenshot(`${journey.name}.png`, { fullPage: true });
    });
  }
});

test.describe('contrast, in both themes', () => {
  for (const journey of journeys) {
    test(`${journey.name} meets WCAG AA`, async ({ page }) => {
      await signInAs(page, journey.role);
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
