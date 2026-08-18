'use client';

import Link from 'next/link';
import { useT } from '@/lib/i18n/i18n-provider';
import { useMyProfile } from '../hooks/use-profile';

/**
 * ===========================================================================
 * THE HEADER IDENTITY — the student's own name, and the way into their
 * profile.
 *
 * ---------------------------------------------------------------------------
 * IT IS A CLIENT COMPONENT BECAUSE THE NAME CANNOT BE READ ON THE SERVER.
 *
 * The layout above it is a server component and could not fetch this even if
 * it wanted to: the session cookie is set by the API on `api.<domain>` with no
 * `Domain` attribute, so the Next server never receives it — the same fact
 * `session-gate.tsx` records at length about the middleware that is not there.
 * Every authenticated read in this product happens in the browser.
 *
 * ---------------------------------------------------------------------------
 * IT SHARES THE PROFILE SCREEN'S QUERY AND ADDS NO REQUEST.
 *
 * Same key, same cache entry: the header renders the new name the instant a
 * save writes it, and opening the profile screen from here shows data that is
 * already in hand. Two components, one fetch.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER RENDERS A PLACEHOLDER NAME.
 *
 * While the profile is loading — or for an account that has none yet — the
 * fallback is "Your account", not an invented first name. The screen it
 * replaced said "Aarav" to every user in the product.
 * ===========================================================================
 */
export function ProfileIdentity({ roleLabel }: { readonly roleLabel: string }) {
  const t = useT();
  const profile = useMyProfile();

  const name = profile.data?.profile.displayName ?? t('shell.identityUnknown');

  return (
    <Link
      aria-label={t('shell.identityAction')}
      className="flex min-h-control items-center gap-3 rounded-full px-2 transition-surface duration-micro hover:bg-brand-subtle focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25"
      href="/student/profile"
    >
      <span className="hidden text-right sm:block">
        <span className="block text-sm font-semibold text-ink">{name}</span>
        <span className="block text-xs text-muted">{roleLabel}</span>
      </span>
      <span
        aria-hidden="true"
        className="grid size-avatar place-items-center rounded-full bg-brand-subtle text-sm font-extrabold text-brand-strong"
      >
        {name.slice(0, 1)}
      </span>
    </Link>
  );
}
