'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { AccountRole, PreviewState } from '@/features/auth/auth-fixtures';

export type AuthFormKind = 'login' | 'signup' | 'verify' | 'forgot-password' | 'reset-password';

interface AuthFormProps {
  kind: AuthFormKind;
  preview: PreviewState;
  role: AccountRole;
}

const previewMessages: Record<Exclude<PreviewState, 'idle'>, string> = {
  loading: 'Preview: the request is taking longer than usual.',
  error: 'Preview: review your details and try again.',
  'rate-limited': 'Preview: too many attempts. Please wait before trying again.',
  'dependency-error': 'Preview: this service is temporarily unavailable.',
  success: 'Preview: your request was accepted.',
};

function Field({
  autoComplete,
  inputMode,
  label,
  maxLength,
  minLength,
  name,
  pattern,
  type = 'text',
}: {
  autoComplete: string;
  inputMode?: 'numeric';
  label: string;
  maxLength?: number;
  minLength?: number;
  name: string;
  pattern?: string;
  type?: 'email' | 'password' | 'tel' | 'text';
}) {
  return (
    <label className="block text-sm font-semibold text-ink">
      {label}
      <input
        autoComplete={autoComplete}
        className="mt-2 min-h-control w-full rounded-card border border-line bg-surface px-4 py-3 text-base font-normal text-ink outline-none transition-surface duration-150 placeholder:text-muted focus:border-brand focus:ring-4 focus:ring-brand/15"
        inputMode={inputMode}
        maxLength={maxLength}
        minLength={minLength}
        name={name}
        pattern={pattern}
        required
        type={type}
      />
    </label>
  );
}

function LoginFields({ role }: { role: AccountRole }) {
  return (
    <>
      <Field autoComplete="username" label="Email or mobile number" name="identifier" />
      <Field autoComplete="current-password" label="Password" name="password" type="password" />
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <label className="inline-flex items-center gap-2 text-muted">
          <input className="h-4 w-4 accent-brand" name="remember" type="checkbox" />
          Remember me
        </label>
        <Link className="font-semibold text-brand hover:underline" href={`/forgot-password?role=${role}`}>
          Forgot password?
        </Link>
      </div>
    </>
  );
}

function SignupFields({ role }: { role: AccountRole }) {
  return (
    <>
      <Field autoComplete="name" label="Full name" name="name" />
      <Field autoComplete="email" label="Email address" name="email" type="email" />
      <label className="block text-sm font-semibold text-ink">
        Account type
        <select
          className="mt-2 min-h-control w-full rounded-card border border-line bg-surface px-4 py-3 text-base font-normal text-ink outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
          defaultValue={role}
          name="role"
        >
          <option value="student">Student</option>
          <option value="parent">Parent</option>
        </select>
      </label>
      <Field autoComplete="new-password" label="Password" minLength={8} name="password" type="password" />
      <Field
        autoComplete="new-password"
        label="Confirm password"
        minLength={8}
        name="confirmPassword"
        type="password"
      />
      <label className="flex items-start gap-3 text-sm leading-6 text-muted">
        <input className="mt-1 h-4 w-4 shrink-0 accent-brand" name="terms" required type="checkbox" />
        <span>I agree to the Terms and Conditions and Privacy Policy.</span>
      </label>
    </>
  );
}

function VerifyFields() {
  return (
    <Field
      autoComplete="one-time-code"
      inputMode="numeric"
      label="Six-digit verification code"
      maxLength={6}
      minLength={6}
      name="code"
      pattern="[0-9]{6}"
      type="text"
    />
  );
}

function PasswordFields({ includeCurrentIdentifier = false }: { includeCurrentIdentifier?: boolean }) {
  return (
    <>
      {includeCurrentIdentifier ? (
        <Field autoComplete="email" label="Email address" name="email" type="email" />
      ) : null}
      {!includeCurrentIdentifier ? (
        <>
          <Field autoComplete="new-password" label="New password" minLength={8} name="password" type="password" />
          <Field
            autoComplete="new-password"
            label="Confirm new password"
            minLength={8}
            name="confirmPassword"
            type="password"
          />
        </>
      ) : null}
    </>
  );
}

const actionLabels: Record<AuthFormKind, string> = {
  login: 'Sign in',
  signup: 'Create account',
  verify: 'Verify email',
  'forgot-password': 'Send reset link',
  'reset-password': 'Save new password',
};

export function AuthForm({ kind, preview, role }: AuthFormProps) {
  const [localMessage, setLocalMessage] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const isLoading = preview === 'loading';

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = data.get('password');
    const confirmation = data.get('confirmPassword');

    if (typeof confirmation === 'string' && password !== confirmation) {
      setPasswordError('Passwords must match.');
      setLocalMessage('');
      return;
    }

    setPasswordError('');
    setLocalMessage('Preview complete. Backend integration is not connected yet.');
  }

  return (
    <form aria-busy={isLoading} className="space-y-5" method="post" onSubmit={handleSubmit}>
      {preview !== 'idle' ? (
        <p
          className="rounded-card border border-line bg-brand-subtle p-4 text-sm leading-6 text-ink"
          role={preview === 'success' || preview === 'loading' ? 'status' : 'alert'}
        >
          {previewMessages[preview]}
        </p>
      ) : null}

      {kind === 'login' ? <LoginFields role={role} /> : null}
      {kind === 'signup' ? <SignupFields role={role} /> : null}
      {kind === 'verify' ? <VerifyFields /> : null}
      {kind === 'forgot-password' ? <PasswordFields includeCurrentIdentifier /> : null}
      {kind === 'reset-password' ? <PasswordFields /> : null}

      {passwordError ? (
        <p className="text-sm font-semibold text-brand-strong" role="alert">
          {passwordError}
        </p>
      ) : null}

      <button
        className="inline-flex min-h-control w-full items-center justify-center rounded-full bg-brand px-6 py-3 text-sm font-semibold text-white shadow-raised transition-surface duration-150 hover:bg-brand-strong hover:shadow-overlay focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25 active:scale-press disabled:cursor-wait disabled:opacity-60"
        data-motion="press"
        disabled={isLoading}
        type="submit"
      >
        {isLoading ? 'Please wait…' : actionLabels[kind]}
      </button>

      {kind === 'verify' ? (
        <button
          className="min-h-control w-full rounded-full px-4 py-2 text-sm font-semibold text-brand hover:bg-brand-subtle focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25"
          type="button"
          onClick={() => setLocalMessage('Preview complete. A new verification code would be requested here.')}
        >
          Resend code
        </button>
      ) : null}

      {localMessage ? (
        <p className="text-center text-sm leading-6 text-muted" role="status">
          {localMessage}
        </p>
      ) : null}
    </form>
  );
}
