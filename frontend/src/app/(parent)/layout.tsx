import type { ReactNode } from 'react';
import { ProductShell, type ProductNavigationItem } from '@/components/layout/product-shell';
import { SessionGate } from '@/components/layout/session-gate';
import { getServerT } from '@/lib/i18n/server';

export default async function ParentLayout({ children }: Readonly<{ children: ReactNode }>) {
  const t = await getServerT();
  const navigation: readonly ProductNavigationItem[] = [
    { href: '/parent', isCurrent: true, label: t('shell.navOverview'), marker: '⌂' },
    { href: '/parent#parent-snapshot-title', label: t('shell.navChild'), marker: '◎' },
    { href: '/parent#parent-digest-title', label: t('shell.navUpdates'), marker: '•' },
    { href: '/parent/billing', label: t('shell.navBilling'), marker: '₹' },
  ];

  return (
    <div data-theme="parent">
      <SessionGate role="parent">
        <ProductShell navigation={navigation} roleLabel={t('shell.parentRole')} userName={t('shell.identityUnknown')}>
          {children}
        </ProductShell>
      </SessionGate>
    </div>
  );
}
