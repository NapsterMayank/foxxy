import Link from 'next/link';
import { AuthForm, type AuthFormKind } from '@/features/auth/auth-form';
import type { AccountRole, PreviewState } from '@/features/auth/auth-fixtures';
import { AuthShell } from '@/features/auth/auth-shell';
import { getServerT } from '@/lib/i18n/server';
import type { TranslationKey, Translator } from '@/lib/i18n/translate';

interface AuthScreenProps {
  kind: AuthFormKind;
  preview: PreviewState;
  role: AccountRole;
}

/**
 * The dictionary keys for each kind of auth screen.
 *
 * A TABLE rather than string building (`auth.${kind}Title`): a computed key is
 * a key the compiler cannot check, and `TranslationKey` exists precisely so a
 * typo fails the build instead of rendering an empty heading.
 */
const copyKeys: Record<
  AuthFormKind,
  { description: TranslationKey; eyebrow: TranslationKey; title: TranslationKey }
> = {
  login: {
    eyebrow: 'auth.loginEyebrow',
    title: 'auth.loginTitle',
    description: 'auth.loginDescription',
  },
  signup: {
    eyebrow: 'auth.signupEyebrow',
    title: 'auth.signupTitle',
    description: 'auth.signupDescription',
  },
  verify: {
    eyebrow: 'auth.verifyEyebrow',
    title: 'auth.verifyTitle',
    description: 'auth.verifyDescription',
  },
  'forgot-password': {
    eyebrow: 'auth.forgotEyebrow',
    title: 'auth.forgotTitle',
    description: 'auth.forgotDescription',
  },
  'reset-password': {
    eyebrow: 'auth.resetEyebrow',
    title: 'auth.resetTitle',
    description: 'auth.resetDescription',
  },
};

/**
 * The role-specific sign-in headings are WHOLE SENTENCES, not "Sign in as a" +
 * role. Hindi does not put the role where English does, and a sentence
 * assembled from fragments is untranslatable by construction.
 */
const loginTitleByRole: Record<AccountRole, TranslationKey> = {
  student: 'auth.loginTitleStudent',
  parent: 'auth.loginTitleParent',
};

function Footer({ kind, role, t }: { kind: AuthFormKind; role: AccountRole; t: Translator }) {
  if (kind === 'login') {
    return (
      <>
        {t('auth.footerNewHere')}{' '}
        <Link className="font-semibold text-brand hover:underline" href={`/signup?role=${role}`}>
          {t('auth.footerCreate')}
        </Link>
      </>
    );
  }

  return (
    <>
      {t('auth.footerHaveAccount')}{' '}
      <Link className="font-semibold text-brand hover:underline" href={`/login?role=${role}`}>
        {t('auth.footerSignIn')}
      </Link>
    </>
  );
}

export async function AuthScreen({ kind, preview, role }: AuthScreenProps) {
  const t = await getServerT();
  const keys = copyKeys[kind];
  const title = kind === 'login' ? t(loginTitleByRole[role]) : t(keys.title);

  return (
    <AuthShell
      description={t(keys.description)}
      eyebrow={t(keys.eyebrow)}
      footer={<Footer kind={kind} role={role} t={t} />}
      role={role}
      t={t}
      title={title}
    >
      <AuthForm kind={kind} preview={preview} role={role} />
    </AuthShell>
  );
}
