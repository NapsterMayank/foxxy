import type { JobHandler, JobRecord } from '@/platform/jobs/index';
import type { Logger } from '@/platform/logger/index';
import {
  NOTIFY_DELIVER_JOB,
  NOTIFY_DIGEST_DELIVER_JOB,
  NOTIFY_DIGEST_SCAN_JOB,
  type NotifyModule,
} from '@/modules/notify/index';

/**
 * The notify handlers the worker registers.
 *
 * ===========================================================================
 * THIN, ON PURPOSE. Every one of these is three lines around a service call.
 *
 * The work lives in `notify.service.ts`, where it can be tested against a real
 * database with no queue at all — the same shape as the expired-session
 * sweeper, whose real work (`sweepExpiredSessions`) is exported separately from
 * its handler for exactly that reason. A handler that contained logic would be
 * logic reachable only by enqueuing a job.
 *
 * ===========================================================================
 * THE DIGEST HANDLERS ARE REGISTERED ONLY WHEN `parent` HAS WIRED ITS SEAM.
 *
 * PROGRESS.md §7 records the weekly digest as "deliberately NOT stubbed — a
 * registered handler that does nothing lets a job succeed without doing the
 * work, which is worse than the 'no handler' error the runner raises". That
 * reasoning is honoured rather than quietly reversed: `buildNotifyHandlers`
 * returns the delivery handler always, and the two digest handlers only when
 * `module.hasDigestSource` is true.
 *
 * So today the scheduling skeleton exists, is tested end to end against a fake
 * source, and is INERT in production — a digest job that somehow appeared would
 * be refused loudly by the runner rather than succeeding empty.
 */

/**
 * Remote delivery — email today, WhatsApp in Phase 2.
 *
 * A THROW HERE MEANS "RETRY". The service throws when no channel delivered, so
 * the queue applies its jittered backoff and, after `maxAttempts`, marks the
 * job `dead` and keeps the row. The service has already written the
 * dead-letter marker and emitted `notify.delivery.dead_letter` by then, because
 * once the job is dead this handler is never called again and there is no later
 * moment at which to say so.
 */
export function createDeliverNotificationHandler(notify: NotifyModule): JobHandler {
  return async (job: JobRecord): Promise<void> => {
    await notify.service.deliver(job);
  };
}

/** The weekly scan. Enqueues; does not build content. */
export function createDigestScanHandler(notify: NotifyModule): JobHandler {
  return async (): Promise<void> => {
    await notify.service.scanWeeklyDigests();
  };
}

/**
 * One parent's digest.
 *
 * The payload is validated here rather than in the service, because a payload
 * is a wire format between two releases and this is its boundary. An unusable
 * payload cannot be fixed by retrying, so it is logged and RETURNED — the rule
 * `platform/jobs` states: "a handler that knows its input is unprocessable
 * should record that fact and RETURN, because the job did its work, and the
 * work was to determine that."
 */
export function createDigestDeliverHandler(notify: NotifyModule, logger: Logger): JobHandler {
  return async (job: JobRecord): Promise<void> => {
    const parentUserId = job.payload.parentUserId;
    const weekStart = job.payload.weekStart;

    if (typeof parentUserId !== 'string' || typeof weekStart !== 'string') {
      logger.error(
        { event: 'notify.digest_bad_payload', jobId: job.id },
        'a digest job carried an unusable payload and will not be retried',
      );
      return;
    }

    const week = new Date(weekStart);
    if (Number.isNaN(week.getTime())) {
      logger.error(
        { event: 'notify.digest_bad_week', jobId: job.id },
        'a digest job carried an unparseable week start and will not be retried',
      );
      return;
    }

    await notify.service.deliverWeeklyDigest(parentUserId, week);
  };
}

/** Every notify handler the worker should register, given what is wired. */
export function buildNotifyHandlers(
  notify: NotifyModule,
  logger: Logger,
): Readonly<Record<string, JobHandler>> {
  const handlers: Record<string, JobHandler> = {
    [NOTIFY_DELIVER_JOB]: createDeliverNotificationHandler(notify),
  };

  if (notify.hasDigestSource) {
    handlers[NOTIFY_DIGEST_SCAN_JOB] = createDigestScanHandler(notify);
    handlers[NOTIFY_DIGEST_DELIVER_JOB] = createDigestDeliverHandler(notify, logger);
  }

  return handlers;
}
