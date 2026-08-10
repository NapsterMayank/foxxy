import type { Metadata } from 'next';
import { parseAccountRole } from '@/features/auth/auth-fixtures';
import { AuthShell } from '@/features/auth/auth-shell';
import { OnboardingForm } from '@/features/onboarding/onboarding-form';

export const metadata: Metadata = { title: 'Set up your profile' };

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string | string[] }>;
}) {
  const role = parseAccountRole((await searchParams).role);
  const isParent = role === 'parent';

  return (
    <AuthShell
      description={
        isParent
          ? "Use the invitation code created in the product. Do not enter your child's personal details."
          : 'Choose a few preferences so your learning space starts in the right place.'
      }
      eyebrow="Profile setup"
      role={role}
      title={isParent ? 'Connect with your child' : 'Make learning yours'}
    >
      <OnboardingForm role={role} />
    </AuthShell>
  );
}
