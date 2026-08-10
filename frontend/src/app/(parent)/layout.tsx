import type { ReactNode } from 'react';
import { ProductShell, type ProductNavigationItem } from '@/components/layout/product-shell';

const navigation: readonly ProductNavigationItem[] = [
  { href: '/parent', isCurrent: true, label: 'Overview', marker: '⌂' },
  { href: '/parent#child-summary', label: 'Child', marker: '◎' },
  { href: '/parent#updates', label: 'Updates', marker: '•' },
];

export default function ParentLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div data-theme="parent">
      <ProductShell navigation={navigation} roleLabel="Parent preview" userName="Ananya">
        {children}
      </ProductShell>
    </div>
  );
}
