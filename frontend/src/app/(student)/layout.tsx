import type { ReactNode } from 'react';
import { ProductShell, type ProductNavigationItem } from '@/components/layout/product-shell';
import { SessionGate } from '@/components/layout/session-gate';
import { ProfileIdentity } from '@/features/profile/components/profile-identity';
import { getServerT } from '@/lib/i18n/server';

export default async function StudentLayout({ children }: Readonly<{ children: ReactNode }>) {
  const t = await getServerT();
  const navigation: readonly ProductNavigationItem[] = [
    { href: '/student', isCurrent: true, label: t('shell.navLearn'), marker: '⌂' },
    { href: '/student/learn', label: t('shell.navLearn2'), marker: '📖' },
    { href: '/student/foxy', label: t('shell.navFoxy'), marker: '✦' },
    { href: '/student/practice', label: t('shell.navPractice'), marker: '✎' },
    { href: '/student/progress', label: t('shell.navProgress'), marker: '↗' },
  ];

  return (
    <div data-theme="student">
      <SessionGate role="student">
        {/*
          `identity` rather than `userName`: the student's real display name,
          read in the browser from `/me/profile`, and a link to the screen that
          edits it. `userName` stays as the fallback the shell renders when a
          caller has no identity component to give it — the parent layout still
          does not.
        */}
        <ProductShell
          identity={<ProfileIdentity roleLabel={t('shell.studentRole')} />}
          navigation={navigation}
          roleLabel={t('shell.studentRole')}
          userName={t('shell.identityUnknown')}
        >
          {children}
        </ProductShell>
      </SessionGate>
    </div>
  );
}
