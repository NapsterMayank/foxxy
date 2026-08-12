'use client';

import { useEffect, useState } from 'react';
import { cx } from '@/lib/utils/cx';

/**
 * ===========================================================================
 * OFFLINE NOTICE — plan §4, "used by: app shell".
 *
 * The audience is students on mobile data in India. Losing the connection
 * mid-session is ordinary, not exceptional, and without this the symptom is a
 * screen where every action silently fails — which reads as "the app is
 * broken", not "you are offline".
 *
 * ---------------------------------------------------------------------------
 * `navigator.onLine` IS NOT READ DURING RENDER, AND IT MUST NOT BE.
 *
 * It does not exist on the server, so reading it in a render body produces
 * markup that disagrees with the client's first render — a hydration mismatch,
 * which React resolves by throwing away the tree. The initial state is
 * therefore ALWAYS "online" and the effect corrects it after mount: one frame
 * of optimism, versus a hydration error on every page load.
 *
 * `navigator.onLine === true` also means only "an interface is up" — a captive
 * portal or a dead uplink still reports online. So this is a hint, never the
 * basis for a decision: requests are still attempted, and their failures are
 * still handled by §5.6's table.
 * ===========================================================================
 */

export interface OfflineBannerProps {
  /** The message. No user-facing string is hard-coded in a shared component. */
  readonly message: string;
  readonly className?: string;
}

export function OfflineBanner({ className, message }: OfflineBannerProps) {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = (): void => {
      setOffline(!navigator.onLine);
    };
    update();

    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      className={cx(
        'w-full bg-warning/10 px-4 py-2 text-center text-sm font-semibold text-warning',
        className,
      )}
      data-state="offline"
      /*
       * `status`, not `alert`. Going offline is worth announcing at the next
       * pause; interrupting a child mid-sentence to say it is not.
       */
      role="status"
    >
      {message}
    </div>
  );
}
