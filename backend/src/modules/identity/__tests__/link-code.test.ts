import { describe, expect, it } from 'vitest';
import { FixedClock } from '@/platform/clock/index';
import {
  AMBIGUOUS_CHARACTERS,
  LINK_CODE_ALPHABET,
  LINK_CODE_LENGTH,
  LINK_CODE_SEARCH_SPACE,
  LINK_CODE_TTL_MS,
  generateLinkCode,
  isLinkCodeExpired,
  isValidLinkCode,
  normaliseLinkCode,
} from '../domain/link-code';

/**
 * Domain tests — §8.1 "link code excludes ambiguous characters" and the
 * expiry boundary.
 */

/** Deterministic randomness: cycles 0,1,2,... through the alphabet. */
function sequentialInts(start = 0): (max: number) => number {
  let next = start;
  return (max: number): number => {
    const value = next % max;
    next += 1;
    return value;
  };
}

describe('LINK_CODE_ALPHABET — the ambiguity rule', () => {
  /**
   * The point of the alphabet, asserted character by character. A code is read
   * aloud by a child to a parent or copied off a screen onto paper; every one
   * of these is a support ticket that never happens.
   */
  it.each(['0', '1', 'O', 'I', 'L'])('excludes the ambiguous character %s', (character) => {
    expect(LINK_CODE_ALPHABET).not.toContain(character);
  });

  it('excludes lower-case l as well as upper-case I', () => {
    expect(LINK_CODE_ALPHABET.toUpperCase()).toBe(LINK_CODE_ALPHABET);
    expect(LINK_CODE_ALPHABET).not.toContain('l');
  });

  it('lists exactly the characters named in AMBIGUOUS_CHARACTERS as absent', () => {
    for (const character of AMBIGUOUS_CHARACTERS) {
      expect(LINK_CODE_ALPHABET.includes(character)).toBe(false);
    }
  });

  it('contains no duplicates', () => {
    expect(new Set(LINK_CODE_ALPHABET).size).toBe(LINK_CODE_ALPHABET.length);
  });

  it('still offers 31 characters after the exclusions', () => {
    expect(LINK_CODE_ALPHABET.length).toBe(31);
  });

  it('gives a search space large enough to justify the rate limit', () => {
    // Recorded next to the constant: 31^6 is about 887 million. At 5 attempts
    // per hour a brute force takes roughly 20,000 years.
    expect(LINK_CODE_SEARCH_SPACE).toBe(31 ** 6);
    expect(LINK_CODE_SEARCH_SPACE).toBeGreaterThan(800_000_000);
  });
});

describe('generateLinkCode', () => {
  it('produces a code of the specified length', () => {
    expect(generateLinkCode(sequentialInts())).toHaveLength(LINK_CODE_LENGTH);
    expect(LINK_CODE_LENGTH).toBe(6);
  });

  it('draws every character from the alphabet', () => {
    const code = generateLinkCode(() => 0);
    for (const character of code) {
      expect(LINK_CODE_ALPHABET).toContain(character);
    }
  });

  it('asks for a uniform integer over the full alphabet, never a modulo', () => {
    // The alphabet has 31 characters, which is not a power of two. If the
    // caller passed anything other than the full length here, the generator
    // would be biased and no other test would notice.
    const seen: number[] = [];
    generateLinkCode((max) => {
      seen.push(max);
      return 0;
    });
    expect(seen).toEqual(Array<number>(LINK_CODE_LENGTH).fill(LINK_CODE_ALPHABET.length));
  });

  it('maps index 0 to the first alphabet character', () => {
    expect(generateLinkCode(() => 0)).toBe('222222');
  });

  it('maps sequential indices across the alphabet', () => {
    expect(generateLinkCode(sequentialInts())).toBe(LINK_CODE_ALPHABET.slice(0, LINK_CODE_LENGTH));
  });

  it('honours a requested length', () => {
    expect(generateLinkCode(() => 0, 3)).toHaveLength(3);
  });

  it('returns an empty string for a zero length rather than looping', () => {
    expect(generateLinkCode(() => 0, 0)).toBe('');
  });

  it('throws when the randomness source returns an out-of-range index', () => {
    expect(() => generateLinkCode(() => 999)).toThrow(RangeError);
  });
});

describe('normaliseLinkCode', () => {
  it('upper-cases', () => {
    expect(normaliseLinkCode('a7k9hz')).toBe('A7K9HZ');
  });

  it('strips spaces and separators, so a code read aloud still works', () => {
    expect(normaliseLinkCode('2f7 k-9h')).toBe('2F7K9H');
  });

  it('leaves an already-normal code unchanged', () => {
    expect(normaliseLinkCode('2F7K9H')).toBe('2F7K9H');
  });

  it('does NOT translate O into 0 or l into 1', () => {
    // Neither 0 nor 1 is in the alphabet, so such a character means the parent
    // mistyped. Guessing what they meant would silently accept a wrong code.
    expect(normaliseLinkCode('O1lI23')).toBe('O1LI23');
    expect(isValidLinkCode('O1lI23')).toBe(false);
  });

  it('returns an empty string when nothing survives', () => {
    expect(normaliseLinkCode('  --  ')).toBe('');
  });
});

describe('isValidLinkCode', () => {
  it('accepts a well-formed code', () => {
    expect(isValidLinkCode('2F7K9H')).toBe(true);
  });

  it('accepts a code that only becomes well-formed after normalisation', () => {
    expect(isValidLinkCode(' 2f7-k9h ')).toBe(true);
  });

  it('rejects a code one character short', () => {
    expect(isValidLinkCode('2F7K9')).toBe(false);
  });

  it('rejects a code one character long', () => {
    expect(isValidLinkCode('2F7K9HH')).toBe(false);
  });

  it('rejects an empty code', () => {
    expect(isValidLinkCode('')).toBe(false);
  });

  it.each(['0', '1', 'O', 'I', 'L'])(
    'rejects a code containing the excluded character %s',
    (character) => {
      expect(isValidLinkCode(`2F7K9${character}`)).toBe(false);
    },
  );

  it('rejects a code with a symbol that normalisation strips to the wrong length', () => {
    expect(isValidLinkCode('2F7K9!')).toBe(false);
  });
});

describe('isLinkCodeExpired — the 15-minute boundary', () => {
  const issuedAt = new Date('2026-05-01T09:00:00.000Z');

  it('is 15 minutes, as §6.8 specifies', () => {
    expect(LINK_CODE_TTL_MS).toBe(15 * 60 * 1000);
  });

  it('is not expired at the instant of issue', () => {
    const clock = new FixedClock(issuedAt);
    expect(isLinkCodeExpired(issuedAt, clock.now())).toBe(false);
  });

  it('is not expired one millisecond before 15 minutes', () => {
    const clock = new FixedClock(issuedAt);
    clock.advanceMs(LINK_CODE_TTL_MS - 1);
    expect(isLinkCodeExpired(issuedAt, clock.now())).toBe(false);
  });

  it('IS expired at exactly 15 minutes', () => {
    const clock = new FixedClock(issuedAt);
    clock.advanceMs(LINK_CODE_TTL_MS);
    expect(isLinkCodeExpired(issuedAt, clock.now())).toBe(true);
  });

  it('IS expired one millisecond after 15 minutes', () => {
    const clock = new FixedClock(issuedAt);
    clock.advanceMs(LINK_CODE_TTL_MS + 1);
    expect(isLinkCodeExpired(issuedAt, clock.now())).toBe(true);
  });

  it('honours an overridden ttl', () => {
    const clock = new FixedClock(issuedAt);
    clock.advanceSeconds(10);
    expect(isLinkCodeExpired(issuedAt, clock.now(), 5_000)).toBe(true);
  });
});
