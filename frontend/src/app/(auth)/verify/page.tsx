import type { Metadata } from 'next';
import { parseAccountRole } from '@/features/auth/auth-fixtures';
import { AuthScreen } from '@/features/auth/auth-screen';

export const metadata: Metadata = { title: 'Verify email' };

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string | string[] }>;
}) {
  const params = await searchParams;
  return <AuthScreen kind="verify" role={parseAccountRole(params.role)} />;
}
