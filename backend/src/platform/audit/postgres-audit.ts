import type { Clock } from '../clock/index';
import type { DbHandle } from '../db/index';
import { schema } from '../db/index';
import type { Logger } from '../logger/index';
import { PLATFORM_METRICS, createNoopMetrics, type MetricsPort } from '../metrics/index';
import { scrubRecord } from '../pii/index';
import type { AuditEntry, AuditPort } from './audit.port';

/**
 * The durable audit adapter: one INSERT into `audit_log` per entry.
 *
 * ===========================================================================
 * UNBUFFERED, UNLIKE `platform/metrics`. The asymmetry is deliberate.
 *
 * Metric observations are buffered because they are high-volume, individually
 * worthless, and a burst of them arrives exactly when the system is under
 * stress. Audit entries are the opposite on all three counts: rare, individually
 * the whole point, and produced by a user action that is already doing several
 * database round trips.
 *
 * A buffer would also introduce a window in which an audit entry exists in
 * memory and nowhere else — so a crash between the action and the flush loses
 * the record of an action that DID happen. For metrics that is a gap in a
 * graph; for an audit log it is the failure mode the table exists to prevent.
 *
 * ===========================================================================
 * IT WRITES ON ITS OWN HANDLE, AND THE CALLER CHOOSES WHICH.
 *
 * `container` gives it the `auth` pool, because every audit event that exists
 * today is an identity action and §3.1 assigns identity to `auth`. That keeps
 * the audit write in the same bulkhead as the operation it records — if the
 * `auth` pool is exhausted, the action was not going to happen anyway, so the
 * audit write failing with it costs nothing that was not already lost.
 *
 * Putting it on `worker` was considered and rejected: an audit row written from
 * a different pool than the action it describes can outlive a rolled-back
 * action, which is a worse kind of wrong than a missing row.
 *
 * ===========================================================================
 * IT DOES NOT ENLIST IN THE CALLER'S TRANSACTION. Deliberately.
 *
 * Making the audit write part of the operation's transaction would give exact
 * consistency — no audit row for a rolled-back action, no action without an
 * audit row. It would also mean an audit failure ROLLS BACK THE OPERATION,
 * which is precisely the property the port's header rules out.
 *
 * The chosen trade: audit-after-success, outside the transaction. A crash in
 * the microseconds between can lose a row. That is a small, bounded,
 * OBSERVABLE loss, against an unbounded availability risk.
 */

const { auditLog } = schema;

export interface PostgresAuditOptions {
  readonly db: DbHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics?: MetricsPort;
}

export function createPostgresAudit(options: PostgresAuditOptions): AuditPort {
  const { db, clock, logger } = options;
  const metrics = options.metrics ?? createNoopMetrics();

  return {
    async record(entry: AuditEntry): Promise<void> {
      // SCRUBBED BEFORE ANYTHING ELSE, so there is no code path between here
      // and the INSERT on which the raw payload could be logged, reported or
      // retained. `platform/pii` drops PII-shaped KEYS and redacts PII-shaped
      // VALUES.
      const scrubbed = scrubRecord(entry.metadata ?? {});

      if (scrubbed.changed) {
        // WARN, EVERY TIME. A module putting personal data into an audit
        // payload is a defect that needs fixing where it originates — the
        // scrub kept it out of the permanent record, it did not fix the bug.
        //
        // The KEYS are logged and the values never are, which is the same rule
        // the rate limiter follows with its counter keys.
        logger.warn(
          {
            event: 'audit.pii_scrubbed',
            action: entry.action,
            keys: scrubbed.affectedKeys,
          },
          'PII-shaped data was scrubbed from an audit payload; fix the caller',
        );
        metrics.counter(PLATFORM_METRICS.PII_SCRUBBED, 1, { sink: 'audit' });
      }

      try {
        await db.db.insert(auditLog).values({
          actorUserId: entry.actor.userId,
          actorRole: entry.actor.role,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          tenantId: entry.actor.tenantId ?? null,
          metadata: scrubbed.value,
          // From the INJECTED clock, not `defaultNow()`. Every other timestamp
          // in this codebase that is compared against anything comes from the
          // clock (D-019), and an audit timeline that mixes two clocks is a
          // timeline that reorders itself under skew.
          createdAt: clock.now(),
        });
      } catch (error) {
        // NEVER RETHROWN. See the port header: the caller is a password reset
        // or a link revocation in progress, and failing it because its receipt
        // could not be filed is the wrong trade in every case.
        //
        // `error` rather than `warn`: a missing audit row is unrecoverable and
        // invisible to the user, so the operator side has to be loud.
        logger.error(
          {
            event: 'audit.write_failed',
            action: entry.action,
            resourceType: entry.resourceType,
            err: error instanceof Error ? error.message : 'unknown audit write failure',
          },
          'AUDIT ENTRY LOST: the action completed but could not be recorded',
        );
        metrics.counter('platform.audit.write_failed', 1, { action: entry.action });
      }
    },
  };
}
