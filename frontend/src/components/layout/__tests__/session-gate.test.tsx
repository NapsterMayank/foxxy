import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SessionState } from '@/lib/session/session-provider';
import { SessionGate } from '../session-gate';

/**
 * THE LAYOUT GUARD — plan §5.5.
 *
 * The session context is faked here rather than driven through a real provider:
 * what is under test is the DECISION TABLE — four session states times two
 * required roles — and reaching each state through a real bootstrap would mean
 * four different network fakes to test one `if`.
 *
 * The end-to-end counterpart lives in `tests/e2e/foundation.spec.ts`, where a
 * real router actually performs the navigation. Both are needed: this file
 * proves what is rendered, that one proves the URL changes.
 */

const replace = vi.fn();
let pathname = '/student';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname,
}));

const session = { current: null as SessionState | null };

vi.mock('@/lib/session/session-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/session-provider')>();
  return {
    ...actual,
    useSession: () => session.current,
  };
});

function setSession(state: Partial<SessionState>): void {
  session.current = { status: 'loading', user: null, expire: vi.fn(), ...state };
}

function userOfRole(role: string) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: `${role}@example.test`,
    role,
    emailVerifiedAt: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
  } as SessionState['user'];
}

beforeEach(() => {
  replace.mockReset();
  pathname = '/student';
});

describe('while the bootstrap is in flight', () => {
  it('renders a skeleton and does NOT redirect', () => {
    // §5.5 names this the single most common bug in cookie-session
    // applications: redirect on "not yet authenticated" and every user is
    // signed out by pressing refresh.
    setSession({ status: 'loading' });
    render(
      <SessionGate role="student">
        <p>protected</p>
      </SessionGate>,
    );

    // The skeleton announces itself to assistive technology instead of leaving
    // a screen-reader user on a silent page.
    expect(screen.getByText('Checking your account')).toBeDefined();
    expect(screen.queryByText('protected')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('when signed out', () => {
  it('redirects to login carrying where the visitor came from', () => {
    setSession({ status: 'unauthenticated' });
    render(
      <SessionGate role="student">
        <p>protected</p>
      </SessionGate>,
    );

    expect(replace).toHaveBeenCalledWith('/login?next=%2Fstudent');
    expect(screen.queryByText('protected')).toBeNull();
  });

  it('omits ?next= when there is nowhere meaningful to return to', () => {
    pathname = '/login';
    setSession({ status: 'unauthenticated' });
    render(
      <SessionGate role="student">
        <p>protected</p>
      </SessionGate>,
    );

    expect(replace).toHaveBeenCalledWith('/login');
  });
});

describe('when signed in', () => {
  it('renders the children for the matching role', () => {
    setSession({ status: 'authenticated', user: userOfRole('student') });
    render(
      <SessionGate role="student">
        <p>protected</p>
      </SessionGate>,
    );

    expect(screen.getByText('protected')).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
  });

  it('sends the wrong role to their own home, not to a sign-in form they are past', () => {
    setSession({ status: 'authenticated', user: userOfRole('parent') });
    render(
      <SessionGate role="student">
        <p>protected</p>
      </SessionGate>,
    );

    expect(replace).toHaveBeenCalledWith('/parent');
    expect(screen.queryByText('protected')).toBeNull();
  });

  it('shows a no-access state for a role with no home of its own', () => {
    /*
     * `users.role` accepts ten values, not two (D-293). A teacher or an admin
     * has no `/teacher` route today, so redirecting them would loop; and §5.6
     * requires the message to carry NO detail about what exists.
     */
    setSession({ status: 'authenticated', user: userOfRole('teacher') });
    render(
      <SessionGate role="student">
        <p>protected</p>
      </SessionGate>,
    );

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
    expect(screen.queryByText('protected')).toBeNull();
  });
});
