import { cleanup, fireEvent,  screen } from '@testing-library/react';
import { renderClient as render, renderServer } from '@test/setup/render';
import { createTranslator } from '@/lib/i18n/translate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthForm } from '@/features/auth/auth-form';
import { parseAccountRole, parsePreviewState } from '@/features/auth/auth-fixtures';
import { AuthScreen } from '@/features/auth/auth-screen';

/*
 * `getServerT` reaches for `next/headers`, which only exists inside a request.
 * The real dictionary is still used; only the cookie read is replaced.
 */
vi.mock('@/lib/i18n/server', () => ({
  getServerT: () => Promise.resolve(createTranslator('en')),
  getServerLanguage: () => Promise.resolve('en'),
}));


afterEach(cleanup);

describe('auth presentation', () => {
  it('accepts only supported role and preview query values', () => {
    expect(parseAccountRole('parent')).toBe('parent');
    expect(parseAccountRole('admin')).toBe('student');
    expect(parseAccountRole(['parent'])).toBe('student');
    expect(parsePreviewState('rate-limited')).toBe('rate-limited');
    expect(parsePreviewState('unknown')).toBe('idle');
  });

  it('renders the parent login journey with safe navigation', async () => {
    // An async server component: called, then its output rendered.
    await renderServer(AuthScreen({ kind: 'login', preview: 'idle', role: 'parent' }));

    expect(screen.getByRole('heading', { name: 'Sign in to continue as a parent' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email or mobile number')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
      'href',
      '/forgot-password?role=parent',
    );
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/signup?role=parent',
    );
  });

  it('shows preview states without calling an API', () => {
    render(<AuthForm kind="login" preview="rate-limited" role="student" />);

    expect(screen.getByRole('alert')).toHaveTextContent('too many attempts');
  });

  it('checks matching passwords before completing the signup preview', () => {
    render(<AuthForm kind="signup" preview="idle" role="student" />);

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password-one' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password-two' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }).closest('form')!);

    expect(screen.getByRole('alert')).toHaveTextContent('Passwords must match.');
  });
});
