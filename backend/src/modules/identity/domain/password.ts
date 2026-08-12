import { COMMON_PASSWORDS } from './common-passwords';

/**
 * Password strength rules — 01-BACKEND-IMPLEMENTATION-PLAN.md §6.2.
 *
 * PURE. No I/O, no clock, no randomness, no environment. Every input arrives
 * as an argument and every output is a return value, which is what makes the
 * tests instant and deterministic.
 *
 * Two rules, and deliberately only two:
 *
 *  1. Minimum 10 characters.
 *  2. Not a common password.
 *
 * There are NO character-class rules — no "must contain a digit", no "must
 * contain a symbol". Length beats complexity, and complexity rules push people
 * towards `Passw0rd!`, which is in every breach corpus. This is a considered
 * position, not an omission; do not "improve" it by adding a symbol rule.
 */

/** §6.2, step 1. */
export const MIN_PASSWORD_LENGTH = 10;

/** An upper bound exists only to stop a megabyte reaching the hasher. */
export const MAX_PASSWORD_LENGTH = 200;

export type PasswordRejectionReason = 'too_short' | 'too_long' | 'too_common';

export type PasswordCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PasswordRejectionReason; readonly message: string };

/** Character substitutions people reach for when a site demands "complexity". */
const LEETSPEAK: ReadonlyMap<string, string> = new Map([
  ['0', 'o'],
  ['1', 'i'],
  ['3', 'e'],
  ['4', 'a'],
  ['5', 's'],
  ['7', 't'],
  ['8', 'b'],
  ['@', 'a'],
  ['$', 's'],
  ['!', 'i'],
  ['+', 't'],
]);

/**
 * Reduces a password to the form used for deny-list comparison.
 *
 * `P@ssw0rd123!` and `password` collapse to the same string, so one dictionary
 * entry covers a whole family of decorated variants. With the full published
 * top-10,000 now bundled (D-018), that multiplier applies to every one of them
 * — see the note at the top of `common-passwords.ts`.
 *
 * ONE KNOWN GAP, asserted by a test rather than left unsaid: a substitution in
 * the FIRST character is not seen through. `8utterfly` normalises to
 * `utterfly`, because stripping runs before de-leeting and the order cannot be
 * reversed without a worse failure (see below).
 *
 * Exported because it is worth testing directly: it is the reason the deny
 * list is effective, and a silent regression here would weaken the rule
 * without failing any other test.
 */
export function normalisePasswordForComparison(password: string): string {
  const lowered = password.toLowerCase();

  // ORDER MATTERS, and it is the opposite of what reads naturally.
  //
  // Strip the decoration FIRST, then reverse the substitutions. Doing it the
  // other way round turns `hello2024` into `helloaoaa` — the trailing digits
  // become letters, so there is no longer any decoration left to strip, and
  // the entry `hello` never matches. Every digit in the corpus would be
  // silently protected by the very step meant to see through it.
  const stripped = lowered.replace(/^[^a-z]+/, '').replace(/[^a-z]+$/, '');

  let deLeeted = '';
  for (const character of stripped) {
    deLeeted += LEETSPEAK.get(character) ?? character;
  }
  return deLeeted;
}

const COMMON_SET: ReadonlySet<string> = new Set(
  COMMON_PASSWORDS.flatMap((entry) => [entry, normalisePasswordForComparison(entry)]).filter(
    (entry) => entry.length > 0,
  ),
);

/**
 * True when the password is on the deny list, either exactly or after
 * normalisation.
 *
 * The dictionary is a parameter with a default so a test can supply its own
 * two-entry list and assert the matching rules rather than the contents of the
 * shipped corpus.
 */
export function isCommonPassword(
  password: string,
  dictionary: ReadonlySet<string> = COMMON_SET,
): boolean {
  if (dictionary.has(password.toLowerCase())) return true;

  const normalised = normalisePasswordForComparison(password);
  return normalised.length > 0 && dictionary.has(normalised);
}

/**
 * The single strength gate. Returns a result rather than throwing, because a
 * domain function decides — it does not control flow for its caller.
 *
 * Order matters: length is checked before the deny list so that a two-character
 * password gets the length message, which is the one the user can act on.
 */
export function checkPasswordStrength(
  password: string,
  dictionary: ReadonlySet<string> = COMMON_SET,
): PasswordCheck {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: 'too_short',
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: 'too_long',
      message: `Use at most ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }

  if (isCommonPassword(password, dictionary)) {
    return {
      ok: false,
      reason: 'too_common',
      // Clear, and it names the fix. §6.2 asks for a clear message.
      message: 'That password appears in public breach lists. Choose a different one.',
    };
  }

  return { ok: true };
}

/**
 * Trim and lowercase. The `citext` column is the backstop; this is the primary
 * defence, applied before the value ever reaches a query (§6.2, step 3).
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
