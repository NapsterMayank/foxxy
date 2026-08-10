import type { Metadata } from 'next';
import { parseAccountRole, parsePreviewState } from '@/features/auth/auth-fixtures';
import { AuthScreen } from '@/features/auth/auth-screen';

export const metadata: Metadata = { title: 'Reset password' };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ preview?: string | string[]; role?: string | string[] }>;
}) {
  const params = await searchParams;
  return (
    <AuthScreen
      kind="reset-password"
      preview={parsePreviewState(params.preview)}
      role={parseAccountRole(params.role)}
    />
  );
}
