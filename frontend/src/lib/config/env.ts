/**
 * The typed public environment — plan §2, `lib/config`.
 *
 * `process.env.NEXT_PUBLIC_API_URL` is written out LITERALLY, once, because
 * Next inlines `NEXT_PUBLIC_*` at build time by textual substitution. A
 * computed lookup (`process.env[name]`) is not substituted and reads
 * `undefined` in the browser — the kind of failure that works in `next dev`
 * and breaks in the image.
 *
 * It throws when absent rather than defaulting to a localhost URL. A default
 * would make a misconfigured production build point at a machine that is not
 * there, and the symptom — every request failing at the network layer — looks
 * like an outage rather than a missing variable.
 */

const rawApiUrl = process.env.NEXT_PUBLIC_API_URL;

if (typeof rawApiUrl !== 'string' || rawApiUrl.length === 0) {
  throw new Error(
    'NEXT_PUBLIC_API_URL is not set. Copy frontend/.env.example to .env.local, ' +
      'or set it in the build environment. See docs/02-FRONTEND-IMPLEMENTATION-PLAN.md §5.2.',
  );
}

/** No trailing slash, so path joining is `${apiBaseUrl}${path}` everywhere. */
export const apiBaseUrl: string = rawApiUrl.replace(/\/+$/, '');

/**
 * The version prefix every product route carries. It is NOT part of
 * `apiBaseUrl`: the billing webhook and the health probes live outside it, and
 * folding it into the base URL would make those unreachable through the same
 * client.
 */
export const apiVersionPrefix = '/api/v1' as const;
