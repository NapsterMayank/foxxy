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
