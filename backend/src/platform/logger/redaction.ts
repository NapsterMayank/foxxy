/**
 * Redaction is configured once, here, at logger construction. It is not
 * something each call site has to remember — the one it forgets is the one
 * that leaks.
 *
 * Fields listed in 01-BACKEND-IMPLEMENTATION-PLAN.md §5 (`platform/logger`):
 * password, token, email, phone, authorization, cookie, otp, apiKey.
 */
const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'password_hash',
  'newPassword',
  'token',
  'tokenHash',
  'token_hash',
  'accessToken',
  'refreshToken',
  'sessionToken',
  'email',
  'phone',
  'otp',
  'apiKey',
  'api_key',
  'secret',
  'authorization',
  'cookie',
  'linkCode',
  'link_code',
] as const;

/** The literal pino `redact.paths` list. Exported so it can be asserted on. */
export const REDACT_PATHS: readonly string[] = [
  // Fastify request/response serialiser output.
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  // Any of the sensitive keys, at the root, one level deep, or two levels deep.
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

export const REDACT_CENSOR = '[REDACTED]';

export const SENSITIVE_KEY_LIST: readonly string[] = SENSITIVE_KEYS;

/**
 * D-178 — the one place a live credential actually travels is the URL, and
 * `redact.paths` cannot see inside it.
 *
 * Every entry in `REDACT_PATHS` above names a KEY. A request URL is a single
 * string bound under the key `url`, and the credential lives *inside* that
 * string:
 *
 *     /api/v1/auth/verify?token=hu06Wi4jXIIzTob9Hy_62bR1ywlxI9E6dpRRdOjhMeg
 *
 * pino would have to parse the value to find it, and it does not parse values.
 * Adding `url` to the sensitive-key list is not the fix either: that censors
 * the whole string and destroys the only thing the binding is for.
 *
 * So the query string is removed before it is ever bound. A PATH is what
 * correlation wants — which endpoint was called; a QUERY STRING is where
 * secrets live. Dropping it is not a loss of signal, it is the removal of a
 * field that never carried any.
 *
 * Deliberately NOT a "scrub the sensitive parameter names" filter: that is the
 * same allow-list shape as `SENSITIVE_KEYS`, and it fails the first time a
 * parameter is called `t`, `code` or `k`. Nothing in a query string is
 * load-bearing for a log line, so nothing in it is kept.
 */
export function stripQueryString(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}
