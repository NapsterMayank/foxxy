import Link from 'next/link';
import type { ReactNode } from 'react';
import { LanguageSwitch } from '@/components/patterns/language-switch';
import { OfflineBanner } from '@/components/patterns/offline-banner';
import { getServerT } from '@/lib/i18n/server';
import type { Translator } from '@/lib/i18n/translate';
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
  /**
   * The header identity, when the caller has a real one to render.
   *
   * A SLOT RATHER THAN A NAME, because the name is not knowable here. This is
   * a server component; the session cookie belongs to `api.<domain>` and never
   * reaches the Next server (see `session-gate.tsx`), so anything derived from
   * the signed-in user has to be fetched in the browser by a client component
   * the caller supplies. `src/components/**` may not import a feature — the
   * `no-cross-feature-imports` rule — and this is how the shell gets feature
   * data without depending on a feature.
   *
   * `userName` remains for the callers that have not been given one yet, and
   * is what the avatar and the label fall back to.
   */
  identity?: ReactNode;
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

/*
 * PURE, and takes the translator as a prop. It used to `await getServerT()`
 * itself — which works in Next and CANNOT BE RENDERED IN A TEST: an async
 * component nested inside an already-awaited tree is treated as an async CLIENT
 * component and never resolves. One `await` at the top of the shell, passed
 * down, keeps every child renderable and reads the cookie once per tree.
 */
function Brand({ t }: { t: Translator }) {
  return (
    /*
      `min-h-control` — 44px, §12, and this link had 36. It is a NAVIGATION
      CONTROL in the product header, not decoration, and the browser suite
      found it the first time it ever looked at an authenticated screen.
    */
    <Link
      className="inline-flex min-h-control items-center gap-2 font-extrabold tracking-tight text-ink"
      href="/"
    >
      <span aria-hidden="true" className="grid size-logo place-items-center rounded-md bg-brand text-brand-fg">
        {t('common.brandPrefix').slice(0, 1)}
      </span>
      <span>{t('common.brand')}</span>
    </Link>
  );
}

export async function ProductShell({
  children,
  identity,
  navigation,
  roleLabel,
  userName,
}: ProductShellProps) {
  const t = await getServerT();

  return (
    <div className="min-h-screen bg-canvas text-ink">
      {/*
        Plan §4: the offline banner belongs to the app shell. ABOVE the sticky
        header rather than inside it — a notice that scrolls away is a notice
        the person who needs it has already missed, and the audience here is
        students on mobile data where losing the connection is ordinary.
      */}
      <OfflineBanner message={t('offline')} />

      <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-shell items-center justify-between px-4 sm:px-6 lg:px-8">
          <Brand t={t} />
          <div className="flex items-center gap-3">
            {/* Reachable from every screen, not buried in a settings page. */}
            <LanguageSwitch className="hidden sm:inline-flex" />
            {identity ?? (
              <>
                <div className="hidden text-right sm:block">
                  <p className="text-sm font-semibold text-ink">{userName}</p>
                  <p className="text-xs text-muted">{roleLabel}</p>
                </div>
                <span
                  aria-label={`${userName}, ${roleLabel}`}
                  className="grid size-avatar place-items-center rounded-full bg-brand-subtle text-sm font-extrabold text-brand-strong"
                  role="img"
                >
                  {userName.slice(0, 1)}
                </span>
              </>
            )}
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
          {/*
            NO PREVIEW CARD. It said "Sample information is shown while the
            product services are being connected", which was true when this
            shell was built and false from 12 August, when the screens went
            live one after another. It sat in the sidebar of every
            authenticated page, contradicting the real data beside it, and on
            a demo it was the first thing a viewer read (open item 52).
          */}
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
