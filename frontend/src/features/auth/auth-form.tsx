'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { FormField } from '@/components/patterns/form-field';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import type { AccountRole } from '@/features/auth/auth-fixtures';
import {
  useForgotPassword,
  useLogin,
  useResetPassword,
  useSignup,
} from '@/features/auth/hooks/use-auth-mutations';
import { authFieldMessage, authFormMessage } from '@/features/auth/lib/auth-messages';
import { isApiError } from '@/lib/api/errors';
import {
  forgotPasswordRequestSchema,
  loginRequestSchema,
  resetPasswordRequestSchema,
  signupRequestSchema,
} from '@/lib/api/generated/contracts/identity.contract';
import { fieldIssues, type FieldIssues } from '@/lib/forms/field-issues';
import { useT } from '@/lib/i18n/i18n-provider';
import type { TranslationKey, Translator } from '@/lib/i18n/translate';

export type AuthFormKind = 'login' | 'signup' | 'forgot-password' | 'reset-password';

interface AuthFormProps {
  kind: AuthFormKind;
  role: AccountRole;
}

const actionKeys: Record<AuthFormKind, TranslationKey> = {
  login: 'auth.loginAction',
  signup: 'auth.signupAction',
  'forgot-password': 'auth.forgotAction',
  'reset-password': 'auth.resetAction',
};

/**
 * Where a sign-in lands with no `?next=` to honour.
 *
 * ===========================================================================
 * THE ROLE COMES FROM THE RESPONSE, NEVER FROM `?role=`.
 *
 * The query parameter dresses the screen — heading and illustration — and
 * anyone can type it. Sending a student who opened `/login?role=parent` to
 * `/parent` hands them a route their own session gate refuses, so a correct
 * sign-in ends in a bounce that reads as a broken login.
 *
 * `users.role` holds ten values (D-293), not two, so anything that is not a
 * parent lands on the student home rather than being enumerated here — a
 * `teacher` account arriving one day gets a real page, not a dead branch.
 * ===========================================================================
 */
function homeFor(accountRole: string): string {
  return accountRole === 'parent' ? '/parent' : '/student';
}

/**
 * ===========================================================================
 * `?next=` IS UNTRUSTED INPUT AND IS TREATED AS SUCH.
 *
 * It arrives in a URL anyone can send to anyone. `router.replace(next)` with no
 * check is an open redirect: `/login?next=https://evil.example/login` sends a
 * person who just typed their password to a page that looks like this one.
 *
 * Only a SAME-DOCUMENT ABSOLUTE PATH is honoured. A value starting `//` is
 * rejected too — `//evil.example` is protocol-relative and a browser reads it
 * as another origin, which is the case a naive "must start with /" check waves
 * straight through.
 * ===========================================================================
 */
export function safeNextPath(value: string | null): string | null {
  if (value === null || !value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

interface SubmitState {
  readonly fields: FieldIssues;
  readonly formMessage: string | null;
  readonly successMessage: string | null;
}

const EMPTY: SubmitState = { fields: {}, formMessage: null, successMessage: null };

export function AuthForm({ kind, role }: AuthFormProps) {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<SubmitState>(EMPTY);
  /*
   * Separate from `state.fields` because it is not a Zod issue and never comes
   * from the wire — see the confirmation-field note in `handleSubmit`.
   */
  const [mismatch, setMismatch] = useState(false);

  const loginMutation = useLogin();
  const signupMutation = useSignup();
  const forgotMutation = useForgotPassword();
  const resetMutation = useResetPassword();

  const isPending =
    loginMutation.isPending ||
    signupMutation.isPending ||
    forgotMutation.isPending ||
    resetMutation.isPending;

  function failWith(error: unknown, credentialVerdict = false): void {
    /*
     * A NON-`ApiError` IS RE-THROWN, NOT SWALLOWED. Everything leaving the API
     * client is an `ApiError` by construction; anything else is a bug in this
     * component, and turning it into "something went wrong" on screen is how it
     * survives to production.
     */
    if (!isApiError(error)) throw error;
    setState({
      fields: {},
      formMessage: authFormMessage(error, t, { credentialVerdict }),
      successMessage: null,
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const read = (name: string): string => {
      const value = data.get(name);
      return typeof value === 'string' ? value : '';
    };

    /*
     * THE CONFIRMATION FIELD IS CHECKED HERE AND NOWHERE ELSE. It has no wire
     * representation — the backend never receives it — so no generated schema
     * can have an opinion about it. Checked BEFORE the schema so that the
     * message lands on the confirmation field rather than being hidden behind
     * an unrelated complaint about the password itself.
     */
    if (kind === 'signup' || kind === 'reset-password') {
      if (read('password') !== read('confirmPassword')) {
        setState({
          fields: {},
          formMessage: null,
          successMessage: null,
        });
        setMismatch(true);
        return;
      }
      setMismatch(false);
    }


    if (kind === 'login') {
      const parsed = loginRequestSchema.safeParse({
        email: read('email'),
        password: read('password'),
      });
      if (!parsed.success) return setState({ ...EMPTY, fields: fieldIssues(parsed.error) });

      loginMutation.mutate(parsed.data, {
        onSuccess: (data) => {
          const next = safeNextPath(searchParams.get('next'));
          router.replace(next ?? homeFor(data.user.role));
        },
        onError: (error) => {
          failWith(error, true);
        },
      });
      return;
    }

    if (kind === 'signup') {
      const parsed = signupRequestSchema.safeParse({
        email: read('email'),
        password: read('password'),
        role: read('role'),
      });

      /*
       * THE TERMS BOX IS CHECKED IN JAVASCRIPT BECAUSE THE FORM IS `noValidate`.
       *
       * It carries `required`, and that attribute did the work while the form
       * relied on browser validation. `noValidate` is deliberate — the browser's
       * bubbles are untranslated, unstyled and announce nothing useful, and
       * every other rule here comes from the contract — but switching it on
       * silently disarmed the one control the browser was enforcing. A consent
       * gate that stops gating is worse than no gate: it still looks present.
       *
       * REPORTED ALONGSIDE THE FIELD ERRORS, not before them. Bailing early on
       * the checkbox hides every other problem until it is ticked, so a form
       * with three faults is fixed in three rounds instead of one.
       */
      const termsMissing = data.get('terms') === null;
      if (!parsed.success || termsMissing) {
        setState({
          fields: parsed.success ? {} : fieldIssues(parsed.error),
          formMessage: termsMissing ? t('auth.errorTermsRequired') : null,
          successMessage: null,
        });
        return;
      }

      signupMutation.mutate(parsed.data, {
        onSuccess: () => {
          setState({ ...EMPTY, successMessage: t('auth.signupSuccess') });
        },
        onError: (error) => {
          failWith(error);
        },
      });
      return;
    }

    if (kind === 'forgot-password') {
      const parsed = forgotPasswordRequestSchema.safeParse({ email: read('email') });
      if (!parsed.success) return setState({ ...EMPTY, fields: fieldIssues(parsed.error) });

      forgotMutation.mutate(parsed.data, {
        /*
         * THE SAME LINE WHETHER OR NOT THE ADDRESS EXISTS. The endpoint returns
         * a constant response for exactly this reason (§6.2, the enumeration
         * trap) and a screen that said "no such account" would hand the
         * enumeration back on a platform used by children.
         */
        onSuccess: () => {
          setState({ ...EMPTY, successMessage: t('auth.forgotSent') });
        },
        onError: (error) => {
          failWith(error);
        },
      });
      return;
    }

    const parsed = resetPasswordRequestSchema.safeParse({
      token: searchParams.get('token') ?? undefined,
      password: read('password'),
    });
    if (!parsed.success) return setState({ ...EMPTY, fields: fieldIssues(parsed.error) });

    resetMutation.mutate(parsed.data, {
      onSuccess: () => {
        setState({ ...EMPTY, successMessage: t('auth.resetSuccess') });
      },
      onError: (error) => {
          failWith(error);
        },
    });
  }

  const errorFor = (field: string): string | undefined => {
    const issue = state.fields[field];
    return issue === undefined ? undefined : authFieldMessage(field, issue, t);
  };

  return (
    <form aria-busy={isPending} className="space-y-6" method="post" onSubmit={handleSubmit} noValidate>
      {state.formMessage === null ? null : (
        <p
          className="rounded-card border border-danger/30 bg-danger/5 p-4 text-sm leading-body text-danger"
          role="alert"
        >
          {state.formMessage}
        </p>
      )}

      {state.successMessage === null ? null : (
        <p
          className="rounded-card border border-line bg-brand-subtle p-4 text-sm leading-body text-ink"
          role="status"
        >
          {state.successMessage}
        </p>
      )}

      {kind === 'login' ? <LoginFields error={errorFor} role={role} t={t} /> : null}
      {kind === 'signup' ? (
        <SignupFields error={errorFor} mismatch={mismatch} role={role} t={t} />
      ) : null}
      {kind === 'forgot-password' ? <ForgotFields error={errorFor} t={t} /> : null}
      {kind === 'reset-password' ? (
        <ResetFields error={errorFor} mismatch={mismatch} t={t} />
      ) : null}

      <Button className="w-full" disabled={isPending} type="submit">
        {isPending ? t('auth.waitAction') : t(actionKeys[kind])}
      </Button>
    </form>
  );
}

type ErrorLookup = (field: string) => string | undefined;

function LoginFields({
  error,
  role,
  t,
}: {
  error: ErrorLookup;
  role: AccountRole;
  t: Translator;
}) {
  return (
    <>
      <FormField error={error('email')} label={t('auth.emailLabel')} required>
        <Input autoComplete="username" name="email" type="email" />
      </FormField>
      <FormField error={error('password')} label={t('auth.passwordLabel')} required>
        <Input autoComplete="current-password" name="password" type="password" />
      </FormField>

      {/*
        THE "REMEMBER ME" CHECKBOX IS GONE, NOT MOVED.

        `loginRequestSchema` is `{ email, password }` and nothing in the
        identity module reads a remember flag or varies the session lifetime —
        so the box was a promise about how long the sign-in lasts that nothing
        could keep. Ticking it and untucking it produced the same request. A
        control that silently does nothing is worse than an absent one: it is
        the reason somebody does not tick it again next time.
      */}
      <div className="flex justify-end text-sm">
        <Link
          className="font-semibold text-brand hover:underline"
          href={`/forgot-password?role=${role}`}
        >
          {t('auth.forgotLink')}
        </Link>
      </div>
    </>
  );
}

function SignupFields({
  error,
  mismatch,
  role,
  t,
}: {
  error: ErrorLookup;
  mismatch: boolean;
  role: AccountRole;
  t: Translator;
}) {
  return (
    <>
      <FormField error={error('email')} label={t('auth.emailLabel')} required>
        <Input autoComplete="email" name="email" type="email" />
      </FormField>

      {/*
        THE ROLE SELECT OFFERS TWO VALUES BECAUSE `roleSchema` HAS TWO.
        `users.role` accepts ten, and the contract keeps the signup schema
        separate from the row schema precisely so a dropdown built from the
        wrong one cannot hand the internet a `super_admin` option (D-293).
      */}
      <FormField error={error('role')} label={t('auth.accountTypeLabel')} required>
        <Select defaultValue={role} name="role">
          <option value="student">{t('home.student.label')}</option>
          <option value="parent">{t('home.parent.label')}</option>
        </Select>
      </FormField>

      <FormField error={error('password')} label={t('auth.passwordLabel')} required>
        <Input autoComplete="new-password" name="password" type="password" />
      </FormField>
      <FormField
        error={mismatch ? t('auth.passwordMismatch') : undefined}
        label={t('auth.confirmPasswordLabel')}
        required
      >
        <Input autoComplete="new-password" name="confirmPassword" type="password" />
      </FormField>

      <label className="flex items-start gap-3 text-sm leading-6 text-muted">
        <input className="mt-1 h-4 w-4 shrink-0 accent-brand" name="terms" required type="checkbox" />
        <span>{t('auth.termsLabel')}</span>
      </label>
    </>
  );
}

function ForgotFields({ error, t }: { error: ErrorLookup; t: Translator }) {
  return (
    <FormField error={error('email')} label={t('auth.emailLabel')} required>
      <Input autoComplete="email" name="email" type="email" />
    </FormField>
  );
}

function ResetFields({
  error,
  mismatch,
  t,
}: {
  error: ErrorLookup;
  mismatch: boolean;
  t: Translator;
}) {
  return (
    <>
      {/*
        The token comes from the URL, never from a control. It is a 512-character
        opaque string in a link, and the only reason a person would ever see a
        field for it is if the link were broken — at which point `token` carries
        the issue and this message explains what to do.
      */}
      {error('token') === undefined ? null : (
        <p className="text-sm font-semibold leading-body text-danger" role="alert">
          {error('token')}
        </p>
      )}
      <FormField error={error('password')} label={t('auth.newPasswordLabel')} required>
        <Input autoComplete="new-password" name="password" type="password" />
      </FormField>
      <FormField
        error={mismatch ? t('auth.passwordMismatch') : undefined}
        label={t('auth.confirmNewPasswordLabel')}
        required
      >
        <Input autoComplete="new-password" name="confirmPassword" type="password" />
      </FormField>
    </>
  );
}
