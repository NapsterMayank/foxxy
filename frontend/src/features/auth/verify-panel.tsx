'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { FormField } from '@/components/patterns/form-field';
import { Button } from '@/components/ui/button';
import { ButtonLink } from '@/components/ui/button-link';
import { Input } from '@/components/ui/input';
import {
  useResendVerification,
  useVerifyEmail,
} from '@/features/auth/hooks/use-auth-mutations';
import { authFieldMessage, authFormMessage } from '@/features/auth/lib/auth-messages';
import { isApiError } from '@/lib/api/errors';
import { resendVerificationRequestSchema } from '@/lib/api/generated/contracts/identity.contract';
import { fieldIssues, type FieldIssues } from '@/lib/forms/field-issues';
import { useT } from '@/lib/i18n/i18n-provider';

/**
 * ===========================================================================
 * EMAIL VERIFICATION — A LINK, NOT A CODE.
 *
 * The screen this replaces asked for a six-digit code. NO SUCH ENDPOINT HAS
 * EVER EXISTED: verification is `GET /api/v1/auth/verify?token=`, an opaque
 * token in the link the signup email contains. The code field was invented by
 * the presentational stage and would have failed against every backend build.
 *
 * So this page has no primary input at all. It reads the token out of the URL
 * it was opened with and reports the outcome. The only control is the RESEND
 * affordance §5.6 requires, which needs an email address because
 * `/auth/resend-verification` takes one — the person arriving here with a dead
 * link is not signed in, so nothing else can supply it.
 * ===========================================================================
 */
export function VerifyPanel() {
  const t = useT();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const verify = useVerifyEmail();
  const resend = useResendVerification();

  const [resendFields, setResendFields] = useState<FieldIssues>({});
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  /*
   * FIRED ONCE, AND THE GUARD IS NOT DEFENSIVE PROGRAMMING.
   *
   * Verification CONSUMES the token. React runs effects twice on mount in
   * development StrictMode, so without this the second call arrives after the
   * first has already spent the token, fails, and paints "this link has expired"
   * over a verification that actually succeeded — in development only, which is
   * the worst place for a bug to live.
   */
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || token === null) return;
    startedRef.current = true;
    verify.mutate(token);
  }, [token, verify]);

  function handleResend(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('email');
    const parsed = resendVerificationRequestSchema.safeParse({
      email: typeof value === 'string' ? value : '',
    });

    if (!parsed.success) {
      setResendFields(fieldIssues(parsed.error));
      setResendMessage(null);
      return;
    }

    setResendFields({});
    resend.mutate(parsed.data, {
      // Constant copy whether or not the address exists — the endpoint returns
      // a constant response so this screen cannot become the enumeration oracle
      // the contract is shaped to prevent.
      onSuccess: () => {
        setResendMessage(t('auth.resendSent'));
      },
      onError: (error) => {
        if (!isApiError(error)) throw error;
        setResendMessage(authFormMessage(error, t));
      },
    });
  }

  const emailIssue = resendFields.email;

  return (
    <div className="space-y-6">
      {token === null ? (
        <p className="rounded-card border border-danger/30 bg-danger/5 p-4 text-sm leading-body text-danger" role="alert">
          {t('auth.verifyMissingToken')}
        </p>
      ) : null}

      {verify.isPending ? (
        <p className="rounded-card border border-line bg-brand-subtle p-4 text-sm leading-body text-ink" role="status">
          {t('auth.verifyPending')}
        </p>
      ) : null}

      {verify.isSuccess ? (
        <p className="rounded-card border border-line bg-brand-subtle p-4 text-sm leading-body text-ink" role="status">
          {t('auth.verifySuccess')}
        </p>
      ) : null}

      {verify.isError ? (
        <p className="rounded-card border border-danger/30 bg-danger/5 p-4 text-sm leading-body text-danger" role="alert">
          {authFormMessage(verify.error, t)}
        </p>
      ) : null}

      {verify.isSuccess ? (
        <ButtonLink className="w-full" href="/login" label={t('auth.footerSignIn')}>
          {t('auth.footerSignIn')}
        </ButtonLink>
      ) : (
        <form className="space-y-4" method="post" noValidate onSubmit={handleResend}>
          <FormField
            error={emailIssue === undefined ? undefined : authFieldMessage('email', emailIssue, t)}
            hint={t('auth.resendEmailHint')}
            label={t('auth.emailLabel')}
            required
          >
            <Input autoComplete="email" name="email" type="email" />
          </FormField>

          <Button className="w-full" disabled={resend.isPending} type="submit">
            {resend.isPending ? t('auth.waitAction') : t('auth.resendAction')}
          </Button>

          {resendMessage === null ? null : (
            <p className="text-center text-sm leading-body text-muted" role="status">
              {resendMessage}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
