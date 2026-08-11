/**
 * The one-way channel from "a request came back 401" to "the session ended".
 *
 * ===========================================================================
 * WHY A PUB/SUB AND NOT A CALL.
 *
 * §5.5: "a 401 from ANY request sets the context to unauthenticated, clears the
 * query cache, and redirects to login". Any request — a background refetch, a
 * mutation, a stream — most of which are nowhere near a React component that
 * could call the session context directly.
 *
 * The alternative is the API client importing the session provider, which is a
 * cycle (the provider fetches through the client) and drags React into a module
 * that must stay callable from a plain test. This publishes a fact; whoever is
 * mounted decides what to do about it.
 *
 * There is exactly one subscriber in practice — `SessionProvider`. The set
 * still exists rather than a single slot because React 18 double-mounts effects
 * in development, and a single slot makes the second mount silently evict the
 * first subscriber, in the mode that is meant to catch bugs rather than create
 * them.
 * ===========================================================================
 */

type UnauthenticatedListener = () => void;

const listeners = new Set<UnauthenticatedListener>();

/** Returns the unsubscribe function, for an effect cleanup. */
export function onUnauthenticated(listener: UnauthenticatedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Called by the query caches when any request fails with a 401.
 *
 * Idempotent by construction: the provider's handler is safe to run twice, and
 * a burst of parallel requests all failing at once is the ordinary case, not an
 * edge one.
 */
export function notifyUnauthenticated(): void {
  for (const listener of listeners) listener();
}

/** Test-only. A leaked listener across tests is a cross-test dependency. */
export function resetUnauthenticatedListeners(): void {
  listeners.clear();
}
