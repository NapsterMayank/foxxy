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
import {
  createConsoleMail,
  createGuardedMail,
  createNodemailerTransport,
  createSmtpMail,
  type MailPort,
} from '../../src/platform/mail/index';
import { createResilienceRegistry } from '../../src/platform/resilience/index';
import {
  createEmailChannel,
  createInAppChannel,
  createNotificationDispatcher,
  createPushChannel,
  createWhatsAppChannel,
} from '../../src/platform/notify-channel/index';
import { ALERT_RULES, assertRulesAreSatisfiable } from '../../src/platform/alerts/index';
import { ALERT_CHANNEL_POLICY, createAlertEvaluator } from '../../src/platform/alerts/index';
import { collectSignals, createFsBackupAgeSource, producibleSignals } from '../../src/platform/alerts/index';

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
    // DEFAULTS TO THE REAL PAGER, NOT TO STDOUT (D-251). See createAlertMail.
    mailTransport: flags.get('mail') ?? 'smtp',
  };
}

/**
 * THE MAIL TRANSPORT FOR `page` ALERTS — D-251.
 *
 * =============================================================================
 * WHAT WAS BROKEN.
 *
 * `--mail` defaulted to `console`, and `resend` — the only other value — threw,
 * because no Resend adapter was ever written. So there was exactly one reachable
 * transport, and it was stdout. Every page-severity alert this evaluator has
 * ever raised was written to a container log and read by nobody. The stack had a
 * rule set, a dispatcher, a recipient, a 60-second loop and a dashboard's worth
 * of correct behaviour, and it could not wake anyone up.
 *
 * That is worse than having no monitoring, because it is BELIEVED. "No page came
 * in" was being read as "nothing was wrong", and the two were indistinguishable.
 *
 * =============================================================================
 * `smtp` IS NOW THE DEFAULT, NOT `console`, AND THAT INVERSION IS THE FIX.
 *
 * The old default made the quiet outcome the automatic one: an operator who
 * passed no flag got a silent pager and no indication of it. The loud outcome is
 * automatic now — with no SMTP configured this THROWS and the alerts container
 * fails to start, so its absence from `docker compose ps` is itself the signal.
 * A monitoring component that refuses to run is legible; one that runs and
 * delivers nowhere is not.
 *
 * `console` remains selectable and is a genuinely real delivery path for a
 * single operator watching `docker compose logs` — it is simply not a pager, and
 * choosing it now requires typing it, which puts the choice in `.env.prod` where
 * a reviewer sees it. It still warns on every start.
 *
 * `resend` is REMOVED rather than left throwing-with-a-TODO: the owner's mail
 * provider is Google Workspace, so there is no Resend adapter coming. Naming it
 * in the error keeps an existing `ALERT_MAIL_TRANSPORT=resend` from failing with
 * "unknown transport" and instead points at the value that replaced it.
 *
 * =============================================================================
 * IT USES THE SAME ADAPTER THE APPLICATION USES.
 *
 * `createSmtpMail` over `createNodemailerTransport`, from `platform/mail` — not
 * a second SMTP client written for ops. A monitoring path built out of different
 * parts than the product's can succeed while the product's fails, and the one
 * message that would have told you is the one that goes through the ops path.
 *
 * =============================================================================
 * AND IT USES THE SAME GUARD — a wedged SMTP server used to stall EVERY RULE.
 *
 * The application reaches mail through `createGuardedMail`: bulkhead, breaker,
 * 10s timeout (§3.3, §4, §5). This path built `createSmtpMail` RAW, and
 * `createNodemailerTransport` sets no `connectionTimeout`, `greetingTimeout` or
 * `socketTimeout`, so a TCP connection that opens and then says nothing has no
 * deadline anywhere in the stack.
 *
 * Follow that through the loop. `deliver()` is awaited inside `runCycle`, which
 * is awaited by `runOnce`, which is awaited by the `while` loop. So ONE hung
 * socket on ONE page-severity alert suspends the entire evaluator — readiness,
 * pool saturation, backups, worker heartbeat, every rule — for as long as the
 * peer holds the connection open. The monitoring system's own dependency taking
 * the monitoring system down is the exact inversion §5 exists to prevent, and it
 * fails in the silent direction: the process is alive, the container is healthy,
 * and no alert has been produced for an hour.
 *
 * The guard bounds it at the `mail` rule's 10s and then, after five of those,
 * opens the breaker and fails instantly — so a dead mail provider costs one
 * cycle of latency rather than all of them. `createGuardedMail` deliberately
 * does NOT declare mail idempotent (D-237), so this adds a deadline without
 * adding a duplicate page.
 *
 * The `connectionTimeout`/`greetingTimeout`/`socketTimeout` settings still belong
 * in `createNodemailerTransport` — a socket-level deadline is strictly better
 * than an outer race, because the outer race leaves the wedged socket open. That
 * file is not owned by this change and is reported instead.
 */
function createAlertMail(transport: string, logger: ReturnType<typeof createLogger>): MailPort {
  if (transport === 'console') {
    logger.warn(
      { event: 'alerts.mail_transport_console' },
      'ALERT EMAIL IS GOING TO STDOUT. Page-severity alerts will not reach a phone. ' +
        'This is a deliberate, explicit choice — pass --mail=smtp for the real pager path.',
    );
    return createConsoleMail();
  }

  if (transport === 'smtp') {
    const { smtpHost, smtpPort, smtpUser, smtpPassword, smtpFrom } = config.mail;
    // NAMES THE MISSING VARIABLES, ALL OF THEM, rather than failing on the first.
    // An operator bringing up alerting should not learn about four variables
    // across four restarts.
    const missing = [
      smtpHost === null ? 'SMTP_HOST' : null,
      smtpUser === null ? 'SMTP_USER' : null,
      smtpPassword === null ? 'SMTP_PASSWORD' : null,
      smtpFrom === null ? 'SMTP_FROM' : null,
    ].filter((name): name is string => name !== null);

    if (smtpHost === null || smtpUser === null || smtpPassword === null || smtpFrom === null) {
      throw new Error(
        `--mail=smtp was selected but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} ` +
          'not set. REFUSING TO FALL BACK TO STDOUT: a deployment that asked for a pager and ' +
          'silently received a log line would believe it had one, and "no page came in" would ' +
          'read as "nothing was wrong". Set the SMTP_* block in docker/.env.prod, or choose ' +
          '--mail=console deliberately and know that alerts go to the container log.',
      );
    }

    logger.info(
      { event: 'alerts.mail_transport_smtp', host: smtpHost, port: smtpPort },
      'page-severity alerts will be delivered over SMTP',
    );
    const raw = createSmtpMail({
      transport: createNodemailerTransport({
        host: smtpHost,
        port: smtpPort,
        user: smtpUser,
        password: smtpPassword,
        from: smtpFrom,
      }),
      from: smtpFrom,
    });

    // ITS OWN registry, not the application's — this is a separate process. One
    // guard, for `mail`, built from the same §4 policy the API uses so the
    // deadline an operator reads in the timeout table is the deadline the pager
    // actually gets.
    const resilience = createResilienceRegistry({
      clock: createSystemClock(),
      logger,
      timeouts: config.timeouts,
      concurrency: config.concurrency,
      breaker: config.breaker,
    });

    return createGuardedMail(raw, resilience.guard('mail'));
  }

  if (transport === 'resend') {
    throw new Error(
      '--mail=resend no longer exists. The mail provider is Google Workspace and the transport ' +
        'is SMTP (platform/mail/smtp-mail.ts). Use --mail=smtp and set the SMTP_* variables.',
    );
  }

  throw new Error(`--mail: unknown transport '${transport}'. Known: smtp, console.`);
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
  // NO `--backup-dir` WARNING HERE, and its absence is deliberate.
  //
  // There used to be one, and it was dead code that read as a safeguard:
  // `assertRulesAreSatisfiable` above has ALREADY THROWN by this line, because
  // `producibleSignals()` omits `backup.age_hours` when no directory is
  // configured and the `backup_stale` rule watches exactly that signal. So the
  // condition is unreachable, and a reader who found the warning would conclude
  // that running without a backup directory is a degraded-but-permitted mode.
  // It is not — the evaluator refuses to start, which is the correct posture for
  // "there has never been a backup" being reported identically to "backups are
  // fine". compose.prod.yml mounts backup_data read-only and passes
  // --backup-dir=/backup (D-251).

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
