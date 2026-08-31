/**
 * Creates the one kind of account the API refuses to create — a `super_admin`.
 *
 *   npm run admin:create -- --email=ops@alfanumrik.com --name="Ops"
 *
 * =============================================================================
 * WHY THIS IS A SCRIPT AND NOT AN ENDPOINT, AND WHY IT NEVER WILL BE.
 *
 * `SIGNUP_ROLES` is `['student', 'parent']`, pinned by a test, and
 * `users.role`'s CHECK is wide enough to hold `super_admin` only so that adding
 * a role later is an INSERT rather than a locking migration. A signup path that
 * could produce `super_admin` is a privilege-escalation hole with a form in
 * front of it, so the elevated account is created by somebody with a database
 * credential and in no other way. That is the entire security model of the
 * admin panel's front door: to reach it you must already have been trusted with
 * the database.
 *
 * -----------------------------------------------------------------------------
 * IT GENERATES THE PASSWORD RATHER THAN TAKING ONE.
 *
 * Three options were available and two are worse:
 *
 *   a prompt      cannot run non-interactively, which means it cannot run in
 *                 the one place this is most needed — a deploy shell, a
 *                 container exec, a CI job.
 *   a flag / env  lands in shell history, in `ps` output, and in whatever
 *                 collects the CI log.
 *   generated     32 bytes from `randomBytes`, printed ONCE to stdout and never
 *                 stored anywhere but as an Argon2id hash.
 *
 * The operator changes it through the ordinary `/auth/change-password` route,
 * which already requires the current one (D-372). Nothing here is a second
 * credential path — it is the existing one, seeded.
 *
 * -----------------------------------------------------------------------------
 * NO POPULATED-DATABASE GUARD, UNLIKE `db:clear-content` AND `db:round-trip`.
 *
 * Those two destroy data, so refusing to run against a populated database is
 * the right posture. This one INSERTS a single row and is meant to be run
 * against production — a guard would only teach the operator to work around it.
 * Accountability comes from the audit row instead, which is written before the
 * password is printed and which no application role can delete (D-063).
 * =============================================================================
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb } from '../../src/platform/db/index';
import { config } from '../../src/platform/config/index';
import { createPostgresAudit } from '../../src/platform/audit/index';
import { createSystemClock } from '../../src/platform/clock/index';
import { createLogger } from '../../src/platform/logger/index';
import { createArgon2PasswordHasher } from '../../src/modules/identity/identity.password-hasher';

interface Options {
  readonly email: string;
  readonly name: string;
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (const argument of argv) {
    if (!argument.startsWith('--')) continue;
    const [key, value] = argument.slice(2).split('=', 2);
    if (key !== undefined) flags.set(key, value ?? 'true');
  }

  const required = (name: string): string => {
    const value = flags.get(name);
    if (value === undefined || value.length === 0 || value === 'true') {
      throw new Error(`--${name} is required. Usage: npm run admin:create -- --email=<addr> --name=<name>`);
    }
    return value;
  };

  return { email: required('email').trim().toLowerCase(), name: required('name').trim() };
}

/**
 * 32 bytes, base64url. ~43 characters of printable password carrying 256 bits.
 *
 * Not a memorable passphrase on purpose: nobody should be typing this twice.
 * It exists to get the operator as far as `/auth/change-password`.
 */
function generatePassword(): string {
  return randomBytes(32).toString('base64url');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const handle = createDb(config.db);
  const logger = createLogger({ level: config.log.level, env: config.env });
  const audit = createPostgresAudit({ db: handle, clock: createSystemClock(), logger });

  try {
    /**
     * THE EXISTENCE CHECK IS NOT THE UNIQUENESS GUARANTEE.
     *
     * `users_email_unique` is. This check exists to turn the second run of this
     * command into a sentence an operator can act on instead of a raw
     * constraint violation — but two operators running it at the same instant
     * still race here, and the database is what settles it. That is the right
     * order: a check that PRETENDED to be the guarantee would be the thing that
     * eventually let two rows through.
     */
    const existing = await handle.db.execute<{ id: string; role: string }>(
      sql`select id, role from users where email = ${options.email}::citext`,
    );
    const found = existing.rows[0];
    if (found !== undefined) {
      throw new Error(
        `${options.email} already exists with role '${found.role}'. This command creates an ` +
          `account; it does not promote one. Promoting an existing learner account to ` +
          `super_admin is deliberately not offered — an operator account should share nothing ` +
          `with a learner account, least of all its history.`,
      );
    }

    const password = generatePassword();
    const hasher = createArgon2PasswordHasher();
    const passwordHash = await hasher.hash(password);

    const inserted = await handle.db.execute<{ id: string }>(
      sql`insert into users (email, password_hash, role, email_verified_at)
          values (${options.email}::citext, ${passwordHash}, 'super_admin', now())
          returning id`,
    );
    const userId = inserted.rows[0]?.id;
    if (userId === undefined) throw new Error('admin:create: insert returned no row');

    /**
     * AUDITED BEFORE THE PASSWORD IS PRINTED, so the ordering cannot be
     * "created the account, read the secret, and the record failed". `record()`
     * never throws by contract, so this cannot fail the command either — the
     * row is best-effort at the port and the port is the thing that guarantees
     * it, not this call site.
     *
     * `name` IS NOT IN THE METADATA. `audit_log.metadata` is identifiers and
     * counts only; a display name is a name.
     */
    await audit.record({
      actor: { userId: null, role: null },
      action: 'admin.account_created',
      resourceType: 'user',
      resourceId: userId,
      metadata: { role: 'super_admin', via: 'admin:create' },
    });

    process.stdout.write(
      [
        '',
        'super_admin created.',
        '',
        `  id        ${userId}`,
        `  email     ${options.email}`,
        `  password  ${password}`,
        '',
        'THIS PASSWORD IS PRINTED ONCE AND IS NOT RECOVERABLE. Copy it now, sign in,',
        'and change it through /auth/change-password. Nothing stored it but the hash.',
        '',
      ].join('\n'),
    );
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`admin:create failed: ${message}\n`);
  process.exit(1);
});
