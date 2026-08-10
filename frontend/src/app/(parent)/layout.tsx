import type { ReactNode } from 'react';
import { ProductShell, type ProductNavigationItem } from '@/components/layout/product-shell';

const navigation: readonly ProductNavigationItem[] = [
  { href: '/parent', label: 'Home', marker: 'H' },
  { href: '/parent#child-summary', label: 'Child', marker: 'C' },
  { href: '/parent#updates', label: 'Updates', marker: 'U' },
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
