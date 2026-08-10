import { describe, expect, it } from 'vitest';
import { FixedClock } from '@/platform/clock/index';
import {
  EMAIL_VERIFICATION_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  SESSION_RENEW_AFTER_MS,
  TOKEN_BYTE_LENGTH,
  TOKEN_STRING_LENGTH,
  expiryFrom,
  generateToken,
  hashIp,
  hashToken,
  isExpired,
  shouldRenewSession,
} from '../domain/token';

/**
 * Domain tests — §8.1 "token length and alphabet" and "expiry comparison AT
 * THE EXACT BOUNDARY".
 *
 * Every time comparison here goes through `FixedClock`. There is no
 * `new Date()` in this file and no `sleep`: a test that waits for a deadline
 * is a test that is slow and eventually flaky (§9.5).
 */

/** Deterministic randomness, so the produced token is assertable. */
function fixedBytes(fill: number): (size: number) => Uint8Array {
  return (size: number): Uint8Array => new Uint8Array(size).fill(fill);
}

describe('generateToken — length and alphabet', () => {
  it('draws exactly 32 bytes', () => {
    let requested = -1;
    generateToken((size) => {
      requested = size;
      return new Uint8Array(size);
    });
    expect(requested).toBe(TOKEN_BYTE_LENGTH);
    expect(TOKEN_BYTE_LENGTH).toBe(32);
  });

  it('encodes 32 bytes as 43 base64url characters', () => {
    const { token } = generateToken(fixedBytes(0xab));
    expect(token).toHaveLength(TOKEN_STRING_LENGTH);
  });

  it('uses the base64url alphabet only — no +, / or = ', () => {
    // 0xfb 0xff exercises the two characters that differ between base64 and
    // base64url; a plain base64 encoder would emit '+' and '/' here.
    const { token } = generateToken((size) => {
      const bytes = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) {
        bytes[index] = index % 2 === 0 ? 0xfb : 0xff;
      }
      return bytes;
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain('+');
    expect(token).not.toContain('/');
    expect(token).not.toContain('=');
  });

  it('is unpadded', () => {
    const { token } = generateToken(fixedBytes(0));
    expect(token.endsWith('=')).toBe(false);
  });

  it('returns the hash of the token it returns, never the token itself', () => {
    const { token, hash } = generateToken(fixedBytes(7));
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toBe(token);
  });

  it('produces a different token for different bytes', () => {
    expect(generateToken(fixedBytes(1)).token).not.toBe(generateToken(fixedBytes(2)).token);
  });

  it('throws when the randomness source returns the wrong number of bytes', () => {
    // A silently short token would be a catastrophic entropy loss, so this
    // fails loudly rather than encoding whatever it was given.
    expect(() => generateToken(() => new Uint8Array(8))).toThrow(RangeError);
  });
});

describe('hashToken', () => {
  it('produces 64 hex characters — SHA-256', () => {
    expect(hashToken('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('differs for a single-character change', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('is a known SHA-256 value', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('isExpired — THE boundary', () => {
  const clock = new FixedClock('2026-03-01T12:00:00.000Z');
  const deadline = new Date('2026-03-01T12:00:00.000Z');

  it('is NOT expired one millisecond before the deadline', () => {
    const before = new FixedClock('2026-03-01T11:59:59.999Z');
    expect(isExpired(deadline, before.now())).toBe(false);
  });

  it('IS expired at exactly the deadline', () => {
    // The stated convention: expiry is inclusive of the instant it names.
    // "Expires at 12:00" means it does not work at 12:00.
    expect(isExpired(deadline, clock.now())).toBe(true);
  });

  it('IS expired one millisecond after the deadline', () => {
    const after = new FixedClock('2026-03-01T12:00:00.001Z');
    expect(isExpired(deadline, after.now())).toBe(true);
  });

  it('holds the same convention for a verification token at its 24-hour edge', () => {
    const issued = new FixedClock('2026-03-01T00:00:00.000Z');
    const expiresAt = expiryFrom(issued.now(), EMAIL_VERIFICATION_TTL_MS);

    issued.advanceMs(EMAIL_VERIFICATION_TTL_MS - 1);
    expect(isExpired(expiresAt, issued.now())).toBe(false);

    issued.advanceMs(1);
    expect(isExpired(expiresAt, issued.now())).toBe(true);
  });

  it('holds the same convention for a reset token at its 1-hour edge', () => {
    const issued = new FixedClock('2026-03-01T00:00:00.000Z');
    const expiresAt = expiryFrom(issued.now(), PASSWORD_RESET_TTL_MS);

    issued.advanceMs(PASSWORD_RESET_TTL_MS - 1);
    expect(isExpired(expiresAt, issued.now())).toBe(false);

    issued.advanceMs(1);
    expect(isExpired(expiresAt, issued.now())).toBe(true);
  });
});

describe('expiryFrom', () => {
  it('adds the ttl to the given instant', () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    expect(expiryFrom(clock.now(), 60_000).toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('returns the same instant for a zero ttl', () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    expect(expiryFrom(clock.now(), 0).getTime()).toBe(clock.now().getTime());
  });

  it('does not mutate the instant it was given', () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    const now = clock.now();
    expiryFrom(now, 5_000);
    expect(now.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('shouldRenewSession — the 24-hour sliding window', () => {
  const lastUsed = new Date('2026-04-01T00:00:00.000Z');

  it('does not renew one millisecond before 24 hours', () => {
    const clock = new FixedClock(lastUsed);
    clock.advanceMs(SESSION_RENEW_AFTER_MS - 1);
    expect(shouldRenewSession(lastUsed, clock.now())).toBe(false);
  });

  it('renews at exactly 24 hours', () => {
    const clock = new FixedClock(lastUsed);
    clock.advanceMs(SESSION_RENEW_AFTER_MS);
    expect(shouldRenewSession(lastUsed, clock.now())).toBe(true);
  });

  it('renews well past 24 hours', () => {
    const clock = new FixedClock(lastUsed);
    clock.advanceDays(3);
    expect(shouldRenewSession(lastUsed, clock.now())).toBe(true);
  });

  it('does not renew a session used a moment ago', () => {
    const clock = new FixedClock(lastUsed);
    clock.advanceSeconds(30);
    expect(shouldRenewSession(lastUsed, clock.now())).toBe(false);
  });

  it('honours an overridden window', () => {
    const clock = new FixedClock(lastUsed);
    clock.advanceSeconds(10);
    expect(shouldRenewSession(lastUsed, clock.now(), 5_000)).toBe(true);
  });
});

describe('hashIp', () => {
  it('never returns the address it was given', () => {
    expect(hashIp('203.0.113.9')).not.toContain('203.0.113.9');
  });

  it('is deterministic, so it can key a rate-limit counter', () => {
    expect(hashIp('203.0.113.9')).toBe(hashIp('203.0.113.9'));
  });

  it('differs between addresses', () => {
    expect(hashIp('203.0.113.9')).not.toBe(hashIp('203.0.113.10'));
  });

  it('is a fixed 32 hex characters regardless of address length', () => {
    expect(hashIp('::1')).toMatch(/^[0-9a-f]{32}$/);
    expect(hashIp('2001:0db8:0000:0000:0000:ff00:0042:8329')).toMatch(/^[0-9a-f]{32}$/);
  });
});
