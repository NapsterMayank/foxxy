import Link from 'next/link';
import { AuthForm, type AuthFormKind } from '@/features/auth/auth-form';
import type { AccountRole, PreviewState } from '@/features/auth/auth-fixtures';
import { AuthShell } from '@/features/auth/auth-shell';

interface AuthScreenProps {
  kind: AuthFormKind;
  preview: PreviewState;
  role: AccountRole;
}

const copy: Record<AuthFormKind, { description: string; eyebrow: string; title: string }> = {
  login: {
    eyebrow: 'Welcome back',
    title: 'Sign in to continue',
    description: 'Use the account details connected to your learning space.',
  },
  signup: {
    eyebrow: 'Join Alfanumrik',
    title: 'Create your account',
    description: 'Start with the essentials. Learning preferences come next.',
  },
  verify: {
    eyebrow: 'One quick check',
    title: 'Verify your email',
    description: 'Enter the six-digit code sent to your email address.',
  },
  'forgot-password': {
    eyebrow: 'Account recovery',
    title: 'Reset your password',
    description: 'Enter your email and we will send password reset instructions.',
  },
  'reset-password': {
    eyebrow: 'Account recovery',
    title: 'Choose a new password',
    description: 'Use at least eight characters and keep your password private.',
  },
};

function Footer({ kind, role }: { kind: AuthFormKind; role: AccountRole }) {
  if (kind === 'login') {
    return (
      <>
        New here?{' '}
        <Link className="font-semibold text-brand hover:underline" href={`/signup?role=${role}`}>
          Create an account
        </Link>
      </>
    );
  }

  return (
    <>
      Already have an account?{' '}
      <Link className="font-semibold text-brand hover:underline" href={`/login?role=${role}`}>
        Sign in
      </Link>
    </>
  );
}

export function AuthScreen({ kind, preview, role }: AuthScreenProps) {
  const content = copy[kind];
  const title = kind === 'login' ? `${content.title} as a ${role}` : content.title;

  return (
    <AuthShell
      description={content.description}
      eyebrow={content.eyebrow}
      footer={<Footer kind={kind} role={role} />}
      role={role}
      title={title}
    >
      <AuthForm kind={kind} preview={preview} role={role} />
    </AuthShell>
  );
}
