/**
 * ===========================================================================
 * ONE ID PER OPEN OF THE APP — D-401.
 *
 * The backend records a learner starting something in two places,
 * `chat_sessions` and `practice_sessions`, and until now they shared no key
 * but the student and the clock. A clock cannot separate two visits in one
 * afternoon, so "what did this student do today, and how many sittings was
 * it" had no answer. This id is that key.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLIENT MINTS IT AND NOT THE SERVER.
 *
 * The server already has an auth session id, and it is the wrong value:
 * `sessions` is one row per LOGIN and the cookie lives for weeks, so it is
 * CONSTANT across exactly the opens this is meant to tell apart. Only the tab
 * knows when the app was opened.
 *
 * ---------------------------------------------------------------------------
 * `sessionStorage`, DELIBERATELY, AND NOT THE OTHER THREE OPTIONS.
 *
 *   `localStorage`   survives tab close, so every visit for the rest of the
 *                    device's life would share one id — which is the bug.
 *   module variable  dies on a full page load, so a reload would look like a
 *                    new visit. It is not; the student never left.
 *   a cookie         travels on every request whether wanted or not, and adds
 *                    a third thing to reason about at logout.
 *
 * `sessionStorage` is scoped to the tab and cleared when it closes, which is
 * the closest thing a browser has to "this open of the app". A reload keeps
 * it; a new tab gets its own; closing ends it.
 *
 * ---------------------------------------------------------------------------
 * IT IS NOT AN IDENTIFIER OF A PERSON, and must never become one. It is not
 * tied to the account, it is not read back, and it is thrown away with the
 * tab. The backend treats it as an unauthenticated label and scopes no query
 * by it — see `shared/http/visit-id.ts` there.
 * ===========================================================================
 */

const KEY = 'foxxy.visitId';

/**
 * `crypto.randomUUID` needs a secure context, which is https and localhost —
 * every context this app runs in. The fallback is not a uuid generator; it is
 * an admission that we could not make one, and returning null means the header
 * is simply not sent. A weak non-uuid would be REJECTED by the server's parse
 * anyway, so inventing one would only make the failure harder to see.
 */
function mint(): string | null {
  return typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : null;
}

/**
 * The visit id for this tab, minting one on first call.
 *
 * @returns null during server rendering, when `sessionStorage` is unavailable
 * (Safari private mode throws on write, and some embedded webviews block it
 * outright), or when no uuid could be generated. A null visit is a normal
 * outcome, not an error: the request goes out without the header and the column
 * stays NULL, which is exactly what it is nullable for.
 */
export function currentVisitId(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const existing = window.sessionStorage.getItem(KEY);
    if (existing !== null && existing.length > 0) return existing;

    const minted = mint();
    if (minted === null) return null;

    window.sessionStorage.setItem(KEY, minted);
    return minted;
  } catch {
    /*
     * Storage is unavailable or full. Swallowed on purpose and NOT retried:
     * this runs on the path of every request that carries a body, and a
     * correlation label must never be the reason a student cannot start
     * practising.
     */
    return null;
  }
}
