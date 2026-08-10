import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from './identity.types';

/**
 * Argon2id — §6.1, the OWASP 2024 baseline.
 *
 * | Parameter   | Value    | Plan          |
 * |-------------|----------|---------------|
 * | memory      | 19 MiB   | memory 19 MiB |
 * | iterations  | 2        | iterations 2  |
 * | parallelism | 1        | parallelism 1 |
 *
 * `memoryCost` is expressed in KiB by the library, so 19 MiB is 19456. Getting
 * this wrong is silent: 19456 KiB and "19456 bytes" both hash successfully,
 * and the weaker one is indistinguishable from the correct one without reading
 * the encoded parameters out of the resulting string. The test asserts on the
 * `$m=19456,t=2,p=1$` segment of the hash for exactly that reason.
 */
export const ARGON2_MEMORY_COST_KIB = 19 * 1024;
export const ARGON2_TIME_COST = 2;
export const ARGON2_PARALLELISM = 1;

/**
 * `Algorithm.Argon2id`, as a literal.
 *
 * The library declares `Algorithm` as an ambient `const enum`, which
 * `verbatimModuleSyntax` refuses to import — a const enum has no runtime
 * representation to emit. The numeric value is part of the library's public
 * declaration file and is asserted on by the parameter test, which reads the
 * `$argon2id$` prefix out of a real hash. If the library ever renumbered it,
 * that test fails rather than a weaker algorithm being used silently.
 */
export const ARGON2_ID = 2;

const ARGON2_OPTIONS = {
  algorithm: ARGON2_ID,
  memoryCost: ARGON2_MEMORY_COST_KIB,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
} as const;

/**
 * The dummy-verification input (§6.4, step 3).
 *
 * Its value is irrelevant — nobody ever verifies against it successfully. What
 * matters is that the hash it produces uses the SAME parameters as a real one,
 * so the work done on a login for a non-existent account is the work done on a
 * login for a real one.
 */
const DUMMY_PASSWORD = 'foxxy-dummy-verification-input-not-a-credential';

export function createArgon2PasswordHasher(): PasswordHasher {
  /**
   * Computed once, lazily, and memoised as a PROMISE rather than a value.
   *
   * Memoising the promise means concurrent first calls share one computation
   * instead of racing to do it twice. Computing it eagerly at construction
   * would put ~40 ms of work into every process start and every test file.
   */
  let dummy: Promise<string> | null = null;

  return {
    hash(password: string): Promise<string> {
      return hash(password, ARGON2_OPTIONS);
    },

    /**
     * Argon2 verification is constant-time with respect to the password, and
     * the library reads the cost parameters out of the stored hash — so old
     * hashes keep verifying after a parameter change.
     *
     * A malformed or truncated hash makes the library throw. That must read as
     * "does not match", not as a 500: otherwise a corrupt row turns a failed
     * login into a server error, which is itself an oracle.
     */
    async verify(storedHash: string, password: string): Promise<boolean> {
      try {
        return await verify(storedHash, password, ARGON2_OPTIONS);
      } catch {
        return false;
      }
    },

    dummyHash(): Promise<string> {
      dummy ??= hash(DUMMY_PASSWORD, ARGON2_OPTIONS);
      return dummy;
    },
  };
}
