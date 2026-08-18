import type { ReactNode } from 'react';
import { ProductShell, type ProductNavigationItem } from '@/components/layout/product-shell';
import { SessionGate } from '@/components/layout/session-gate';
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
        <ProductShell navigation={navigation} roleLabel={t('shell.studentRole')} userName="Aarav">
          {children}
        </ProductShell>
      </SessionGate>
    </div>
  );
}
