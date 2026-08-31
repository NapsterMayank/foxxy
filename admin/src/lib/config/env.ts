/**
 * The one place this app reads its environment.
 *
 * `NEXT_PUBLIC_*` values are inlined at BUILD time by Next, so this cannot be
 * a runtime lookup however it is written — which is exactly why it is read once
 * here and imported everywhere else. A second reader would be a second default,
 * and the failure mode is an image quietly pointing at localhost.
 */
export const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const apiVersionPrefix = '/api/v1';
