/**
 * THE PRE-FLIGHT. Runs as a one-shot container before api, worker and alerts.
 *
 *     node dist-ops/scripts/ops/preflight-env.js --razorpay-plan-ids="$RAZORPAY_PLAN_IDS"
 *     npm run ops:preflight                                    # locally, with tsx
 *
 * =============================================================================
 * WHAT IT IS FOR: TURNING A RESTART LOOP BACK INTO AN ERROR MESSAGE.
 *
 * `src/app/container.ts` refuses to construct in production without the Voyage
 * key, the LLM key or the three Razorpay credentials — each guards a fake
 * adapter that is interchangeable to the type system and silently wrong at
 * runtime, so a boot failure is the right posture and it stays.
 *
 * The problem was never the refusal. It was what the refusal LOOKS LIKE. An
 * exception thrown inside `createContainer` exits the process, `restart:
 * unless-stopped` starts it again, and the operator sees two containers cycling
 * every few seconds — which reads as a crash, or as postgres not being ready,
 * or as a bad image. The one line naming the variable scrolls past inside a
 * restart storm, in a log stream the restarts themselves are truncating.
 *
 * So: a container that runs FIRST, exits non-zero, and is depended on with
 * `service_completed_successfully`. Nothing else starts, nothing loops, and the
 * last thing in the log is a legible list.
 *
 * =============================================================================
 * IT REPORTS EVERY PROBLEM, NOT THE FIRST ONE.
 *
 * container.ts's own check is a chain of ternaries naming ONE missing
 * credential — right for a boot guard, wrong for a pre-flight. An operator
 * bringing up a new deployment would otherwise fix a variable, redeploy, and
 * learn the next name: five deploys to discover five variables. Everything
 * below accumulates into one list.
 *
 * =============================================================================
 * IT READS NO ENVIRONMENT VARIABLES. Two consequences, both deliberate.
 *
 * `process.env` is read in exactly ONE place in this codebase, and that is
 * enforced by lint (D-182, D-183). This script therefore learns the environment
 * the same way the API does — by importing the frozen `config` object, whose
 * module-level read prints every schema violation at once and exits 1. That is
 * not a workaround for the lint rule; it is what makes the pre-flight unable to
 * disagree with the process it is standing in for. A pre-flight that validates
 * with its OWN copy of the rules can pass a configuration the application then
 * rejects — which converts "the app refuses to boot" into "the app refuses to
 * boot AND the check that exists to prevent that said fine".
 *
 * The one value it cannot get that way is the RAW `RAZORPAY_PLAN_IDS` string:
 * `config` exposes only the parsed map, and the parse is exactly what silently
 * discards malformed pairs (D-253). So the raw string arrives as an ARGUMENT,
 * which is the same mechanism, and the same reasoning, as the alert evaluator's
 * `--on-call-email`. compose.prod.yml interpolates it from the same variable it
 * puts in the environment, so the two cannot disagree. It is a plan
 * IDENTIFIER, not a credential, so a command line is an acceptable place for it.
 *
 * =============================================================================
 * NO I/O. It does not connect to postgres, valkey, Razorpay or Anthropic, and
 * declares no `depends_on`. It cannot be the reason a recovery is slow, cannot
 * hold a connection during an incident, and cannot fail for a reason that has
 * nothing to do with configuration.
 */

import { config } from '../../src/platform/config/index';
import { purchasablePlans } from '../../src/modules/billing/index';
import { PRODUCTION_REQUIRED } from './env-contract';

/** One human-readable reason the stack must not start. */
interface Problem {
  readonly variable: string;
  readonly detail: string;
}

/**
 * The credential values, read from the typed config rather than the environment.
 *
 * `null` here is exactly what container.ts tests for, so this list and the boot
 * refusal cannot drift on the CHECK even if they were ever to drift on the LIST
 * — and `env-contract-check.ts` closes the list in CI.
 */
function credentialValues(): Readonly<Record<string, string | null>> {
  return {
    VOYAGE_API_KEY: config.ai.voyageApiKey,
    LLM_API_KEY: config.ai.llmApiKey,
    RAZORPAY_KEY_ID: config.payments.razorpayKeyId,
    RAZORPAY_KEY_SECRET: config.payments.razorpayKeySecret,
    RAZORPAY_WEBHOOK_SECRET: config.payments.razorpayWebhookSecret,
    // D-254. Read from `config.mail`, so a blank or whitespace-only value has
    // already failed `z.string().min(1)` and never reaches this list as a
    // present-but-useless string.
    SMTP_HOST: config.mail.smtpHost,
    SMTP_USER: config.mail.smtpUser,
    SMTP_PASSWORD: config.mail.smtpPassword,
    SMTP_FROM: config.mail.smtpFrom,
    // Present as a fact rather than a value: the parsed map is empty exactly
    // when the variable was unset or wholly malformed.
    RAZORPAY_PLAN_IDS:
      Object.keys(config.payments.razorpayPlanIds).length > 0 ? 'set' : null,
  };
}

/** `--flag=value` -> value. Absent, empty, or bare `--flag` all read as absent. */
function argValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const argument of argv) {
    if (!argument.startsWith(prefix)) continue;
    const value = argument.slice(prefix.length);
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * `monthly:plan_ABC,yearly:plan_DEF` — validated, with the offending entry
 * NAMED (D-253).
 *
 * `config.schema.ts`'s `parsePlanIds` drops anything it cannot understand and
 * returns what is left, so `RAZORPAY_PLAN_IDS=monthly=plan_x` (an `=` where a
 * `:` belongs) becomes `{}`: a value the type system is perfectly happy with,
 * that boots, that reports healthy, and that fails at the checkout of the first
 * customer who tries to pay us. A parser that discards what it cannot parse and
 * returns success is the same shape of defect as an alerter that delivers
 * nowhere — the failure and the healthy state are indistinguishable.
 *
 * THE REQUIRED CODES ARE DISCOVERED, not written down (D-075): `purchasablePlans()`
 * is the same catalogue the checkout path resolves against, so a third paid plan
 * added to `PLANS` starts being required by this check on the commit that adds
 * it, with nothing for anyone to remember.
 */
function checkPlanIds(raw: string | undefined): Problem[] {
  const problems: Problem[] = [];
  const mapped = new Set<string>(Object.keys(config.payments.razorpayPlanIds));

  // The raw string is the only thing that can name a BAD entry; the parsed map
  // has already thrown it away. When it was not supplied (a hand-run outside
  // compose), the structural check below still runs against the parsed map.
  if (raw !== undefined) {
    mapped.clear();
    for (const pair of raw.split(',')) {
      const entry = pair.trim();
      if (entry.length === 0) {
        problems.push({
          variable: 'RAZORPAY_PLAN_IDS',
          detail:
            'contains an empty entry — a stray or trailing comma. Every entry must be ' +
            '`code:plan_id`.',
        });
        continue;
      }
      const parts = entry.split(':');
      const code = parts[0]?.trim() ?? '';
      const planId = parts[1]?.trim() ?? '';
      if (parts.length !== 2 || code.length === 0 || planId.length === 0) {
        problems.push({
          variable: 'RAZORPAY_PLAN_IDS',
          detail:
            `malformed entry '${entry}'. Expected exactly one colon, as \`code:plan_id\` — for ` +
            'example `monthly:plan_ABC123`. THIS ENTRY IS SILENTLY DROPPED by the config parser, ' +
            'leaving a plan the checkout path cannot resolve.',
        });
        continue;
      }
      if (mapped.has(code)) {
        problems.push({
          variable: 'RAZORPAY_PLAN_IDS',
          detail:
            `plan code '${code}' appears more than once. The later pair wins silently, so half ` +
            'of this variable is decoration and the value does not show which half.',
        });
      }
      mapped.add(code);
    }
  }

  for (const plan of purchasablePlans()) {
    if (!mapped.has(plan.code)) {
      problems.push({
        variable: 'RAZORPAY_PLAN_IDS',
        detail:
          `no plan id for the purchasable plan '${plan.code}'. It is in the billing catalogue ` +
          'and offered to customers, so a checkout for it fails on a plan code that cannot be ' +
          'mapped to Razorpay.',
      });
    }
  }

  return problems;
}

function main(): void {
  // Reaching this line already means the shared schema parsed: importing
  // `config` performs the read, and a violation has printed every offending
  // variable and exited 1 before `main` exists.
  const problems: Problem[] = [];

  if (config.isProduction) {
    const values = credentialValues();

    /**
     * THE CONTRACT AND THE READER MUST COVER THE SAME NAMES.
     *
     * Without this, a name added to `PRODUCTION_REQUIRED` and forgotten in
     * `credentialValues()` reads as `undefined`, which the loop below treats as
     * ABSENT — so the pre-flight would fail a correctly-configured production
     * deployment and tell the operator to set a variable they have already set.
     * That is the mirror image of a check that passes on nothing, and it is
     * worse: it is a gate that cannot be satisfied, which is a gate that gets
     * switched off. Distinguishing "not configured" from "not read" needs a key
     * test, not a value test.
     */
    for (const required of PRODUCTION_REQUIRED) {
      if (!Object.hasOwn(values, required.name)) {
        throw new Error(
          `pre-flight is broken: '${required.name}' is in PRODUCTION_REQUIRED but ` +
            'credentialValues() does not read it, so its absence and its presence look ' +
            'identical. Add it there, from the frozen config object.',
        );
      }
    }

    for (const required of PRODUCTION_REQUIRED) {
      if (values[required.name] === null || values[required.name] === undefined) {
        problems.push({ variable: required.name, detail: required.why });
      }
    }
    problems.push(...checkPlanIds(argValue(process.argv.slice(2), 'razorpay-plan-ids')));
  }

  if (problems.length > 0) {
    process.stderr.write(
      [
        '',
        `pre-flight FAILED — ${problems.length} problem(s). The stack will not start.`,
        '',
        ...problems.map((problem) => `  - ${problem.variable}: ${problem.detail}`),
        '',
        'Each of these is set in docker/.env.prod. docker/.env.prod.example carries',
        'the placeholder shape of every one; docs/runbooks/deploy-rollback.md says',
        'where the real values come from.',
        '',
        'This check runs FIRST and exits non-zero so api, worker and alerts are never',
        'started at all. Before it existed they started, threw inside the composition',
        'root and restart-looped — which reads as a crash rather than as a missing',
        'variable.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  process.stdout.write(
    config.isProduction
      ? `pre-flight: PASS — schema valid, ${PRODUCTION_REQUIRED.length} production credential(s) ` +
          `present, ${purchasablePlans().length} purchasable plan(s) mapped\n`
      : 'pre-flight: PASS — schema valid. NODE_ENV is not production, so the production ' +
          'credential checks were SKIPPED: this run proves nothing about a production deploy.\n',
  );
}

main();
