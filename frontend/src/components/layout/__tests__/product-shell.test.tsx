import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProductShell, type ProductNavigationItem } from '../product-shell';

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

function renderShell() {
  return render(
    <ProductShell navigation={navigation} roleLabel="Student" userName="Aarav">
      <h1>Today</h1>
    </ProductShell>,
  );
}

describe('ProductShell', () => {
  it('renders its children', () => {
    renderShell();
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  });

  it('exposes both navigations with the same links', () => {
    renderShell();
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

  it('marks the current page in both navigations, and only the current one', () => {
    renderShell();
    const current = screen.getAllByRole('link', { current: 'page' });

    // One per navigation, and never the second item.
    expect(current).toHaveLength(2);
    for (const link of current) expect(link).toHaveAccessibleName(/Learn/);
  });

  it('gives every navigation link the 44px touch target', () => {
    renderShell();
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

  it('labels the avatar with the person and the role rather than a bare initial', () => {
    // "A" read aloud tells a screen-reader user nothing.
    renderShell();
    expect(screen.getByRole('img', { name: 'Aarav, Student' })).toHaveTextContent('A');
  });

  it('lays the mobile bar out from the number of items, not a hardcoded count', () => {
    // Adding a fourth link must not leave three columns and an overflow.
    const { container } = render(
      <ProductShell
        navigation={[...navigation, { href: '/student#next', label: 'Practice', marker: '✎' }]}
        roleLabel="Student"
        userName="Aarav"
      >
        <p>content</p>
      </ProductShell>,
    );

    const mobileNav = container.querySelector('.mobile-product-nav');
    expect(mobileNav?.getAttribute('style')).toContain('repeat(3,');
  });
});
