import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { holdBootstrap, signInAs, signOut } from './support/session';

test('role selection is responsive and keyboard reachable', async ({ page }) => {
  const response = await page.goto('/');

  expect(response?.status()).toBe(200);
  expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow, noarchive');
  expect(response?.headers()['x-content-type-options']).toBe('nosniff');
  expect(response?.headers()['x-frame-options']).toBe('DENY');
  expect(response?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');

  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Alfanumrik' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue as student' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue as parent' })).toBeVisible();

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Continue as student' })).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Continue as parent' })).toBeFocused();

  const seriousViolations = (await new AxeBuilder({ page }).analyze()).violations.filter(
    ({ impact }) => impact === 'serious' || impact === 'critical',
  );
  expect(seriousViolations).toEqual([]);
});

test('reduced-motion keeps feedback without spatial movement', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  const studentCard = page.getByRole('heading', { name: 'I am a student' }).locator('..').locator('..');
  await studentCard.hover();

  await expect(studentCard).toHaveCSS('transform', 'none');
  await expect(studentCard).toHaveCSS('transition-duration', '0.12s');
});

test('product routes tell crawlers not to index them', async ({ request }) => {
  const response = await request.get('/robots.txt');

  expect(response.status()).toBe(200);
  expect(await response.text()).toContain('Disallow: /');
});

/**
 * THE SESSION GATE, IN A REAL BROWSER — plan §5.5.
 *
 * These three states are what the gate exists to distinguish, and two of them
 * are indistinguishable from each other in a unit test that fakes the router.
 */
test.describe('the session gate', () => {
  test('sends an unauthenticated visitor to login, carrying where they came from', async ({
    page,
  }) => {
    await signOut(page);
    await page.goto('/student');

    await page.waitForURL(/\/login\?next=%2Fstudent/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('shows a skeleton while the bootstrap is in flight, and does NOT redirect', async ({
    page,
  }) => {
    // The single most common bug in cookie-session applications: redirect on
    // "not yet authenticated" and every user is signed out by pressing refresh.
    await holdBootstrap(page);
    await page.goto('/student');

    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/student');
  });

  test('keeps a student out of the parent space', async ({ page }) => {
    await signInAs(page, 'student');
    await page.goto('/parent');

    // Sent to their own home rather than to a sign-in form they are past.
    await page.waitForURL(/\/student$/);
  });
});

test('auth, onboarding and preview dashboards render without overflow or serious accessibility defects', async ({ page }) => {
  const routes = [
    { path: '/login?role=student', heading: 'Sign in to continue as a student' },
    { path: '/login?role=parent', heading: 'Sign in to continue as a parent' },
    { path: '/signup?role=parent', heading: 'Create your account' },
    { path: '/verify', heading: 'Verify your email' },
    { path: '/forgot-password', heading: 'Reset your password' },
    { path: '/reset-password', heading: 'Choose a new password' },
    { path: '/onboarding?role=student', heading: 'Make learning yours' },
    { path: '/onboarding?role=parent', heading: 'Connect with your child' },
    // Both dashboards are behind `SessionGate` now, so each needs a session in
    // the matching role — an unauthenticated visit is a redirect, which the
    // gate's own tests above assert.
    { path: '/student', heading: 'Good afternoon, Aarav', role: 'student' },
    { path: '/parent', heading: 'Welcome back, Ananya', role: 'parent' },
  ] as const;

  for (const route of routes) {
    if ('role' in route) await signInAs(page, route.role);
    const response = await page.goto(route.path);
    expect(response?.status(), route.path).toBe(200);
    expect(response?.headers()['x-robots-tag'], route.path).toContain('noindex');
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow, `${route.path} has horizontal overflow`).toBe(false);

    const seriousViolations = (await new AxeBuilder({ page }).analyze()).violations.filter(
      ({ impact }) => impact === 'serious' || impact === 'critical',
    );
    expect(seriousViolations, route.path).toEqual([]);
  }
});
