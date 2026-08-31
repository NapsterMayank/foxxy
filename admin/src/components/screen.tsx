'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ZodType } from 'zod';
import { ApiError, adminRequest } from '@/lib/api/client';

/**
 * =============================================================================
 * ONE LOADING SHAPE FOR EVERY SCREEN.
 *
 * Eleven screens each writing their own fetch-and-render would be eleven
 * chances to render a failure as an empty table — which on an operations panel
 * is the worst possible bug, because "no dead letters" and "the request failed"
 * look identical and only one of them is good news.
 *
 * So: loading says loading, an error says what broke, and only real data
 * reaches the render function.
 * =============================================================================
 */
interface Settled<T> {
  /** Which request this result belongs to. See `loading` below. */
  readonly key: string;
  readonly data: T | null;
  readonly error: ApiError | null;
}

export function useAdminData<T>(path: string, schema: ZodType<T>): {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
} {
  const [nonce, setNonce] = useState(0);
  const key = `${path}|${String(nonce)}`;
  const [settled, setSettled] = useState<Settled<T>>({ key: '', data: null, error: null });

  /**
   * ===========================================================================
   * `loading` IS DERIVED, NOT STORED — and that is a correctness fix, not a
   * tidy-up.
   *
   * The first version began the effect with `setLoading(true); setError(null);`,
   * which React's `set-state-in-effect` rule rejects: a synchronous setState in
   * an effect body schedules a second render pass before the browser paints,
   * and under Strict Mode's double-invoke it is a state write nobody asked for.
   *
   * Comparing the settled result's key against the CURRENT request's key says
   * the same thing without storing it, and says it more truthfully. When `path`
   * changes, the previous screen's data no longer matches the new key, so this
   * reads as loading IMMEDIATELY — where a stored flag would render the old
   * screen's rows under the new screen's heading until the fetch resolved.
   *
   * On this panel that flash is not cosmetic: a stale jobs table under a
   * workers heading, for one frame, during an incident, is a wrong answer.
   * ===========================================================================
   */
  const loading = settled.key !== key;

  useEffect(() => {
    const controller = new AbortController();

    adminRequest({ path, schema, signal: controller.signal })
      .then((value) => { setSettled({ key, data: value, error: null }); })
      .catch((cause: unknown) => {
        // An abort is the effect being cleaned up, not a failure. Settling here
        // would publish a result for a request that was deliberately dropped.
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setSettled({
          key,
          data: null,
          error: cause instanceof ApiError ? cause : new ApiError(0, 'UNKNOWN', String(cause)),
        });
      });

    return () => { controller.abort(); };
  }, [key, path, schema]);

  const reload = useCallback(() => { setNonce((value) => value + 1); }, []);

  // Only a settled result for THIS key is shown. A previous screen's data is
  // never rendered beside a new screen's heading.
  return {
    data: loading ? null : settled.data,
    error: loading ? null : settled.error,
    loading,
    reload,
  };
}

export function Failure({ error }: { error: ApiError }) {
  return (
    <div className="error">
      <strong>{error.code}</strong> — {error.message}
      {error.status === 401 ? (
        <div className="muted" style={{ margin: '8px 0 0' }}>
          {/*
            AN UNAUTHENTICATED OPERATOR USED TO SEE ONLY "Authentication
            required" AND NO WAY TO ACT ON IT.

            There is no login form in this app on purpose — a second credential
            path is a second place to get session handling wrong, and this app
            deliberately holds none of it. But "no form here" is not the same as
            "no instructions here", and the first browser pass found a panel
            that told an operator they were signed out and stopped talking.

            The session cookie is set by the API and shared across both apps, so
            signing in on the product is what makes this one work.
          */}
          <p style={{ margin: 0 }}>
            Sign in on the product app, then reload this page — the API sets one
            session cookie and both apps read it.
          </p>
          <p style={{ margin: '4px 0 0' }}>
            No operator account yet? It cannot be created by signing up.{' '}
            Run <code>npm run ops:admin-create -- --email=&lt;addr&gt; --name=&lt;name&gt;</code>{' '}
            in <code>backend/</code>. See <code>admin/README.md</code>.
          </p>
        </div>
      ) : null}
      {error.isAbsentOrForbidden ? (
        <p className="muted" style={{ margin: '6px 0 0' }}>
          {/*
            The gate answers 404 rather than 403 so a prober cannot map the
            surface. That means this status is genuinely ambiguous, and saying
            so is more honest than picking one.
          */}
          A 404 here means either the resource does not exist or you are not
          signed in as an operator. The server does not distinguish the two.
        </p>
      ) : null}
    </div>
  );
}

/** A value the server withheld. Styled so it does not read as missing data. */
export function Masked({ children }: { children: React.ReactNode }) {
  return <span className="masked" title="Masked by the server. Use Reveal to unmask, on the record.">{children}</span>;
}
