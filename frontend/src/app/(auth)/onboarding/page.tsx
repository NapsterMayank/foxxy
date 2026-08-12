import type { Metadata } from 'next';
import { parseAccountRole } from '@/features/auth/auth-fixtures';
import { AuthShell } from '@/features/auth/auth-shell';
import { OnboardingForm } from '@/features/onboarding/onboarding-form';
import { getServerT } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Set up your profile' };

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string | string[] }>;
}) {
  const role = parseAccountRole((await searchParams).role);
  const isParent = role === 'parent';
  const t = await getServerT();

  return (
    <AuthShell
      description={isParent ? t('onboarding.parentDescription') : t('onboarding.studentDescription')}
      eyebrow={isParent ? t('onboarding.parentEyebrow') : t('onboarding.studentEyebrow')}
      role={role}
      t={t}
      title={isParent ? t('onboarding.parentTitle') : t('onboarding.studentTitle')}
    >
      <OnboardingForm role={role} />
    </AuthShell>
  );
}
