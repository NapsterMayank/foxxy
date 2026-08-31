import type { FastifyRequest } from 'fastify';

/**
 * =============================================================================
 * `X-Visit-Id` — WHICH OPEN OF THE APP A REQUEST BELONGS TO. D-401.
 *
 * The client mints one uuid per app launch and sends it on every request. The
 * two tables that record a learner starting something — `chat_sessions` and
 * `practice_sessions` — stamp it, so a day of activity can be split into the
 * visits it actually was.
 *
 * -----------------------------------------------------------------------------
 * WHY NOT THE AUTH SESSION ID, WHICH THE SERVER ALREADY HAS.
 *
 * Because `sessions` is one row per LOGIN and the cookie lives for weeks. A
 * student who opens the app five times on Tuesday has one auth session for all
 * five, so it is constant across exactly the thing being separated. Only the
 * client knows when the app was opened, so only the client can say.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS NOT ON `request.actor`.
 *
 * `identity.plugin.ts` says it plainly: the actor is `{ userId, role }` and
 * NOTHING ELSE, because "routes start reading fields off it, and control over
 * what gets loaded is lost one convenient property at a time." A visit id is
 * exactly the convenient property that note is about — and worse than most,
 * because the actor is the AUTHENTICATED caller and this value is not
 * authenticated at all. Putting an untrusted string on the trusted object is
 * how it eventually gets treated as trusted.
 *
 * -----------------------------------------------------------------------------
 * IT AUTHORISES NOTHING, AND THE PARSE IS WHY.
 *
 * Anything that is not a uuid becomes NULL rather than being stored — so the
 * column holds a uuid or nothing, never a caller's free text, and it cannot
 * become an injection surface or a place identifiers are smuggled. Even a valid
 * uuid proves nothing: a caller may send any visit id they like, including
 * another student's. That is harmless BECAUSE nothing is ever scoped by this
 * column. If a future query filters on it, it must still carry the
 * `student_user_id` predicate that does the actual authorising.
 *
 * A MISSING HEADER IS NOT AN ERROR. Non-browser callers, tests, curl and a
 * proxy with a header allow-list all arrive without one. Rejecting them would
 * mean a student cannot practise because a correlation label went missing.
 * =============================================================================
 */

/**
 * Canonical 8-4-4-4-12 hex, any version, case-insensitive.
 *
 * Deliberately NOT a version-pinned pattern: the client mints v4 today and the
 * database would take a v7 tomorrow without noticing, so a check that pinned
 * the version would reject valid ids for a reason that has nothing to do with
 * what this column is for.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const VISIT_ID_HEADER = 'x-visit-id';

/**
 * The visit id on this request, or null.
 *
 * @returns null when the header is absent, repeated (Fastify hands back an
 * array, and a request that names two visits names none), or not a uuid.
 */
export function readVisitId(request: FastifyRequest): string | null {
  const raw = request.headers[VISIT_ID_HEADER];
  if (typeof raw !== 'string') return null;
  return UUID.test(raw) ? raw.toLowerCase() : null;
}
