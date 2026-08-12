'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { AccountRole, PreviewState } from '@/features/auth/auth-fixtures';
import { useT } from '@/lib/i18n/i18n-provider';
import type { TranslationKey, Translator } from '@/lib/i18n/translate';

export type AuthFormKind = 'login' | 'signup' | 'verify' | 'forgot-password' | 'reset-password';

interface AuthFormProps {
  kind: AuthFormKind;
  preview: PreviewState;
  role: AccountRole;
}

const previewKeys: Record<Exclude<PreviewState, 'idle'>, TranslationKey> = {
  loading: 'auth.previewLoading',
  error: 'auth.previewError',
  'rate-limited': 'auth.previewRateLimited',
  'dependency-error': 'auth.previewDependency',
  success: 'auth.previewSuccess',
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
        className="mt-2 min-h-control w-full rounded-card border border-line bg-surface px-4 py-3 text-base font-normal text-ink outline-none transition-surface duration-micro placeholder:text-muted focus:border-brand focus:ring-4 focus:ring-brand/15"
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

function LoginFields({ role, t }: { role: AccountRole; t: Translator }) {
  return (
    <>
      <Field autoComplete="username" label={t('auth.identifierLabel')} name="identifier" />
      <Field
        autoComplete="current-password"
        label={t('auth.passwordLabel')}
        name="password"
        type="password"
      />
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <label className="inline-flex items-center gap-2 text-muted">
          <input className="h-4 w-4 accent-brand" name="remember" type="checkbox" />
          {t('auth.rememberLabel')}
        </label>
        <Link className="font-semibold text-brand hover:underline" href={`/forgot-password?role=${role}`}>
          {t('auth.forgotLink')}
        </Link>
      </div>
    </>
  );
}

function SignupFields({ role, t }: { role: AccountRole; t: Translator }) {
  return (
    <>
      <Field autoComplete="name" label={t('auth.nameLabel')} name="name" />
      <Field autoComplete="email" label={t('auth.emailLabel')} name="email" type="email" />
      <label className="block text-sm font-semibold text-ink">
        {t('auth.accountTypeLabel')}
        <select
          className="mt-2 min-h-control w-full rounded-card border border-line bg-surface px-4 py-3 text-base font-normal text-ink outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
          defaultValue={role}
          name="role"
        >
          <option value="student">{t('home.student.label')}</option>
          <option value="parent">{t('home.parent.label')}</option>
        </select>
      </label>
      <Field
        autoComplete="new-password"
        label={t('auth.passwordLabel')}
        minLength={8}
        name="password"
        type="password"
      />
      <Field
        autoComplete="new-password"
        label={t('auth.confirmPasswordLabel')}
        minLength={8}
        name="confirmPassword"
        type="password"
      />
      <label className="flex items-start gap-3 text-sm leading-6 text-muted">
        <input className="mt-1 h-4 w-4 shrink-0 accent-brand" name="terms" required type="checkbox" />
        <span>{t('auth.termsLabel')}</span>
      </label>
    </>
  );
}

function VerifyFields({ t }: { t: Translator }) {
  return (
    <Field
      autoComplete="one-time-code"
      inputMode="numeric"
      label={t('auth.codeLabel')}
      maxLength={6}
      minLength={6}
      name="code"
      pattern="[0-9]{6}"
      type="text"
    />
  );
}

function PasswordFields({
  includeCurrentIdentifier = false,
  t,
}: {
  includeCurrentIdentifier?: boolean;
  t: Translator;
}) {
  return (
    <>
      {includeCurrentIdentifier ? (
        <Field autoComplete="email" label={t('auth.emailLabel')} name="email" type="email" />
      ) : null}
      {!includeCurrentIdentifier ? (
        <>
          <Field
            autoComplete="new-password"
            label={t('auth.newPasswordLabel')}
            minLength={8}
            name="password"
            type="password"
          />
          <Field
            autoComplete="new-password"
            label={t('auth.confirmNewPasswordLabel')}
            minLength={8}
            name="confirmPassword"
            type="password"
          />
        </>
      ) : null}
    </>
  );
}

const actionKeys: Record<AuthFormKind, TranslationKey> = {
  login: 'auth.loginAction',
  signup: 'auth.signupAction',
  verify: 'auth.verifyAction',
  'forgot-password': 'auth.forgotAction',
  'reset-password': 'auth.resetAction',
};

export function AuthForm({ kind, preview, role }: AuthFormProps) {
  const t = useT();
  const [localMessage, setLocalMessage] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const isLoading = preview === 'loading';

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = data.get('password');
    const confirmation = data.get('confirmPassword');

    if (typeof confirmation === 'string' && password !== confirmation) {
      setPasswordError(t('auth.passwordMismatch'));
      setLocalMessage('');
      return;
    }

    setPasswordError('');
    setLocalMessage(t('auth.previewComplete'));
  }

  return (
    <form aria-busy={isLoading} className="space-y-6" method="post" onSubmit={handleSubmit}>
      {preview !== 'idle' ? (
        <p
          className="rounded-card border border-line bg-brand-subtle p-4 text-sm leading-6 text-ink"
          role={preview === 'success' || preview === 'loading' ? 'status' : 'alert'}
        >
          {t(previewKeys[preview])}
        </p>
      ) : null}

      {kind === 'login' ? <LoginFields role={role} t={t} /> : null}
      {kind === 'signup' ? <SignupFields role={role} t={t} /> : null}
      {kind === 'verify' ? <VerifyFields t={t} /> : null}
      {kind === 'forgot-password' ? <PasswordFields includeCurrentIdentifier t={t} /> : null}
      {kind === 'reset-password' ? <PasswordFields t={t} /> : null}

      {passwordError ? (
        <p className="text-sm font-semibold text-brand-strong" role="alert">
          {passwordError}
        </p>
      ) : null}

      <button
        className="inline-flex min-h-control w-full items-center justify-center rounded-full bg-brand px-6 py-3 text-sm font-semibold text-white shadow-raised transition-surface duration-micro hover:bg-brand-strong hover:shadow-overlay focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25 active:scale-press disabled:cursor-wait disabled:opacity-60"
        data-motion="press"
        disabled={isLoading}
        type="submit"
      >
        {isLoading ? t('auth.waitAction') : t(actionKeys[kind])}
      </button>

      {kind === 'verify' ? (
        <button
          className="min-h-control w-full rounded-full px-4 py-2 text-sm font-semibold text-brand hover:bg-brand-subtle focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25"
          type="button"
          onClick={() => setLocalMessage(t('auth.resendComplete'))}
        >
          {t('auth.resendAction')}
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
