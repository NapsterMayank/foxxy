/**
 * Takes the `super_admin` role away from an account and kills its sessions.
 *
 *   npm run ops:admin-revoke -- --email=ops@alfanumrik.com
 *
 * =============================================================================
 * WHY THIS EXISTS: `admin:create` HAD NO OPPOSITE.
 *
 * An operations panel that can be granted and not withdrawn is one where the
 * only way to remove an operator is a hand-written UPDATE at 3am by whoever
 * still has the database credential — which is exactly the moment to be running
 * a reviewed script rather than composing SQL. Somebody leaves, a laptop is
 * lost, an account is compromised: all three need this to be one command.
 *
 * -----------------------------------------------------------------------------
 * IT DEMOTES RATHER THAN DELETES, and the distinction is deliberate.
 *
 * Deleting the row would cascade through `sessions` and take the account's
 * history with it, and `audit_log.actor_user_id` is deliberately NOT a foreign
 * key precisely so a removed operator's trail survives them. Demotion keeps
 * every row that says what this account did, and removes what it can do next.
 *
 * The role becomes `support_agent`: a declared platform role with no capability
 * wired to it today, so the account can still sign in and can reach nothing.
 * Reducing it to `student` would be worse — it would put an operator account
 * into the population every learner query walks.
 *
 * -----------------------------------------------------------------------------
 * SESSIONS GO IN THE SAME TRANSACTION AS THE ROLE.
 *
 * The gate reads the role from the database on every request, so a demotion
 * alone would already close the door. Deleting the sessions closes it for
 * everything else too — the account's ordinary learner-facing session is just
 * as revoked — and it means a stolen cookie is dead the instant this runs
 * rather than at the end of its window.
 * =============================================================================
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../../src/platform/db/index';
import { config } from '../../src/platform/config/index';
import { createPostgresAudit } from '../../src/platform/audit/index';
import { createSystemClock } from '../../src/platform/clock/index';
import { createLogger } from '../../src/platform/logger/index';

/** A declared role with nothing wired to it. See the header. */
const DEMOTED_TO = 'support_agent';

function parseArgs(argv: readonly string[]): { email: string } {
  const flags = new Map<string, string>();
  for (const argument of argv) {
    if (!argument.startsWith('--')) continue;
    const [key, value] = argument.slice(2).split('=', 2);
    if (key !== undefined) flags.set(key, value ?? 'true');
  }
  const email = flags.get('email');
  if (email === undefined || email.length === 0 || email === 'true') {
    throw new Error('--email is required. Usage: npm run ops:admin-revoke -- --email=<addr>');
  }
  return { email: email.trim().toLowerCase() };
}

async function main(): Promise<void> {
  const { email } = parseArgs(process.argv.slice(2));
  const handle = createDb(config.db);
  const logger = createLogger({ level: config.log.level, env: config.env });
  const audit = createPostgresAudit({ db: handle, clock: createSystemClock(), logger });

  try {
    const found = await handle.db.execute<{ id: string; role: string }>(
      sql`select id, role from users where email = ${email}::citext`,
    );
    const user = found.rows[0];
    if (user === undefined) throw new Error(`${email} does not exist.`);
    if (user.role !== 'super_admin') {
      throw new Error(
        `${email} has role '${user.role}', not 'super_admin'. This command withdraws operator ` +
          `access; it is not a general role editor, and a script that could set any role to any ` +
          `other is a privilege-escalation tool with a friendly name.`,
      );
    }

    /**
     * ONE TRANSACTION. A demotion that committed without the session delete
     * would leave a live cookie belonging to an account somebody has just
     * decided should not have one — briefly, and exactly when it matters.
     */
    const removed = await handle.withTransaction(async (tx) => {
      await tx.execute(sql`update users set role = ${DEMOTED_TO} where id = ${user.id}::uuid`);
      const deleted = await tx.execute<{ id: string }>(
        sql`delete from sessions where user_id = ${user.id}::uuid returning id`,
      );
      return deleted.rows.length;
    });

    await audit.record({
      actor: { userId: null, role: null },
      action: 'admin.access_revoked',
      resourceType: 'user',
      resourceId: user.id,
      // Identifiers and counts. The address is the argument, not the record.
      metadata: { from: 'super_admin', to: DEMOTED_TO, sessionsRevoked: removed, via: 'admin:revoke' },
    });

    process.stdout.write(
      `\nOperator access withdrawn.\n\n  id       ${user.id}\n  role     super_admin -> ${DEMOTED_TO}\n` +
        `  sessions ${String(removed)} revoked\n\nThe account can still sign in and can reach nothing.\n\n`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`admin:revoke failed: ${message}\n`);
  process.exit(1);
});
