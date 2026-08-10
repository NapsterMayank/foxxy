/**
 * ENTRY POINT for the alert evaluator. 04-RESILIENCE-PLAN.md §5.
 *
 *   npm run ops:alerts -- --once --on-call-user-id=<uuid> --on-call-email=<addr>
 *   node dist-ops/scripts/ops/alert-evaluator-main.js --loop --interval-seconds=60 ...
 *
 * =============================================================================
 * IT REFUSES TO START WITHOUT A RECIPIENT. This is the D-123 pattern, applied
 * to alerting.
 *
 * D-123 made the embedding adapter a BOOT FAILURE in production without a key
 * rather than a warning, because "the degraded mode has no symptom". Alerting
 * is the extreme case of that: an evaluator with no on-call recipient runs
 * perfectly, evaluates every rule correctly, delivers to nobody, and looks
 * exactly like a system that is never unhealthy. There is no observable
 * difference between "nothing is wrong" and "the alerter is misconfigured",
 * which is the worst property any piece of software can have.
 *
 * So: no recipient, no start.
 *
 * Configuration arrives as ARGUMENTS, not environment variables, because
 * `process.env` is read in exactly one place in this codebase
 * (`platform/config`) and that is enforced by lint. Adding operational
 * variables to the application's config schema would make the API refuse to
 * boot when an alerting variable is missing — coupling the product's
 * availability to its monitoring, which is backwards.
 */

import { readdir, stat } from 'node:fs/promises';
import { createSystemClock } from '../../src/platform/clock/index';
import { config } from '../../src/platform/config/index';
import { createDb } from '../../src/platform/db/index';
import { createLogger } from '../../src/platform/logger/index';
import { createConsoleMail, type MailPort } from '../../src/platform/mail/index';
import {
  createEmailChannel,
  createInAppChannel,
  createNotificationDispatcher,
  createPushChannel,
  createWhatsAppChannel,
} from '../../src/platform/notify-channel/index';
import { ALERT_RULES, assertRulesAreSatisfiable } from './alert-rules';
import { ALERT_CHANNEL_POLICY, createAlertEvaluator } from './alert-evaluator';
import { collectSignals, createFsBackupAgeSource, producibleSignals } from './alert-sources';

interface Options {
  readonly loop: boolean;
  readonly intervalSeconds: number;
  readonly windowMinutes: number;
  readonly onCallUserId: string;
  readonly onCallEmail: string;
  readonly readinessUrl: string;
  readonly backupDir: string | undefined;
  readonly mailTransport: string;
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
      throw new Error(
        `--${name} is required. The evaluator refuses to run without a recipient: an ` +
          `alerter that delivers nowhere is indistinguishable from a healthy system.`,
      );
    }
    return value;
  };

  const number = (name: string, fallback: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--${name} must be a positive number, received '${raw}'`);
    }
    return parsed;
  };

  const intervalSeconds = number('interval-seconds', 60);
  // The counting rules sum over a window. A window SHORTER than the interval
  // leaves gaps in which an event is never seen by any cycle — a breaker that
  // opens in the blind spot is never reported. 3x is the usual overlap.
  const windowMinutes = number('window-minutes', Math.max(5, Math.ceil((intervalSeconds * 3) / 60)));

  return {
    loop: flags.get('loop') === 'true',
    intervalSeconds,
    windowMinutes,
    onCallUserId: required('on-call-user-id'),
    onCallEmail: required('on-call-email'),
    readinessUrl: flags.get('readiness-url') ?? 'http://backend-api:4000/health/ready',
    backupDir: flags.get('backup-dir'),
    mailTransport: flags.get('mail') ?? 'console',
  };
}

/**
 * The mail transport for `page` alerts.
 *
 * `console` writes to stdout, where the container log driver keeps it. It is a
 * real, working delivery path for a single-operator deployment reading
 * `docker compose logs` — but it is NOT a pager, and pretending otherwise is
 * the failure this whole file is about. So it warns, loudly, every start.
 *
 * `resend` is the real path and lands with the `notify` module's Resend adapter
 * (build step 14). Selecting it before that adapter exists THROWS, rather than
 * silently falling back to console — a deployment that asked for a pager and
 * got stdout would believe it had one.
 */
function createAlertMail(transport: string, logger: ReturnType<typeof createLogger>): MailPort {
  if (transport === 'console') {
    logger.warn(
      { event: 'alerts.mail_transport_console' },
      'ALERT EMAIL IS GOING TO STDOUT. Page-severity alerts will not reach a phone. ' +
        'Set --mail=resend once the Resend adapter exists (build step 14).',
    );
    return createConsoleMail();
  }
  if (transport === 'resend') {
    throw new Error(
      "--mail=resend was requested but no Resend adapter exists yet (build step 14). " +
        'Refusing to fall back to stdout silently: a deployment that asked for a pager and ' +
        'received a log line would believe it had one.',
    );
  }
  throw new Error(`--mail: unknown transport '${transport}'. Known: console, resend.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const logger = createLogger({ level: config.log.level, env: config.env });
  const clock = createSystemClock();

  // §3.1: metric reads are background bookkeeping and must never compete with a
  // request. The evaluator is a separate process with its own single pool, so
  // it cannot take a connection from `auth` or `core` however slow it gets.
  const handle = createDb({ url: config.db.url, ssl: config.db.ssl, poolMax: 2 });

  // THE ORPHAN-RULE CHECK, at start-up rather than lazily. A rule watching a
  // signal nothing produces can never fire, and a rule that never fires looks
  // exactly like a system that is never unhealthy.
  const producible = producibleSignals({ backupDir: options.backupDir });
  assertRulesAreSatisfiable(ALERT_RULES, producible);

  const unmeasured = ALERT_RULES.filter((rule) => !producible.includes(rule.signal));
  if (unmeasured.length > 0) {
    logger.warn(
      { event: 'alerts.unmeasured_rules', rules: unmeasured.map((rule) => rule.id) },
      'some rules have no signal source configured and will never fire',
    );
  }
  if (options.backupDir === undefined) {
    logger.warn(
      { event: 'alerts.backup_not_watched' },
      'no --backup-dir: the "no recent database backup" rule is NOT active. ' +
        'Mount the backup volume read-only and pass --backup-dir=/backup.',
    );
  }

  const mail = createAlertMail(options.mailTransport, logger);
  const dispatcher = createNotificationDispatcher({
    channels: {
      email: createEmailChannel({ mail }),
      'in-app': createInAppChannel({ db: handle, clock }),
      // Declared and throwing (D-066/D-067). Present so that enabling one in the
      // policy before it exists is loud rather than silent.
      whatsapp: createWhatsAppChannel(),
      push: createPushChannel(),
    },
    policy: ALERT_CHANNEL_POLICY,
    logger,
  });

  const evaluator = createAlertEvaluator({
    dispatcher,
    recipient: {
      userId: options.onCallUserId,
      email: options.onCallEmail,
      tenantId: null,
      language: 'en',
    },
    logger,
    clock,
  });

  const backupAgeSource = createFsBackupAgeSource(readdir, stat);

  const runOnce = async (): Promise<void> => {
    const collected = await collectSignals(
      {
        db: handle,
        logger,
        windowMinutes: options.windowMinutes,
        readinessUrl: options.readinessUrl,
        backupDir: options.backupDir,
        now: clock.now(),
      },
      backupAgeSource,
    );
    const result = await evaluator.runCycle(collected.signals);
    logger.info(
      {
        event: 'alerts.cycle',
        ...result,
        signals: collected.signals,
        collectorFailures: collected.failures.length,
      },
      'alert cycle complete',
    );
  };

  if (!options.loop) {
    try {
      await runOnce();
    } finally {
      await handle.close();
    }
    return;
  }

  logger.info(
    {
      event: 'alerts.started',
      intervalSeconds: options.intervalSeconds,
      windowMinutes: options.windowMinutes,
      rules: ALERT_RULES.length,
    },
    'alert evaluator started',
  );

  // An AbortController rather than a `let running = true`, for a reason the
  // compiler enforces: TypeScript narrows a `let` assigned only inside a
  // callback to its initial literal type, so `while (running)` reads as
  // `while (true)` and the exit condition is statically dead. `signal.aborted`
  // is a plain boolean and cannot be narrowed away.
  const stopping = new AbortController();
  const stop = (): void => {
    stopping.abort();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (!stopping.signal.aborted) {
    try {
      await runOnce();
    } catch (error) {
      // NEVER EXITS ON A CYCLE FAILURE. An evaluator that dies when the database
      // is unreachable is an evaluator that goes silent during the outage it
      // exists to report — and `restart: unless-stopped` would then hot-loop it
      // against the failing database.
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ event: 'alerts.cycle_failed', err: message }, 'alert cycle failed; continuing');
    }
    // The wait is INTERRUPTIBLE. A plain `setTimeout` for the full interval
    // means SIGTERM is honoured up to a minute later, which exceeds the
    // container's 15s stop_grace_period and turns every deploy into a SIGKILL.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.intervalSeconds * 1_000);
      stopping.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  logger.info({ event: 'alerts.stopped' }, 'alert evaluator stopped');
  await handle.close();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`alert evaluator failed to start: ${message}\n`);
  process.exit(1);
});
