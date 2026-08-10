import type { ReactNode } from 'react';
import { ProductShell, type ProductNavigationItem } from '@/components/layout/product-shell';

const navigation: readonly ProductNavigationItem[] = [
  { href: '/student', label: 'Home', marker: 'H' },
  { href: '/student#progress', label: 'Progress', marker: 'P' },
  { href: '/student#next-up', label: 'Practice', marker: 'Q' },
];

export default function StudentLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div data-theme="student">
      <ProductShell navigation={navigation} roleLabel="Student preview" userName="Aarav">
        {children}
      </ProductShell>
    </div>
  );
}
