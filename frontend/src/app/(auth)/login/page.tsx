import type { Metadata } from 'next';
import { parseAccountRole } from '@/features/auth/auth-fixtures';
import { AuthScreen } from '@/features/auth/auth-screen';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string | string[] }>;
}) {
  const params = await searchParams;
  return <AuthScreen kind="login" role={parseAccountRole(params.role)} />;
}
