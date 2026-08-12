'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useT } from '@/lib/i18n/i18n-provider';
import { LOGIN_PATH, useSession } from '@/lib/session/session-provider';

/**
 * ===========================================================================
 * THE LAYOUT GUARD — 02-FRONTEND-IMPLEMENTATION-PLAN.md §5.5.
 *
 * Wrapped around the `(student)` and `(parent)` route groups, so a page inside
 * either one may assume an authenticated actor of the right role and never
 * re-check. One guard per group, not one per page: a page that has to remember
 * to check is a page somebody will add without checking.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A SECURITY BOUNDARY, AND THE PLAN SAYS SO IN AS MANY WORDS.
 *
 * The authoritative check is server-side on the API, on every request, where it
 * already is. This decides what to RENDER. A user who defeats it sees a shell
 * with no data in it, because every request behind that shell is refused by the
 * backend. Never move an authorisation decision here.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO `proxy.ts` COOKIE CHECK — A DEVIATION FROM §5.5, RECORDED.
 *
 * §5.5 specifies a Next proxy (the Next 16 rename of middleware) doing a cookie
 * PRESENCE check, as a user-experience optimisation ahead of this guard. It
 * cannot work in the deployed topology: the session cookie is set by the API on
 * `api.<domain>` with NO `Domain` attribute — deliberately, see
 * `backend/src/modules/identity/identity.plugin.ts` — so it is host-only and the
 * Next server on `app.<domain>` never receives it. A presence check there reads
 * "absent" for every signed-in user and bounces them all to login.
 *
 * It would appear to work in local development, where both apps are `localhost`
 * and cookies ignore the port. That is the worst possible outcome: correct on
 * every developer machine, broken for every real user.
 *
 * Making it work would mean widening the cookie to `Domain=.<domain>`, which
 * hands it to the marketing site and every future subdomain — a real security
 * downgrade bought with a skeleton flash. Declined. The cost of the deviation is
 * one render of the skeleton below on a cold load.
 * ===========================================================================
 */

export type GuardedRole = 'student' | 'parent';

/**
 * A neutral skeleton, shown while the bootstrap is in flight.
 *
 * NEVER a redirect. §5.5: redirecting during bootstrap logs out every user on
 * every refresh, and it is the single most common bug in cookie-session
 * applications. `loading` is the absence of an answer; only `unauthenticated`
 * is an answer.
 */
function SessionSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className="mx-auto w-full max-w-shell px-4 py-12">
      <span className="sr-only">{label}</span>
      <div className="h-bar w-full max-w-prose rounded-md bg-line" />
      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div className="h-panel rounded-card bg-line" />
        <div className="h-panel rounded-card bg-line" />
      </div>
    </div>
  );
}

function NoAccess({ t }: { t: ReturnType<typeof useT> }) {
  return (
    <div className="mx-auto w-full max-w-prose px-4 py-12 text-center">
      <h1 className="text-2xl font-bold text-ink">{t('session.noAccessTitle')}</h1>
      <p className="mt-4 text-base text-muted">{t('session.noAccessDescription')}</p>
      <Link
        className="mt-8 inline-flex min-h-control min-w-control items-center justify-center rounded-full bg-brand px-6 py-3 text-base font-semibold text-brand-fg transition-surface duration-micro hover:bg-brand-strong focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/40"
        href={LOGIN_PATH}
      >
        {t('session.noAccessAction')}
      </Link>
    </div>
  );
}

export function SessionGate({
  role,
  children,
}: Readonly<{ role: GuardedRole; children: ReactNode }>) {
  const { status, user } = useSession();
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();

  const isSignedOut = status === 'unauthenticated';
  /*
   * A signed-in STUDENT who opens a parent URL is sent to their own home, not
   * to login — bouncing them to a sign-in form they are already past reads as a
   * broken product. Any other role (teacher, admin — the column accepts ten)
   * gets the no-access state instead of a redirect to a home that does not
   * exist for them.
   */
  const wrongRoleWithHome =
    status === 'authenticated' &&
    user !== null &&
    user.role !== role &&
    (user.role === 'student' || user.role === 'parent');

  useEffect(() => {
    /*
     * The redirect happens in an EFFECT, never during render. `router.replace`
     * inside a render body updates the router while React is rendering, which
     * React warns about and which can loop.
     */
    if (isSignedOut) {
      // `?next=` so signing in returns them to the page they asked for, which
      // is the whole difference between a session timeout and losing your place.
      const next = pathname === null || pathname === LOGIN_PATH ? null : pathname;
      router.replace(next === null ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(next)}`);
      return;
    }
    if (wrongRoleWithHome && user !== null) {
      router.replace(`/${user.role}`);
    }
  }, [isSignedOut, pathname, router, user, wrongRoleWithHome]);

  if (status === 'loading' || isSignedOut || wrongRoleWithHome) {
    return <SessionSkeleton label={t('session.checking')} />;
  }
  if (user === null || user.role !== role) return <NoAccess t={t} />;

  return <>{children}</>;
}
