import Link from 'next/link';
import type { ReactNode } from 'react';
import { cx } from '@/lib/utils/cx';

interface ButtonLinkProps {
  children: ReactNode;
  className?: string;
  href: string;
  label: string;
}

export function ButtonLink({ children, className, href, label }: ButtonLinkProps) {
  return (
    <Link
      aria-label={label}
      className={cx(
        'inline-flex min-h-control items-center justify-center rounded-full bg-brand px-6 py-3 text-sm font-semibold text-white shadow-raised transition-surface duration-150 hover:bg-brand-strong hover:shadow-overlay focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25 active:scale-press',
        className,
      )}
      data-motion="press"
      href={href}
    >
      {children}
    </Link>
  );
}
