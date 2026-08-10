/**
 * Parent-child link codes — §6.8.
 *
 * PURE. Randomness is injected; the clock is injected as an argument.
 */

/**
 * The unambiguous alphabet.
 *
 * Excluded on purpose, and this is the whole point of the constant:
 *   `0` and `O`   indistinguishable in most sans-serif faces
 *   `1`, `I`, `l` the same three glyphs problem, worse
 *
 * A code is read aloud by a child to a parent, or copied off a screen onto
 * paper. Every excluded character is a support ticket that never happens.
 *
 * Kept sorted so the exclusions are visible at a glance.
 */
export const LINK_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** The characters deliberately absent. Asserted on directly by a test. */
export const AMBIGUOUS_CHARACTERS = '01OIL';

/** §6.8, step 1. */
export const LINK_CODE_LENGTH = 6;

/** §6.8, step 1: expires in 15 minutes. */
export const LINK_CODE_TTL_MS = 15 * 60 * 1000;

/** Seconds, for the cache TTL that backs "one active code per student". */
export const LINK_CODE_TTL_SECONDS = LINK_CODE_TTL_MS / 1000;

/**
 * Injected randomness. Given `max`, returns an integer in `[0, max)`.
 *
 * Declared as a port rather than reaching for `Math.random` so that (a) the
 * production implementation can be a CSPRNG and (b) a test can make the code
 * deterministic. A link code produced by `Math.random` is guessable, and the
 * failure is invisible.
 */
export type RandomInt = (max: number) => number;

/**
 * Generates a code.
 *
 * `LINK_CODE_ALPHABET.length` is 31, which is not a power of two, so a
 * modulo-based generator would bias the low characters. The `RandomInt` port
 * is specified as uniform over `[0, max)` and the production implementation
 * uses `crypto.randomInt`, which rejects-and-retries to stay uniform.
 */
export function generateLinkCode(randomInt: RandomInt, length: number = LINK_CODE_LENGTH): string {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    const position = randomInt(LINK_CODE_ALPHABET.length);
    const character = LINK_CODE_ALPHABET[position];
    if (character === undefined) {
      throw new RangeError(`generateLinkCode: random index ${position} is out of range`);
    }
    code += character;
  }
  return code;
}

/**
 * Normalises a code as typed by a parent.
 *
 * Upper-cases and strips whitespace and separators, so `2f 7k-9h` and
 * `2F7K9H` are the same code. It does NOT map `O` to `0` or `l` to `1`:
 * neither `0` nor `1` is in the alphabet, so such a character means the parent
 * mistyped and the honest answer is to reject rather than guess.
 */
export function normaliseLinkCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * True when the normalised code has the right length and alphabet.
 *
 * Indexed rather than spread or split: `normaliseLinkCode` has already reduced
 * the input to `[A-Z0-9]`, so every unit is a single ASCII character and index
 * arithmetic is exact.
 */
export function isValidLinkCode(input: string): boolean {
  const normalised = normaliseLinkCode(input);
  if (normalised.length !== LINK_CODE_LENGTH) return false;

  for (let index = 0; index < normalised.length; index += 1) {
    const character = normalised.charAt(index);
    if (!LINK_CODE_ALPHABET.includes(character)) return false;
  }
  return true;
}

/**
 * Whether a code issued at `issuedAt` is still usable at `now`.
 *
 * Shares the boundary convention with `token.ts#isExpired`: a code whose
 * expiry is exactly `now` is expired.
 */
export function isLinkCodeExpired(
  issuedAt: Date,
  now: Date,
  ttlMs: number = LINK_CODE_TTL_MS,
): boolean {
  return now.getTime() - issuedAt.getTime() >= ttlMs;
}

/**
 * The total search space: 31^6, about 887 million.
 *
 * Recorded next to the constant rather than left implicit, because it is the
 * number that justifies the rate limit. At 5 attempts per hour per parent
 * account, a brute force takes roughly 20,000 years — and the 15-minute expiry
 * means the target has moved long before then. Change the length or the
 * alphabet and this number changes with it.
 */
export const LINK_CODE_SEARCH_SPACE = LINK_CODE_ALPHABET.length ** LINK_CODE_LENGTH;
