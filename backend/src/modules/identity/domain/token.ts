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
 * THE SLIDING (IDLE) WINDOW — the first of the two session bounds. D-219.
 *
 * §6.1 states two rules that only make sense together: "lifetime 30 days
 * absolute" and "extend when used and older than 24 hours". Read as one rule
 * they contradict each other, and the module implemented only the second: every
 * renewal replaced `expires_at` with `now + 30 days` and NOTHING ever consulted
 * `created_at`. A stolen token touched once inside each renewal interval
 * therefore never expired — a permanent credential, issued by a system whose own
 * comment claimed a 30-day ceiling.
 *
 * They are now two distinct bounds:
 *
 *   IDLE (this constant)  the deadline stored in `sessions.expires_at`. It
 *                         slides forward on use, so an active user is never
 *                         signed out.
 *   ABSOLUTE (config)     `created_at + sessionTtlDays`. It NEVER moves. Every
 *                         renewal is clamped to it and every validation checks
 *                         it independently, so a session dies on this deadline
 *                         no matter how much it is used.
 *
 * Fourteen days rather than thirty: it is the shortest window that keeps a user
 * signed in across a normal holiday absence, and any window shorter than the
 * absolute ceiling is what makes renewal mean anything at all. The number is a
 * PRODUCT decision sitting in a constant — see D-219 — and the only property the
 * security argument depends on is `SESSION_IDLE_TTL_MS < absolute ceiling`.
 */
export const SESSION_IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

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
 * THE ABSOLUTE CEILING — `created_at + absoluteTtlMs`, and it never moves.
 *
 * Deliberately a function OF `createdAt` ONLY. It takes no `now` and no
 * `lastUsedAt`, because the entire defect it closes (D-219) was that the one
 * deadline in the module was a function of `now` and could therefore be pushed
 * forward forever by using the credential.
 */
export function absoluteSessionDeadline(createdAt: Date, absoluteTtlMs: number): Date {
  return new Date(createdAt.getTime() + absoluteTtlMs);
}

/**
 * The deadline to write into `sessions.expires_at`: the sliding window, CLAMPED
 * to the absolute ceiling.
 *
 * Clamped rather than merely checked elsewhere, so the stored row is never a
 * deadline the system would refuse to honour. `sessions_expires_at_idx` is what
 * a reaper would sweep, and a row claiming to live past its ceiling would
 * survive that sweep while failing every validation — a dead session that looks
 * alive to operations.
 */
export function sessionDeadline(
  createdAt: Date,
  now: Date,
  idleTtlMs: number,
  absoluteTtlMs: number,
): Date {
  const sliding = now.getTime() + idleTtlMs;
  const ceiling = absoluteSessionDeadline(createdAt, absoluteTtlMs).getTime();
  return new Date(Math.min(sliding, ceiling));
}

/**
 * Whether a session has passed its ABSOLUTE ceiling, independent of renewal.
 *
 * Checked on every validation as well as clamped at every write. Two enforcement
 * points for one rule is not redundancy here: the clamp protects rows written by
 * this version of the code, and the check protects rows already in the table —
 * every session issued before this fix carries an unclamped `expires_at`.
 */
export function isPastAbsoluteLifetime(createdAt: Date, now: Date, absoluteTtlMs: number): boolean {
  return isExpired(absoluteSessionDeadline(createdAt, absoluteTtlMs), now);
}

/**
 * Hashes an IP address (or any other identifier) for storage and for
 * rate-limit keys. SALTED — D-221.
 *
 * An IP address is personal data. `sessions.ip_hash` is named for a reason, and
 * a rate-limit key sitting in a cache is just as readable as a column.
 *
 * IT WAS UNSALTED, WHICH MADE THE HASH DECORATIVE. There are 2^32 IPv4
 * addresses; a plain SHA-256 over that space is enumerable end to end in
 * minutes on a laptop, so anyone holding the column held the addresses. Worse,
 * an unsalted digest is a STABLE CROSS-STORE CORRELATOR: the same value appears
 * in `sessions.ip_hash` and in a cache key, so a cache dump and a database dump
 * join on it perfectly.
 *
 * The salt is a REQUIRED PARAMETER with no default. A default is how this
 * regresses — one call site omitting it would silently reproduce the original
 * digest, and every test would still pass.
 *
 * ROTATING THE SALT RESETS EVERY RATE-LIMIT COUNTER AND ORPHANS EVERY STORED
 * `ip_hash`. That is ACCEPTED, and it is the same loss a process restart already
 * causes for the in-process fallback counters: the counters are 15-minute and
 * 1-hour windows whose worst case is one extra window's budget for an attacker
 * who cannot observe the rotation, and `ip_hash` is diagnostic data, not a
 * credential and not a foreign key. Rotate at will; do not rotate hourly.
 *
 * THE SEPARATOR IS A NUL, AND IT IS DOMAIN SEPARATION RATHER THAN DECORATION.
 * Concatenating salt and value with nothing between them makes `('ab', 'c')` and
 * `('a', 'bc')` the same digest, so a rotated salt could collide with the one it
 * replaced. NUL is the one byte that occurs in neither an IP string nor an email
 * address, so nothing can be crafted to sit across the boundary.
 *
 * It is written as the ESCAPE `\u0000`, never as the literal control character —
 * which is what stood here first. A raw NUL makes `git` and `grep` classify the
 * whole file as binary, and a file the tools refuse to search is a file nobody
 * reviews.
 */
export function hashIp(value: string, salt: string): string {
  return createHash('sha256').update(`${salt}\u0000${value}`, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Binds a salt once, at the composition edge, and returns the hasher.
 *
 * Exists so that no request-path call site holds the salt: `contextOf` and the
 * service each receive a function, not a secret.
 */
export function createIpHasher(salt: string): (value: string) => string {
  if (salt.length === 0) {
    throw new RangeError('createIpHasher: the salt must not be empty');
  }
  return (value: string): string => hashIp(value, salt);
}
