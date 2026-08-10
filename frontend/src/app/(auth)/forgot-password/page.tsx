import type { Metadata } from 'next';
import { parseAccountRole, parsePreviewState } from '@/features/auth/auth-fixtures';
import { AuthScreen } from '@/features/auth/auth-screen';

export const metadata: Metadata = { title: 'Forgot password' };

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ preview?: string | string[]; role?: string | string[] }>;
}) {
  const params = await searchParams;
  return (
    <AuthScreen
      kind="forgot-password"
      preview={parsePreviewState(params.preview)}
      role={parseAccountRole(params.role)}
    />
  );
}
