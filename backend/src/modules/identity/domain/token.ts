import { createHash } from 'node:crypto';

/**
 * Opaque token generation, hashing and expiry — §6.1, §6.3, §6.7.
 *
 * PURE, in the sense the plan requires: no I/O, no clock, no randomness of its
 * own. Randomness is INJECTED as a `RandomBytes` function and the current time
 * is INJECTED as a `Date` argument. That is what makes "expires at exactly the
 * boundary" a test you can write rather than a race you hope about.
 *
 * (`node:crypto` hashing is a deterministic pure computation — the same input
 * always yields the same output. It reads no clock and no entropy source.)
 */

/** §6.1: 32 random bytes, base64url. 256 bits from a CSPRNG. */
export const TOKEN_BYTE_LENGTH = 32;

/** 32 bytes of base64url, unpadded. */
export const TOKEN_STRING_LENGTH = 43;

/** Verification tokens live 24 hours (§6.2, step 6). */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Reset tokens live 1 hour (§6.7). */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/** A session is extended when used and older than this (§6.1, renewal). */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * The source of randomness, injected.
 *
 * In production this is `crypto.randomBytes`. In a test it is a fixed byte
 * sequence, which makes the generated token assertable.
 */
export type RandomBytes = (size: number) => Uint8Array;

/**
 * base64url with no padding, per RFC 4648 §5. Node's own 'base64url' encoding
 * already omits padding; the replace is belt-and-braces against a future
 * platform that does not.
 */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url').replace(/=+$/, '');
}

/**
 * Generates a token. The caller stores `hash` and transmits `token`.
 *
 * Returning both together is deliberate: it makes it impossible to store the
 * raw token by accident, because the field named `token` is never the one a
 * repository accepts.
 */
export function generateToken(randomBytes: RandomBytes): { token: string; hash: string } {
  const bytes = randomBytes(TOKEN_BYTE_LENGTH);
  if (bytes.length !== TOKEN_BYTE_LENGTH) {
    throw new RangeError(
      `generateToken: expected ${TOKEN_BYTE_LENGTH} random bytes, received ${bytes.length}`,
    );
  }
  const token = toBase64Url(bytes);
  return { token, hash: hashToken(token) };
}

/**
 * SHA-256, hex.
 *
 * The token itself is NEVER stored — only this. A database leak must not yield
 * usable sessions (§6.1). SHA-256 rather than Argon2 on purpose: the input is
 * already 256 bits of uniform randomness, so there is nothing to brute-force
 * and no reason to pay a work factor on every single request.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * THE expiry comparison. Every deadline in this module goes through it.
 *
 * The boundary is defined as: a token whose `expiresAt` is exactly `now` IS
 * expired. Expiry is inclusive of the instant it names — "expires at 12:00"
 * means it does not work at 12:00. Choosing the other convention is defensible;
 * choosing neither, and having three call sites disagree, is not.
 */
export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/** `now + ttlMs`. Kept here so no call site does date arithmetic by hand. */
export function expiryFrom(now: Date, ttlMs: number): Date {
  return new Date(now.getTime() + ttlMs);
}

/**
 * Sliding renewal (§6.5, step 4): extend the session when it has been used and
 * `lastUsedAt` is older than 24 hours. Active users are never logged out; an
 * idle one still hits the 30-day absolute ceiling.
 *
 * Pure decision, no I/O — the caller performs the write.
 */
export function shouldRenewSession(
  lastUsedAt: Date,
  now: Date,
  renewAfterMs: number = SESSION_RENEW_AFTER_MS,
): boolean {
  return now.getTime() - lastUsedAt.getTime() >= renewAfterMs;
}

/**
 * Hashes an IP address for storage and for rate-limit keys.
 *
 * An IP address is personal data. `sessions.ip_hash` is named for a reason,
 * and a rate-limit key sitting in a cache is just as readable as a column.
 */
export function hashIp(ip: string): string {
  return createHash('sha256').update(ip, 'utf8').digest('hex').slice(0, 32);
}
