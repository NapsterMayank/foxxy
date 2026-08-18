import { expect, test, type Page } from '@playwright/test';
import { signInAs, useLanguage } from './support/session';

/**
 * ===========================================================================
 * THE RESPONSIVE PASS — build-order step 14, and §12's definition of done:
 * "works at 360 px and at 1280 px, IN BOTH LANGUAGES, with no horizontal
 * scroll."
 *
 * ---------------------------------------------------------------------------
 * HINDI IS THE AXIS THAT ACTUALLY BREAKS THINGS, WHICH IS WHY IT IS HERE AND
 * NOT IN A SEPARATE FILE SOMEBODY RUNS LATER.
 *
 * Devanagari runs longer than Latin for the same sentence and its glyphs are
 * taller, so a button that fits at 360 px in English is the button that
 * overflows in Hindi. Every check below runs in both, and the failure this
 * catches is invisible to anyone working in English — which is everyone
 * building it.
 *
 * ---------------------------------------------------------------------------
 * WHY `scrollWidth > clientWidth` AND NOT A SCREENSHOT.
 *
 * A visual baseline says "this changed"; it cannot say "this is broken", and it
 * needs a human to approve every legitimate change. Horizontal overflow is one
 * of the few layout faults with an exact definition, so it is asserted as a
 * fact about the document rather than compared against a picture.
 *
 * The tolerance is ONE PIXEL. Sub-pixel rounding on a scaled viewport routinely
 * produces a `scrollWidth` a fraction over `clientWidth` with nothing actually
 * clipped, and a zero-tolerance assertion fails on that — a suite that cries
 * wolf stops being read.
 * ===========================================================================
 */

const OVERFLOW_TOLERANCE_PX = 1;

/** Every product screen that renders without a live backend behind it. */
const ROUTES = [
  { path: '/', name: 'role selection', role: null },
  { path: '/login?role=student', name: 'login', role: null },
  { path: '/signup?role=parent', name: 'signup', role: null },
  { path: '/onboarding?role=student', name: 'onboarding', role: 'student' as const },
  { path: '/student', name: 'student dashboard', role: 'student' as const },
  { path: '/student/foxy', name: 'foxy', role: 'student' as const },
  { path: '/student/practice', name: 'practice', role: 'student' as const },
  { path: '/student/progress', name: 'progress', role: 'student' as const },
  { path: '/parent', name: 'parent dashboard', role: 'parent' as const },
  { path: '/parent/billing', name: 'billing', role: 'parent' as const },
];

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/**
 * Elements sticking out past the viewport, named.
 *
 * A BARE "the page scrolls sideways" IS A BUG REPORT NOBODY CAN ACT ON. The
 * document-level number says a fault exists; this says which element, which is
 * the difference between a fix and an afternoon of bisecting Tailwind classes.
 */
async function overflowingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const named: string[] = [];

    for (const element of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right <= limit + 1) continue;

      const classes = element.className;
      named.push(
        `<${element.tagName.toLowerCase()} class="${typeof classes === 'string' ? classes.slice(0, 80) : ''}"> right=${String(Math.round(box.right))} limit=${String(limit)}`,
      );
      if (named.length >= 5) break;
    }

    return named;
  });
}

for (const language of ['en', 'hi'] as const) {
  test.describe(`no horizontal scroll — ${language}`, () => {
    for (const route of ROUTES) {
      test(`${route.name} at this viewport, in ${language}`, async ({ context, page }) => {
        await useLanguage(context, language);
        if (route.role !== null) await signInAs(page, route.role);

        await page.goto(route.path);
        /*
         * `domcontentloaded` and then a settle, NOT `networkidle`. Several of
         * these screens hold a query open against a backend that is not running
         * here, so the network never goes idle and the wait would time out on a
         * page that rendered perfectly.
         */
        await page.waitForLoadState('domcontentloaded');
        await expect(page.locator('body')).toBeVisible();

        const overflow = await horizontalOverflow(page);
        if (overflow > OVERFLOW_TOLERANCE_PX) {
          // Attached to the failure so the next person reads the element rather
          // than the number.
          console.error(`${route.path} [${language}]`, await overflowingElements(page));
        }

        expect(overflow).toBeLessThanOrEqual(OVERFLOW_TOLERANCE_PX);
      });
    }
  });
}

/**
 * ===========================================================================
 * §12: "every interactive element is at least 44 by 44 pixels".
 *
 * Checked on the SMALL viewport only, and against what the browser actually
 * laid out rather than against the `min-h-control` class — a utility that does
 * not exist emits nothing and the element renders at its user-agent size, which
 * is exactly the failure the closed token scale produced eleven times when the
 * spacing rule was switched on.
 *
 * ---------------------------------------------------------------------------
 * THE TARGET IS THE ACTIVATION AREA, NOT THE CONTROL'S OWN BOX.
 *
 * A checkbox inside a `<label>` is 16×16 and always will be — that is the
 * user-agent control, and browsers do not scale it with CSS in any way worth
 * relying on. What a finger hits is the LABEL, because clicking a label
 * activates the control it wraps. Measuring the input alone would report six
 * failures on the onboarding form and demand a "fix" that made the boxes
 * enormous, which is neither the standard nor what §12 is protecting.
 *
 * So a wrapped control is measured by its label. That is not the rule being
 * loosened: an unwrapped 16×16 checkbox still fails, and every button and link
 * is still measured directly.
 * ===========================================================================
 */
test.describe('touch targets', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 400, 'the small-screen rule');

  for (const route of ROUTES.filter((candidate) => candidate.role !== null)) {
    test(`${route.name} has no target under 44px`, async ({ context, page }) => {
      await useLanguage(context, 'hi');
      if (route.role !== null) await signInAs(page, route.role);

      await page.goto(route.path);
      await page.waitForLoadState('domcontentloaded');
      await expect(page.locator('body')).toBeVisible();

      const small = await page.evaluate(() => {
        const offenders: string[] = [];
        const selector = 'a[href], button:not([disabled]), input, select, textarea';

        for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
          const own = element.getBoundingClientRect();
          // Zero-sized means not laid out — hidden, or inside a closed dialog.
          // Not a touch target, and not this test's business.
          if (own.width === 0 || own.height === 0) continue;

          /*
           * A label that WRAPS the control is what a finger hits — clicking it
           * activates the control. A label merely associated by `for=` is not:
           * it activates on click too, but it can sit anywhere on the page, so
           * it says nothing about whether the control itself is reachable.
           */
          const wrapper = element.closest('label');
          const box = wrapper === null ? own : wrapper.getBoundingClientRect();

          if (box.height >= 44 && box.width >= 44) continue;

          offenders.push(
            `<${element.tagName.toLowerCase()}> ${String(Math.round(box.width))}x${String(Math.round(box.height))} "${(element.textContent ?? '').trim().slice(0, 30)}"`,
          );
        }

        return offenders;
      });

      expect(small).toEqual([]);
    });
  }
});
