import Link from 'next/link';
import type { ReactNode } from 'react';
import { LanguageSwitch } from '@/components/patterns/language-switch';
import type { AccountRole } from '@/features/auth/auth-fixtures';
import type { Translator } from '@/lib/i18n/translate';

/**
 * The frame every auth screen sits in.
 *
 * A SERVER COMPONENT that reads the dictionary itself rather than taking every
 * string as a prop. The alternative — threading `changeRoleLabel`, the two
 * wordmark halves and the rest down from `AuthScreen` — makes the caller
 * responsible for strings it does not render, and each new element in the frame
 * adds a prop to a component that should not have to change at all.
 */

interface AuthShellProps {
  children: ReactNode;
  /**
   * The translator, from the ONE `await` at the top of the screen.
   *
   * This component used to fetch it itself, which works in Next and cannot be
   * rendered in a test: an async component nested inside an already-awaited
   * tree is treated as an async client component and never resolves.
   */
  t: Translator;
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
  t,
  title,
}: AuthShellProps) {
  return (
    <main
      className="mx-auto flex min-h-screen max-w-shell flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-8"
      data-theme={role}
    >
      {/*
        THE SWITCH IS AVAILABLE BEFORE SIGN-IN. A person who cannot read the
        sign-in form cannot reach a preference stored on their profile — so the
        cookie-backed switch has to be on the unauthenticated screens too.
      */}
      {/*
        `flex-wrap`, AND IT IS LOAD-BEARING AT 360px.

        The wordmark, the language switch and "Change role" total 378px on a
        360px viewport — the first browser run against a production build
        measured the document scrolling 18px sideways on every auth screen.
        Horizontal overflow on a phone is the defect a desktop review never
        sees, and this is the narrowest viewport the product supports.

        Wrapping rather than shrinking: the two controls are a language switch
        and a navigation link, and neither survives being truncated.
      */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link
          className="rounded-full px-3 py-2 text-lg font-extrabold tracking-tight text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25"
          href="/"
        >
          <span className="text-brand">{t('common.brandPrefix')}</span>
          {t('common.brandSuffix')}
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSwitch />
          <Link
            className="rounded-full px-3 py-2 text-sm font-semibold text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25"
            href="/"
          >
            {t('auth.changeRole')}
          </Link>
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center py-8 sm:py-12">
        <div className="rounded-card border border-line bg-surface p-6 shadow-raised sm:p-8">
          <p className="text-sm font-semibold uppercase tracking-widest text-brand">{eyebrow}</p>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">{title}</h1>
          <p className="mt-3 text-base leading-7 text-muted">{description}</p>
          <div className="mt-8">{children}</div>
          {footer ? (
            <div className="mt-8 border-t border-line pt-6 text-center text-sm text-muted">
              {footer}
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
