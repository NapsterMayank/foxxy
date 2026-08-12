import type { Metadata } from 'next';
import { parseAccountRole } from '@/features/auth/auth-fixtures';
import { AuthScreen } from '@/features/auth/auth-screen';

export const metadata: Metadata = { title: 'Create account' };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string | string[] }>;
}) {
  const params = await searchParams;
  return <AuthScreen kind="signup" role={parseAccountRole(params.role)} />;
}
