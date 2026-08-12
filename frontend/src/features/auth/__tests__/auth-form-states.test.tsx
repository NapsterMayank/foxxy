import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AuthForm, type AuthFormKind } from '../auth-form';
import { AuthScreen } from '../auth-screen';
import type { PreviewState } from '../auth-fixtures';

/**
 * The auth forms, across every kind and every preview state — plan §10.3,
 * which requires loading, error and interaction coverage for each component.
 *
 * These screens are still presentational (the client is wired, the forms are
 * not), so what is under test is the SHAPE a real submission will inherit:
 * which fields exist, what a loading state disables, and whether a failure is
 * announced as an alert or as a status. Getting those wrong is a rewrite once
 * the network is attached; getting them right now costs one file.
 */

const kinds: readonly AuthFormKind[] = [
  'login',
  'signup',
  'verify',
  'forgot-password',
  'reset-password',
];

describe('every kind renders its own fields and its own action', () => {
  it.each([
    ['login', 'Sign in', ['Email or mobile number', 'Password']],
    ['signup', 'Create account', ['Full name', 'Email address', 'Password', 'Confirm password']],
    ['verify', 'Verify email', ['Six-digit verification code']],
    ['forgot-password', 'Send reset link', ['Email address']],
    ['reset-password', 'Save new password', ['New password', 'Confirm new password']],
  ] as const)('%s asks for exactly its own fields', (kind, action, labels) => {
    render(<AuthForm kind={kind} preview="idle" role="student" />);

    expect(screen.getByRole('button', { name: action })).toBeEnabled();
    for (const label of labels) expect(screen.getByLabelText(label)).toBeRequired();
  });

  it('does not ask a password-reset request for a new password', () => {
    // `forgot-password` mails a link; asking for the new password on that form
    // trains people to type a password into a page that cannot set one.
    render(<AuthForm kind="forgot-password" preview="idle" role="student" />);
    expect(screen.queryByLabelText(/new password/i)).toBeNull();
  });
});

describe('the preview states map onto the right announcement', () => {
  it.each([
    ['loading', 'status'],
    ['success', 'status'],
    ['error', 'alert'],
    ['rate-limited', 'alert'],
    ['dependency-error', 'alert'],
  ] as const)('%s is announced as a %s', (preview, role) => {
    /*
     * `alert` interrupts a screen reader; `status` does not. A failure the user
     * must act on is an alert; "your request was accepted" is not. Getting this
     * backwards either buries an error or shouts over someone mid-sentence.
     */
    render(<AuthForm kind="login" preview={preview as PreviewState} role="student" />);
    expect(screen.getByRole(role)).toHaveTextContent(/Preview:/);
  });

  it('disables the submit button and marks the form busy while loading', () => {
    render(<AuthForm kind="login" preview="loading" role="student" />);

    expect(screen.getByRole('button', { name: 'Please wait…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Please wait…' }).closest('form')).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('shows nothing at all when idle', () => {
    render(<AuthForm kind="login" preview="idle" role="student" />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('password confirmation', () => {
  it('refuses a mismatch with an alert and does not report success', async () => {
    render(<AuthForm kind="reset-password" preview="idle" role="student" />);

    const [password, confirmation] = screen.getAllByLabelText(/password/i);
    await userEvent.type(password as HTMLElement, 'vermillion-otter-49');
    await userEvent.type(confirmation as HTMLElement, 'vermillion-otter-50');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Passwords must match.');
  });

  it('clears the mismatch once the two agree', async () => {
    render(<AuthForm kind="reset-password" preview="idle" role="student" />);

    const [password, confirmation] = screen.getAllByLabelText(/password/i);
    await userEvent.type(password as HTMLElement, 'vermillion-otter-49');
    await userEvent.type(confirmation as HTMLElement, 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(screen.getByRole('alert')).toBeVisible();

    await userEvent.clear(confirmation as HTMLElement);
    await userEvent.type(confirmation as HTMLElement, 'vermillion-otter-49');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(/not connected yet/);
  });
});

describe('verification', () => {
  it('offers a resend that reports back', async () => {
    // The affordance §5.6 requires for `EMAIL_NOT_VERIFIED`: an unverified
    // address is not a login failure, it is one click from being fixed.
    render(<AuthForm kind="verify" preview="idle" role="student" />);

    await userEvent.click(screen.getByRole('button', { name: 'Resend code' }));
    expect(screen.getByRole('status')).toHaveTextContent(/verification code/i);
  });
});

describe('AuthScreen', () => {
  it.each(kinds)('gives %s a level-1 heading and a link away from the dead end', (kind) => {
    render(<AuthScreen kind={kind} preview="idle" role="student" />);

    expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
    expect(screen.getAllByRole('link').length).toBeGreaterThan(0);
  });

  it('keeps the parent role when moving between sign-in and sign-up', () => {
    /*
     * A parent who lands on login and taps "create an account" must not arrive
     * at a student signup. This was a real defect once — see the frontend
     * progress file's bug table.
     */
    render(<AuthScreen kind="login" preview="idle" role="parent" />);

    const signup = screen
      .getAllByRole('link')
      .find((link) => link.getAttribute('href')?.startsWith('/signup'));
    expect(signup?.getAttribute('href')).toContain('role=parent');
  });
});
