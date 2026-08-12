import { cleanup, screen } from '@testing-library/react';
import { renderServer } from '@test/setup/render';
import { createTranslator } from '@/lib/i18n/translate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAccountRole } from '@/features/auth/auth-fixtures';
import { AuthScreen } from '@/features/auth/auth-screen';

/*
 * `getServerT` reaches for `next/headers`, which only exists inside a request.
 * The real dictionary is still used; only the cookie read is replaced.
 */
vi.mock('@/lib/i18n/server', () => ({
  getServerT: () => Promise.resolve(createTranslator('en')),
  getServerLanguage: () => Promise.resolve('en'),
}));

/*
 * The screens are server components now holding CLIENT children that read the
 * URL. `useSearchParams` has no router in a test, so it is faked here — the
 * behaviour that depends on its values is tested against the form directly in
 * `auth-form-states.test.tsx`.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/login',
}));

afterEach(cleanup);

describe('auth presentation', () => {
  it('accepts only supported role query values', () => {
    expect(parseAccountRole('parent')).toBe('parent');
    expect(parseAccountRole('admin')).toBe('student');
    // An array means the parameter was repeated. Picking one silently is a
    // guess; falling back to the safer role is a decision.
    expect(parseAccountRole(['parent'])).toBe('student');
  });

  it('renders the parent login journey with safe navigation', async () => {
    // An async server component: called, then its output rendered.
    await renderServer(AuthScreen({ kind: 'login', role: 'parent' }));

    expect(
      screen.getByRole('heading', { name: 'Sign in to continue as a parent' }),
    ).toBeInTheDocument();

    /*
     * `email`, NOT `identifier`. The presentational form asked for "Email or
     * mobile number" and named the control `identifier`; `loginRequestSchema`
     * has one field and it is `email`. Nothing would have matched.
     */
    expect(screen.getByLabelText(/^Email address/)).toHaveAttribute('autocomplete', 'username');

    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
      'href',
      '/forgot-password?role=parent',
    );
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/signup?role=parent',
    );
  });

  it('gives the verify screen no code field, because no code endpoint exists', async () => {
    await renderServer(AuthScreen({ kind: 'verify', role: 'student' }));

    expect(screen.queryByLabelText(/verification code/i)).not.toBeInTheDocument();
    // Opened without a token, the screen says so rather than sitting blank.
    expect(screen.getByRole('alert')).toHaveTextContent('This link is incomplete.');
  });
});
