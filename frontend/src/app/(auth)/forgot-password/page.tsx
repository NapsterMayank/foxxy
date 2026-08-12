import type { Metadata } from 'next';
import { parseAccountRole } from '@/features/auth/auth-fixtures';
import { AuthScreen } from '@/features/auth/auth-screen';

export const metadata: Metadata = { title: 'Forgot password' };

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string | string[] }>;
}) {
  const params = await searchParams;
  return (
    <AuthScreen
      kind="forgot-password"
      role={parseAccountRole(params.role)}
    />
  );
}
