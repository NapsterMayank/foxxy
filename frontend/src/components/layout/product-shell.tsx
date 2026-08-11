import Link from 'next/link';
import type { ReactNode } from 'react';
import { cx } from '@/lib/utils/cx';

export interface ProductNavigationItem {
  href: string;
  isCurrent?: boolean;
  label: string;
  marker: string;
}

interface ProductShellProps {
  children: ReactNode;
  navigation: readonly ProductNavigationItem[];
  roleLabel: string;
  userName: string;
}

function NavigationLink({ href, isCurrent = false, label, marker }: ProductNavigationItem) {
  return (
    <Link
      aria-current={isCurrent ? 'page' : undefined}
      className={cx(
        'group flex min-h-control items-center gap-3 rounded-md px-3 py-2 text-sm font-semibold transition-surface duration-micro hover:bg-brand-subtle hover:text-brand-strong focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25 active:scale-press',
        isCurrent ? 'bg-brand-subtle text-brand-strong' : 'text-muted',
      )}
      data-motion="press"
      href={href}
    >
      <span
        aria-hidden="true"
        className="grid size-8 place-items-center rounded bg-brand-subtle text-xs font-extrabold text-brand group-hover:bg-surface"
      >
        {marker}
      </span>
      <span>{label}</span>
    </Link>
  );
}

function Brand() {
  return (
    <Link className="inline-flex items-center gap-2 font-extrabold tracking-tight text-ink" href="/">
      <span aria-hidden="true" className="grid size-9 place-items-center rounded-md bg-brand text-white">
        A
      </span>
      <span>Alfanumrik</span>
    </Link>
  );
}

export function ProductShell({ children, navigation, roleLabel, userName }: ProductShellProps) {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-shell items-center justify-between px-4 sm:px-6 lg:px-8">
          <Brand />
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-semibold text-ink">{userName}</p>
              <p className="text-xs text-muted">{roleLabel}</p>
            </div>
            <span
              aria-label={`${userName}, ${roleLabel}`}
              className="grid size-10 place-items-center rounded-full bg-brand-subtle text-sm font-extrabold text-brand-strong"
              role="img"
            >
              {userName.slice(0, 1)}
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-shell">
        <aside className="hidden w-sidebar shrink-0 border-r border-line px-4 py-8 lg:block">
          <nav aria-label={`${roleLabel} navigation`} className="space-y-2">
            {navigation.map((item) => (
              <NavigationLink key={item.href} {...item} />
            ))}
          </nav>
          <div className="mt-8 rounded-card border border-brand/15 bg-brand-subtle p-4">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">Preview</p>
            <p className="mt-2 text-sm leading-6 text-muted">
              Sample information is shown while the product services are being connected.
            </p>
          </div>
        </aside>

        <main className="min-w-0 flex-1 px-4 pb-nav pt-6 sm:px-6 sm:pt-8 lg:px-8 lg:pb-12">{children}</main>
      </div>

      <nav
        aria-label={`${roleLabel} navigation`}
        className="mobile-product-nav fixed inset-x-0 bottom-0 z-10 grid border-t border-line bg-surface/95 px-2 pt-2 shadow-overlay backdrop-blur lg:hidden"
        style={{ gridTemplateColumns: `repeat(${navigation.length}, minmax(0, 1fr))` }}
      >
        {navigation.map((item) => (
          <Link
            aria-current={item.isCurrent ? 'page' : undefined}
            className={cx(
              'flex min-h-control flex-col items-center justify-center gap-1 rounded-md px-2 py-1 text-center text-xs font-semibold transition-surface duration-micro hover:bg-brand-subtle hover:text-brand-strong focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25 active:scale-press',
              item.isCurrent ? 'bg-brand-subtle text-brand-strong' : 'text-muted',
            )}
            data-motion="press"
            href={item.href}
            key={item.href}
          >
            <span aria-hidden="true" className="font-extrabold text-brand">
              {item.marker}
            </span>
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
