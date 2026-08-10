import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AccountRole } from '@/features/auth/auth-fixtures';

interface AuthShellProps {
  children: ReactNode;
  description: string;
  eyebrow: string;
  footer?: ReactNode;
  role?: AccountRole;
  title: string;
}

export function AuthShell({
  children,
  description,
  eyebrow,
  footer,
  role = 'student',
  title,
}: AuthShellProps) {
  return (
    <main
      className="mx-auto flex min-h-screen max-w-shell flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-8"
      data-theme={role}
    >
      <header className="flex items-center justify-between">
        <Link
          className="rounded-full px-3 py-2 text-lg font-extrabold tracking-tight text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25"
          href="/"
        >
          <span className="text-brand">Alfa</span>numrik
        </Link>
        <Link
          className="rounded-full px-3 py-2 text-sm font-semibold text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25"
          href="/"
        >
          Change role
        </Link>
      </header>

      <section className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center py-8 sm:py-12">
        <div className="rounded-card border border-line bg-surface p-6 shadow-raised sm:p-8">
          <p className="text-sm font-semibold uppercase tracking-widest text-brand">{eyebrow}</p>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">{title}</h1>
          <p className="mt-3 text-base leading-7 text-muted">{description}</p>
          <div className="mt-8">{children}</div>
          {footer ? <div className="mt-8 border-t border-line pt-6 text-center text-sm text-muted">{footer}</div> : null}
        </div>
      </section>
    </main>
  );
}
