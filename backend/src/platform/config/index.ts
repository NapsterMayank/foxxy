/**
 * platform/config — the ONLY place in the codebase that reads process.env.
 * Enforced by the `no-restricted-properties` / `no-restricted-imports` rules
 * in eslint.config.js.
 *
 * Public surface:
 *  - `config`        the frozen, validated, typed configuration object
 *  - `parseConfig`   pure parser, for tests and for tooling
 *  - `Config`        the type
 */
import { parseConfig } from './load-config';
import type { Config } from './config.schema';

export type { Config } from './config.schema';
export { parseConfig, formatEnvErrors } from './load-config';
export { envSchema, toConfig } from './config.schema';
export {
  DEFAULT_BREAKER_POLICY,
  DEFAULT_CONCURRENCY_LIMITS,
  DEFAULT_TIMEOUT_POLICY,
  breakerPolicySchema,
  concurrencyLimitsSchema,
  parseBreakerPolicy,
  parseConcurrencyLimits,
  parseTimeoutPolicy,
  timeoutPolicySchema,
  timeoutRuleSchema,
} from './timeouts';
export type { BreakerPolicy, ConcurrencyLimits, TimeoutPolicy, TimeoutRule } from './timeouts';

/**
 * Reads and validates the process environment exactly once.
 * On failure it writes a human-readable message to stderr and exits 1 —
 * the server must refuse to boot rather than fail later on a rare path.
 */
function loadOrExit(): Config {
  try {
    return parseConfig(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n${message}\n\n`);
    process.exit(1);
  }
}

export const config: Config = loadOrExit();
