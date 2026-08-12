import { envSchema, toConfig, type Config } from './config.schema';

/**
 * Turns a Zod failure into a message a human can act on at 2am, then stops
 * the process. Fail at boot, never on the one code path that reads the value.
 */
export function formatEnvErrors(issues: readonly { path: string; message: string }[]): string {
  const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
  return [
    'Invalid environment configuration. The server cannot start.',
    '',
    ...lines,
    '',
    'Copy .env.example to .env and fill in every REQUIRED variable.',
  ].join('\n');
}

/**
 * Parses a raw environment record. Pure — takes the source as an argument so
 * it can be tested without touching the real process environment.
 *
 * @throws Error with a formatted, multi-line message when validation fails.
 */
export function parseConfig(source: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    throw new Error(formatEnvErrors(issues));
  }

  return toConfig(result.data);
}
