import { createHash, timingSafeEqual } from 'node:crypto';
import type { RandomInt } from './link-code';

/**
 * ===========================================================================
 * THE SECOND FACTOR ON GUARDIAN LINKING — migration 0007.
 *
 * A six-digit OTP, emailed to the PARENT'S OWN verified address. It does not
 * verify an email and it is not the consent step; the code hand-off is the
 * consent (a student reading their code aloud is a deliberate act). What a bare
 * code cannot prove is that the person TYPING it controls the parent account —
 * a code overheard in a classroom would otherwise be enough.
 *
 * ---------------------------------------------------------------------------
 * SIX DIGITS IS ~20 BITS, AND EVERYTHING BELOW EXISTS BECAUSE OF THAT.
 *
 * The session token in `domain/token.ts` is 256 bits of uniform randomness, and
 * its header explains why SHA-256 with no work factor is right for it: there is
 * nothing to brute-force. NONE OF THAT REASONING TRANSFERS HERE. A million
 * candidates is a trivial offline search, so this file leans entirely on
 * ONLINE controls — a hard attempt cap, a lock, a short life — rather than on
 * the secret being large.
 *
 * The digest is still SHA-256 and deliberately so: the attempt cap is what
 * bounds an online attacker, and Argon2 on a value that can be enumerated
 * offline in seconds would buy nothing while costing a work factor on every
 * verification. What protects a LEAKED table is that the row is useless within
 * ten minutes, not the hash.
 * ===========================================================================
 */

/** Ten minutes. Long enough to switch to an inbox, short enough to be useless later. */
export const LINK_OTP_TTL_MS = 10 * 60 * 1000;

/**
 * Wrong guesses before the challenge locks.
 *
 * Five, against a million candidates, is a success probability of 5 in 10⁶ per
 * challenge. The lock is an HOUR — long enough that grinding is pointless,
 * short enough that a parent who fat-fingered it five times is not permanently
 * stuck.
 */
export const LINK_OTP_MAX_ATTEMPTS = 5;
export const LINK_OTP_LOCK_MS = 60 * 60 * 1000;

/**
 * The gap between two sends for the same challenge.
 *
 * EVERY SEND COSTS AN EMAIL TO A REAL PERSON'S INBOX. Without this, the resend
 * button is a mail bomb aimed at whichever address the attacker chose, and the
 * per-IP limit does not help because the victim is not the one being rated.
 */
export const LINK_OTP_RESEND_COOLDOWN_MS = 60 * 1000;

/** Digits, so the whole space is reachable and every character is unambiguous. */
export const LINK_OTP_LENGTH = 6;

/** The total space: 10^6. Recorded because it is what the attempt cap is set against. */
export const LINK_OTP_SEARCH_SPACE = 10 ** LINK_OTP_LENGTH;

/**
 * A zero-padded six-digit code.
 *
 * `randomInt` rather than `Math.random`, and one call over the WHOLE RANGE
 * rather than six calls for six digits. Six independent draws is the same
 * distribution but six times the syscalls, and the padding is what keeps
 * `000042` a valid OTP — dropping leading zeros would silently shrink the space
 * by 10% and bias it towards larger numbers.
 */
export function generateLinkOtp(randomInt: RandomInt): string {
  return String(randomInt(LINK_OTP_SEARCH_SPACE)).padStart(LINK_OTP_LENGTH, '0');
}

/**
 * `sha256(otp || challengeId)`.
 *
 * THE ID IS MIXED IN so two challenges that happen to draw the same OTP do not
 * produce the same digest — otherwise a leaked table would show which
 * challenges share a code, and one cracked digest would unlock all of them.
 */
export function hashLinkOtp(otp: string, challengeId: string): string {
  return createHash('sha256').update(`${otp}${challengeId}`, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of the stored digest against a submitted OTP.
 *
 * `timingSafeEqual` AND NOT `===`. Both digests are the same length so the
 * length check never rejects, and a byte-by-byte early return would leak how
 * much of the digest matched — which for a six-digit secret is enough to walk
 * it out one digit at a time, well inside the attempt cap.
 */
export function verifyLinkOtp(storedHash: string, otp: string, challengeId: string): boolean {
  const candidate = hashLinkOtp(otp, challengeId);
  const stored = Buffer.from(storedHash, 'utf8');
  const given = Buffer.from(candidate, 'utf8');
  if (stored.length !== given.length) return false;
  return timingSafeEqual(stored, given);
}

/** Whether a challenge is still open. Expiry at exactly `now` counts as expired. */
export function isLinkOtpExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/** Whether a lock is still in force. A lock ending exactly at `now` has lifted. */
export function isLinkOtpLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}

/** Whether another send is allowed yet. */
export function isResendTooSoon(lastSentAt: Date, now: Date): boolean {
  return now.getTime() - lastSentAt.getTime() < LINK_OTP_RESEND_COOLDOWN_MS;
}
