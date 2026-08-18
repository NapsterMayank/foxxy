import { describe, expect, it } from 'vitest';
import {
  LINK_OTP_LENGTH,
  LINK_OTP_LOCK_MS,
  LINK_OTP_MAX_ATTEMPTS,
  LINK_OTP_SEARCH_SPACE,
  LINK_OTP_TTL_MS,
  generateLinkOtp,
  hashLinkOtp,
  isLinkOtpExpired,
  isLinkOtpLocked,
  isResendTooSoon,
  verifyLinkOtp,
} from '../domain/link-otp';

/**
 * ===========================================================================
 * THE GUARDIAN-LINK SECOND FACTOR, AS PURE FUNCTIONS — migration 0007.
 *
 * A six-digit OTP is ~20 bits. Nothing here is protected by the secret being
 * large, so every property below is one of the controls that IS doing the
 * work — and a test that only checked "the right code verifies" would pass
 * against an implementation with none of them.
 * ===========================================================================
 */

describe('generating an OTP', () => {
  it('is six digits', () => {
    const otp = generateLinkOtp((max) => Math.floor(max / 2));

    expect(otp).toHaveLength(LINK_OTP_LENGTH);
    expect(otp).toMatch(/^\d{6}$/);
  });

  /*
   * `000042` MUST BE A VALID OTP. Dropping leading zeros would shrink the space
   * by 10% and bias it towards larger numbers — a silent loss that no test of
   * the happy path would ever notice.
   */
  it('pads a small draw rather than shortening it', () => {
    expect(generateLinkOtp(() => 42)).toBe('000042');
    expect(generateLinkOtp(() => 0)).toBe('000000');
  });

  it('draws over the whole space in one call, not digit by digit', () => {
    const seen: number[] = [];
    generateLinkOtp((max) => {
      seen.push(max);
      return 1;
    });

    // Six separate draws would be the same distribution at six times the cost,
    // and would make `LINK_OTP_SEARCH_SPACE` a lie.
    expect(seen).toEqual([LINK_OTP_SEARCH_SPACE]);
  });

  it('reaches the top of the range', () => {
    expect(generateLinkOtp((max) => max - 1)).toBe('999999');
  });
});

describe('hashing', () => {
  /*
   * THE OTP IS NEVER STORED. A six-digit secret in a leaked table is a million
   * guesses, which is no guesses at all — so what a leak must not yield is the
   * code itself.
   */
  it('produces a digest that does not contain the OTP', () => {
    const hash = hashLinkOtp('123456', 'challenge-1');

    expect(hash).not.toContain('123456');
    expect(hash).toHaveLength(64);
  });

  /*
   * SALTED WITH THE CHALLENGE ID. Without it, two challenges that drew the same
   * OTP would share a digest — a leaked table would show which ones match, and
   * one cracked digest would unlock all of them.
   */
  it('gives the same OTP different digests under different challenges', () => {
    expect(hashLinkOtp('123456', 'challenge-a')).not.toBe(hashLinkOtp('123456', 'challenge-b'));
  });

  it('verifies the right OTP against its own challenge', () => {
    const hash = hashLinkOtp('123456', 'challenge-1');

    expect(verifyLinkOtp(hash, '123456', 'challenge-1')).toBe(true);
  });

  it('refuses the right OTP against a different challenge', () => {
    const hash = hashLinkOtp('123456', 'challenge-1');

    expect(verifyLinkOtp(hash, '123456', 'challenge-2')).toBe(false);
  });

  it('refuses a wrong OTP', () => {
    const hash = hashLinkOtp('123456', 'challenge-1');

    expect(verifyLinkOtp(hash, '123457', 'challenge-1')).toBe(false);
    expect(verifyLinkOtp(hash, '000000', 'challenge-1')).toBe(false);
  });

  /* A malformed stored value must not throw out of a constant-time compare. */
  it('refuses a digest of the wrong length instead of throwing', () => {
    expect(verifyLinkOtp('too-short', '123456', 'challenge-1')).toBe(false);
  });
});

describe('the deadlines', () => {
  const now = new Date('2026-06-01T09:00:00.000Z');

  it('expires at exactly the deadline, not after it', () => {
    // Same boundary convention as domain/token.ts#isExpired.
    expect(isLinkOtpExpired(now, now)).toBe(true);
    expect(isLinkOtpExpired(new Date(now.getTime() + 1), now)).toBe(false);
  });

  it('lives for ten minutes', () => {
    const issued = new Date(now.getTime() + LINK_OTP_TTL_MS);

    expect(isLinkOtpExpired(issued, now)).toBe(false);
    expect(isLinkOtpExpired(issued, new Date(now.getTime() + LINK_OTP_TTL_MS))).toBe(true);
  });

  it('treats a null lock as unlocked', () => {
    expect(isLinkOtpLocked(null, now)).toBe(false);
  });

  it('lifts a lock at the instant it ends', () => {
    expect(isLinkOtpLocked(new Date(now.getTime() + 1), now)).toBe(true);
    expect(isLinkOtpLocked(now, now)).toBe(false);
  });

  /*
   * EVERY SEND COSTS AN EMAIL TO A REAL PERSON. Without a cooldown the resend
   * button is a mail bomb aimed at whichever address the caller is signed in as,
   * and the per-parent hourly limit is too coarse to stop a burst.
   */
  it('holds a resend for a minute', () => {
    expect(isResendTooSoon(now, now)).toBe(true);
    expect(isResendTooSoon(now, new Date(now.getTime() + 59_000))).toBe(true);
    expect(isResendTooSoon(now, new Date(now.getTime() + 60_000))).toBe(false);
  });
});

describe('the numbers the controls are set against', () => {
  /*
   * Recorded as assertions because they are the whole security argument. Five
   * attempts against 10^6 is a 5-in-a-million success probability per
   * challenge; changing either number changes that, and should have to be a
   * deliberate edit to a test rather than a quiet edit to a constant.
   */
  it('is five attempts against a million candidates', () => {
    expect(LINK_OTP_SEARCH_SPACE).toBe(1_000_000);
    expect(LINK_OTP_MAX_ATTEMPTS).toBe(5);
  });

  it('locks for an hour — long enough to be pointless, short enough to recover', () => {
    expect(LINK_OTP_LOCK_MS).toBe(60 * 60 * 1000);
  });

  it('lives for ten minutes', () => {
    expect(LINK_OTP_TTL_MS).toBe(10 * 60 * 1000);
  });
});
