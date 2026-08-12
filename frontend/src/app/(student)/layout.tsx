import type { ReactNode } from 'react';
import { ProductShell, type ProductNavigationItem } from '@/components/layout/product-shell';
import { SessionGate } from '@/components/layout/session-gate';
import { getServerT } from '@/lib/i18n/server';

export default async function StudentLayout({ children }: Readonly<{ children: ReactNode }>) {
  const t = await getServerT();
  const navigation: readonly ProductNavigationItem[] = [
    { href: '/student', isCurrent: true, label: t('shell.navLearn'), marker: '⌂' },
    { href: '/student#progress', label: t('shell.navProgress'), marker: '↗' },
    { href: '/student#next-up', label: t('shell.navPractice'), marker: '✎' },
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
