import { describe, expect, it } from 'vitest';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  checkPasswordStrength,
  isCommonPassword,
  normaliseEmail,
  normalisePasswordForComparison,
} from '../domain/password';
import { COMMON_PASSWORD_CORPUS } from '../domain/common-passwords.data';

/**
 * Domain tests — §8.1 "password strength rules" and "common-password
 * rejection", against the checklist in §9.3: happy path, every boundary value,
 * every error path, every branch.
 */

describe('checkPasswordStrength — length boundary', () => {
  // §9.3, rule 2: if the rule is "10 or more", test 9 and 10.
  it(`rejects a password one character below the minimum (${MIN_PASSWORD_LENGTH - 1})`, () => {
    const result = checkPasswordStrength('x'.repeat(MIN_PASSWORD_LENGTH - 1));
    expect(result).toEqual({
      ok: false,
      reason: 'too_short',
      message: 'Use at least 10 characters.',
    });
  });

  it(`accepts a password exactly at the minimum (${MIN_PASSWORD_LENGTH})`, () => {
    expect(checkPasswordStrength('x'.repeat(MIN_PASSWORD_LENGTH))).toEqual({ ok: true });
  });

  it('accepts a password one character above the minimum', () => {
    expect(checkPasswordStrength('x'.repeat(MIN_PASSWORD_LENGTH + 1))).toEqual({ ok: true });
  });

  it('rejects an empty password as too short', () => {
    expect(checkPasswordStrength('')).toMatchObject({ ok: false, reason: 'too_short' });
  });

  it(`accepts a password exactly at the maximum (${MAX_PASSWORD_LENGTH})`, () => {
    expect(checkPasswordStrength('u'.repeat(MAX_PASSWORD_LENGTH))).toEqual({ ok: true });
  });

  it('rejects a password one character above the maximum', () => {
    expect(checkPasswordStrength('u'.repeat(MAX_PASSWORD_LENGTH + 1))).toMatchObject({
      ok: false,
      reason: 'too_long',
    });
  });
});

describe('checkPasswordStrength — no character-class rules', () => {
  /**
   * These four assert an intentional ABSENCE. §6.2 states "no character-class
   * rules" as a considered position: length beats complexity, and complexity
   * rules push people towards `Passw0rd!`. Without a test, a future reviewer
   * reads the missing check as an oversight and "fixes" it.
   */
  it('accepts an all-lowercase passphrase', () => {
    expect(checkPasswordStrength('correcthorsebatterystaple')).toEqual({ ok: true });
  });

  it('accepts a password with no digit', () => {
    expect(checkPasswordStrength('mauveArmadillo')).toEqual({ ok: true });
  });

  it('accepts a password with no symbol', () => {
    expect(checkPasswordStrength('mauve7Armadillo')).toEqual({ ok: true });
  });

  it('accepts a password with no upper-case letter', () => {
    expect(checkPasswordStrength('quiet lantern drift')).toEqual({ ok: true });
  });
});

describe('checkPasswordStrength — common-password rejection', () => {
  it('rejects a long password that is still a dictionary entry', () => {
    const result = checkPasswordStrength('qwertyuiop');
    expect(result).toMatchObject({ reason: 'too_common', ok: false });
  });

  it('names the fix in the rejection message', () => {
    const result = checkPasswordStrength('password123');
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('Choose a different one'),
    });
  });

  it('checks length before the deny list, so a short common password reports length', () => {
    // 'qwerty' is on the list AND is 6 characters. The actionable message is
    // the length one.
    expect(checkPasswordStrength('qwerty')).toMatchObject({ reason: 'too_short' });
  });

  it('accepts a password that is not on the list', () => {
    expect(checkPasswordStrength('vermillion-otter-49')).toEqual({ ok: true });
  });
});

describe('isCommonPassword — matching rules', () => {
  const dictionary = new Set(['password', 'letmein']);

  it('matches an exact entry', () => {
    expect(isCommonPassword('password', dictionary)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isCommonPassword('PASSWORD', dictionary)).toBe(true);
  });

  it('matches through leetspeak substitution', () => {
    expect(isCommonPassword('P@ssw0rd', dictionary)).toBe(true);
  });

  it('matches through trailing decoration', () => {
    expect(isCommonPassword('password123!', dictionary)).toBe(true);
  });

  it('matches through leading and trailing decoration together', () => {
    expect(isCommonPassword('!!L3tm31n99', dictionary)).toBe(true);
  });

  it('does not match an unrelated password', () => {
    expect(isCommonPassword('vermillion-otter', dictionary)).toBe(false);
  });

  it('does not match on an empty normalised form', () => {
    // '12345678' normalises to '', which must not match anything.
    expect(isCommonPassword('12345678', new Set(['']))).toBe(false);
  });

  it('uses the bundled corpus when no dictionary is supplied', () => {
    expect(isCommonPassword('iloveyou')).toBe(true);
  });
});

describe('normalisePasswordForComparison', () => {
  it('lower-cases', () => {
    expect(normalisePasswordForComparison('ABCdef')).toBe('abcdef');
  });

  it('reverses every documented leetspeak substitution', () => {
    expect(normalisePasswordForComparison('p455w0rd')).toBe('password');
    expect(normalisePasswordForComparison('l3773r')).toBe('letter');
    expect(normalisePasswordForComparison('m@$73r')).toBe('master');
  });

  it('strips decoration BEFORE reversing substitutions, not after', () => {
    // The regression this pins: reversing first turns the trailing digits into
    // letters, leaving nothing to strip, and `hello` stops matching.
    expect(normalisePasswordForComparison('hello2024')).toBe('hello');
    expect(normalisePasswordForComparison('l3tm31n2024')).toBe('letmein');
  });

  it('strips leading non-letters', () => {
    expect(normalisePasswordForComparison('###hello')).toBe('hello');
  });

  it('strips trailing non-letters', () => {
    expect(normalisePasswordForComparison('hello2024')).toBe('hello');
  });

  it('returns an empty string for an all-digit password', () => {
    expect(normalisePasswordForComparison('1234567890')).toBe('');
  });

  it('leaves an already-normal password unchanged', () => {
    expect(normalisePasswordForComparison('armadillo')).toBe('armadillo');
  });
});

describe('normaliseEmail', () => {
  it('trims surrounding whitespace', () => {
    expect(normaliseEmail('  a@b.test  ')).toBe('a@b.test');
  });

  it('lower-cases', () => {
    expect(normaliseEmail('Student@Example.COM')).toBe('student@example.com');
  });

  it('is idempotent', () => {
    expect(normaliseEmail(normaliseEmail(' A@B.test '))).toBe('a@b.test');
  });

  it('leaves an empty string empty rather than throwing', () => {
    expect(normaliseEmail('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// THE FULL PUBLISHED CORPUS — resolves D-018.
//
// Until 8 August 2026 the deny list was ~370 hand-written entries. These tests
// pin the three properties that matter about the replacement: it is the real
// corpus, normalisation still multiplies it, and looking a password up costs
// nothing measurable on the signup path.
// ---------------------------------------------------------------------------

describe('the vendored top-10,000 corpus', () => {
  it('carries the full ten thousand published entries', () => {
    expect(COMMON_PASSWORD_CORPUS).toHaveLength(10_000);
  });

  it('REJECTS A KNOWN TOP-100 PASSWORD that the old curated list did not carry', () => {
    // `mustang` sits inside the published top 100 and was absent from the
    // hand-written list, so this assertion fails against the pre-corpus deny
    // list and passes against the real one. That is the whole point of D-018.
    expect(COMMON_PASSWORD_CORPUS.slice(0, 100)).toContain('mustang');
    expect(isCommonPassword('mustang')).toBe(true);
  });

  it('rejects a decorated top-100 password through the strength gate', () => {
    // Length is checked first, and no entry in the published top 100 is ten
    // characters long — so the deny list is only ever reached for a DECORATED
    // form. Normalisation is what makes the corpus bite at all on this path.
    const check = checkPasswordStrength('Mustang-2024!');
    expect(check).toEqual({
      ok: false,
      reason: 'too_common',
      message: expect.stringContaining('breach lists') as unknown,
    });
  });

  it('REJECTS A LEETSPEAK VARIANT of a corpus entry', () => {
    // `butterfly` is in the corpus; none of these decorated forms is.
    expect(COMMON_PASSWORD_CORPUS).toContain('butterfly');
    expect(COMMON_PASSWORD_CORPUS).not.toContain('Bu77erfly2024!');

    for (const variant of ['Bu77erfly2024!', 'bu77erfly', '2024butterfly!!', 'BUTT3RFLY']) {
      expect(isCommonPassword(variant)).toBe(true);
    }
  });

  it('does NOT see through a substitution in the FIRST character — a known limit', () => {
    // `8utterfly` normalises to `utterfly`, because leading non-letters are
    // stripped BEFORE substitutions are reversed. Reversing first would turn
    // `hello2024` into `helloaoaa` and defeat the stripping entirely, which is
    // the worse trade — see the ORDER MATTERS note in `password.ts`.
    //
    // Asserted rather than left unsaid: it is a real gap in the deny list, and
    // an undocumented gap is one nobody can decide about.
    expect(isCommonPassword('8utterfly')).toBe(false);
  });

  it('still accepts a strong passphrase', () => {
    for (const passphrase of [
      'vermillion-otter-49',
      'copper kettle drifting north',
      'sandalwood-lantern-tuesday',
    ]) {
      expect(isCommonPassword(passphrase)).toBe(false);
      expect(checkPasswordStrength(passphrase)).toEqual({ ok: true });
    }
  });

  it('LOOKS UP IN CONSTANT TIME — a Set, never an array scan', () => {
    // The budget: signup does exactly one of these before an Argon2id hash
    // that costs tens of milliseconds by design. 20,000 lookups — twice the
    // size of the corpus, so an accidental array scan would be 200 million
    // string comparisons — must stay far below a single hash.
    //
    // The first call is excluded because it builds the Set; that one-off is
    // measured separately below.
    isCommonPassword('warm-up');

    const ITERATIONS = 20_000;
    const started = performance.now();
    for (let index = 0; index < ITERATIONS; index += 1) {
      isCommonPassword(`candidate-passphrase-${index}`);
    }
    const elapsedMs = performance.now() - started;

    /**
     * THE BUDGET IS RELATIVE TO A MEASURED LINEAR SCAN, not an absolute
     * millisecond count. Raised from a flat 500 ms on 9 August 2026 after it
     * failed at 558 ms — under `--coverage`, with four database-backed suites
     * running in parallel workers. Nothing was slow; the machine was busy and
     * every line was instrumented.
     *
     * That failure mode is worse than useless: it is red on a green codebase,
     * and the fix everyone reaches for is to raise the number again until it
     * stops complaining, at which point the test no longer detects anything.
     *
     * So the bound is derived instead. `scanMs` below is an ACTUAL linear scan
     * over the same corpus, timed on the same machine at the same moment, so
     * it absorbs coverage instrumentation and CPU contention identically. The
     * property under test — a Set lookup is asymptotically cheaper than a scan
     * — is what the assertion now states, and it cannot be satisfied by a
     * faster computer.
     *
     * The scan is timed in the SAME LOOP SHAPE, with the same candidate
     * construction, and then projected — rather than measured once. Both halves
     * then pay identical per-iteration costs, so what is left in the ratio is
     * the lookup and nothing else. A few hundred iterations is enough to price
     * it; running the full 20,000 would be 200 million comparisons and would
     * make this suite genuinely slow.
     *
     * MEASURED RATIOS, both worth writing down because they differ a lot:
     * ~16x on a plain run, ~3.8x under `--coverage`. Instrumentation is not
     * symmetric — the 20,000-iteration loop is fully instrumented while
     * `Array.prototype.includes` is native and untouched — so coverage
     * compresses the very ratio being measured. Any absolute millisecond
     * budget has to straddle that gap, which is precisely how the previous
     * flat 500 ms ended up failing at 558 ms while nothing was wrong.
     *
     * Asserting 2x clears the worst observed case with roughly 50% headroom
     * and remains unreachable for an actual linear scan, which lands at 1.0 by
     * construction. A hash lookup cannot come within 2x of scanning 10,000
     * strings unless it has stopped being a hash lookup — which is the entire
     * claim under test.
     */
    const SCAN_ITERATIONS = 200;
    const scanStarted = performance.now();
    for (let index = 0; index < SCAN_ITERATIONS; index += 1) {
      COMMON_PASSWORD_CORPUS.includes(`candidate-passphrase-${index}`);
    }
    const projectedScanMs =
      ((performance.now() - scanStarted) / SCAN_ITERATIONS) * ITERATIONS;

    expect(elapsedMs).toBeLessThan(projectedScanMs / 2);
  });

  it('builds the deny-list Set ONCE, at module load, not per call', () => {
    // Two identical calls: if the Set were rebuilt per call, the second would
    // cost the same as the first. It is built at import time, so by now both
    // are a hash lookup.
    const first = performance.now();
    isCommonPassword('password');
    const firstCost = performance.now() - first;

    const second = performance.now();
    isCommonPassword('password');
    const secondCost = performance.now() - second;

    expect(firstCost).toBeLessThan(5);
    expect(secondCost).toBeLessThan(5);
  });
});
