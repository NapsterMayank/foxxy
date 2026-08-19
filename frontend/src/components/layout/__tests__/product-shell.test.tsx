import { screen, within } from '@testing-library/react';
import { renderClient } from '@test/setup/render';
import { createTranslator } from '@/lib/i18n/translate';
import { describe, expect, it, vi } from 'vitest';
import { ProductShell, type ProductNavigationItem } from '../product-shell';

/*
 * `getServerT` reaches for `next/headers`, which only exists inside a request.
 * The REAL dictionary is still used — only the cookie read is replaced — so
 * these tests assert the strings a user actually sees.
 */
vi.mock('@/lib/i18n/server', () => ({
  getServerT: () => Promise.resolve(createTranslator('en')),
  getServerLanguage: () => Promise.resolve('en'),
}));

// The shell contains the LanguageSwitch, which is a client component.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));


/**
 * The application shell — plan build-order step 4.
 *
 * The two navigations are the point. The same links exist twice, once for the
 * desktop sidebar and once for the mobile bar, and they are hidden from each
 * other by breakpoint rather than by conditional rendering — so both are in the
 * DOM at all times and BOTH must be correct. A duplicate landmark with no
 * distinguishing label is a screen-reader defect that no visual review finds.
 */

const navigation: readonly ProductNavigationItem[] = [
  { href: '/student', isCurrent: true, label: 'Learn', marker: '⌂' },
  { href: '/student#progress', label: 'Progress', marker: '↗' },
];

/*
 * `ProductShell` is an ASYNC SERVER COMPONENT. React's test renderer cannot
 * mount one — `<ProductShell />` is a promise where an element is expected — so
 * it is called and its output rendered, which is what the framework does too.
 */
async function renderShell(items = navigation) {
  const element = await ProductShell({
    children: <h1>Today</h1>,
    navigation: items,
    roleLabel: 'Student',
    userName: 'Aarav',
  });
  return renderClient(element);
}

describe('ProductShell', () => {
  it('renders its children', async () => {
    await renderShell();
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  });

  it('exposes both navigations with the same links', async () => {
    await renderShell();
    const navs = screen.getAllByRole('navigation', { name: 'Student navigation' });
    expect(navs).toHaveLength(2);

    for (const nav of navs) {
      expect(within(nav).getByRole('link', { name: /Learn/ })).toHaveAttribute('href', '/student');
      expect(within(nav).getByRole('link', { name: /Progress/ })).toHaveAttribute(
        'href',
        '/student#progress',
      );
    }
  });

  it('marks the current page in both navigations, and only the current one', async () => {
    await renderShell();
    const current = screen.getAllByRole('link', { current: 'page' });

    // One per navigation, and never the second item.
    expect(current).toHaveLength(2);
    for (const link of current) expect(link).toHaveAccessibleName(/Learn/);
  });

  it('gives every navigation link the 44px touch target', async () => {
    await renderShell();
    /*
     * Scoped to the navigations. The brand link in the header is a text link
     * inside a 64px-tall bar and is not held to the control minimum here — if
     * that is wrong it is wrong for a different reason than these are.
     */
    for (const nav of screen.getAllByRole('navigation', { name: 'Student navigation' })) {
      for (const link of within(nav).getAllByRole('link')) {
        expect(link.className).toContain('min-h-control');
      }
    }
  });

  it('labels the avatar with the person and the role rather than a bare initial', async () => {
    // "A" read aloud tells a screen-reader user nothing.
    await renderShell();
    expect(screen.getByRole('img', { name: 'Aarav, Student' })).toHaveTextContent('A');
  });

  it('makes no claim that the product is a preview', async () => {
    /*
     * The sidebar card said "Sample information is shown while the product
     * services are being connected" on every authenticated screen. It was true
     * when the shell was built and false from 12 August, and it sat beside the
     * live data contradicting it (open item 52). This test exists so it cannot
     * come back with a screen that is genuinely unfinished — the honest place
     * for that is on the screen itself, not on every screen forever.
     */
    await renderShell();
    expect(screen.queryByText(/preview/i)).toBeNull();
    expect(screen.queryByText(/sample/i)).toBeNull();
  });

  it('lays the mobile bar out from the number of items, not a hardcoded count', async () => {
    // Adding a third link must not leave two columns and an overflow.
    const { container } = await renderShell([
      ...navigation,
      { href: '/student#next', label: 'Practice', marker: '✎' },
    ]);

    const mobileNav = container.querySelector('.mobile-product-nav');
    expect(mobileNav?.getAttribute('style')).toContain('repeat(3,');
  });
});
