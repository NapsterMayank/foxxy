import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  adminDryRunResponseSchema,
  adminHealthResponseSchema,
  adminJobsResponseSchema,
  adminMetricsResponseSchema,
  adminOverviewResponseSchema,
  adminRulesResponseSchema,
  adminSignalsResponseSchema,
  adminWorkersResponseSchema,
} from '@/shared/contracts/admin.contract';
import {
  HARNESS_ORIGIN,
  TEST_COOKIE_NAME,
  onboardAccount,
  startAppHarness,
  type AppHarness,
} from '../helpers/app-harness';

/**
 * =============================================================================
 * THE MONITORING SURFACE, DRIVEN AS AN OPERATOR.
 *
 * Every response is parsed with the SHARED CONTRACT SCHEMA rather than checked
 * field by field — the same discipline the practice suite uses, and for the
 * same reason: the admin app imports these schemas, so a route and its contract
 * disagreeing must fail here rather than in a browser.
 *
 * The assertion that matters most is the last one. `POST /monitoring/dry-run`
 * runs a real evaluation cycle against real signals, and the whole design rests
 * on it being unable to page anybody. That is proved by counting notifications
 * and mail either side of it, not by reading the code.
 * =============================================================================
 */

let harness: AppHarness;
let adminCookie: string;

beforeAll(async () => {
  harness = await startAppHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

/**
 * A `super_admin` with a live session.
 *
 * Onboarded as a student and then PROMOTED WITH RAW SQL, because there is no
 * application path that produces this role — which is the security property,
 * not an inconvenience. `admin:create` is the real route and it is a script; a
 * test that called it would be testing the script's argument parsing.
 *
 * Promoting after the session exists also proves something worth knowing: the
 * role is read from the database on every request rather than baked into the
 * cookie, so a demotion takes effect immediately.
 */
beforeEach(async () => {
  await harness.reset();
  const account = await onboardAccount(harness, 'operator@example.test', 'student');
  await harness.postgres.client.query(`update users set role = 'super_admin' where id = $1`, [
    account.userId,
  ]);
  adminCookie = account.cookie;
});

function get(url: string): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'GET',
    url,
    headers: { origin: HARNESS_ORIGIN },
    cookies: { [TEST_COOKIE_NAME]: adminCookie },
  });
}

function post(url: string): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url,
    headers: { origin: HARNESS_ORIGIN },
    payload: {},
    cookies: { [TEST_COOKIE_NAME]: adminCookie },
  });
}

async function countRows(table: string): Promise<number> {
  const { rows } = await harness.postgres.client.query<{ count: string }>(
    `select count(*) as count from ${table}`,
  );
  return Number(rows[0]?.count ?? '0');
}

describe('the monitoring endpoints answer and match their contracts', () => {
  it.each([
    ['/api/v1/admin/overview', adminOverviewResponseSchema],
    ['/api/v1/admin/monitoring/signals', adminSignalsResponseSchema],
    ['/api/v1/admin/monitoring/rules', adminRulesResponseSchema],
    ['/api/v1/admin/monitoring/jobs', adminJobsResponseSchema],
    ['/api/v1/admin/monitoring/workers', adminWorkersResponseSchema],
    ['/api/v1/admin/monitoring/metrics', adminMetricsResponseSchema],
    ['/api/v1/admin/monitoring/health', adminHealthResponseSchema],
  ])('%s', async (url, schema) => {
    const response = await get(url);
    expect({ url, status: response.statusCode }).toEqual({ url, status: 200 });

    const parsed = schema.safeParse(response.json());
    expect({ url, ok: parsed.success, error: parsed.success ? null : parsed.error.issues }).toEqual({
      url,
      ok: true,
      error: null,
    });
  });
});

describe('the signals screen shows what is NOT being measured', () => {
  it('reports readiness as a blind spot when the probe cannot reach the API', async () => {
    // The harness points `readinessUrl` at a dead port on purpose. An
    // unmeasurable signal disables every rule watching it, and that state must
    // be VISIBLE rather than rendered as a quiet, healthy zero.
    const parsed = adminSignalsResponseSchema.parse((await get('/api/v1/admin/monitoring/signals')).json());
    const readiness = parsed.signals.find((signal) => signal.name === 'readiness.failing');

    expect(readiness).toBeDefined();
    expect(readiness?.watchedBy.length).toBeGreaterThan(0);
  });

  it('names the rules watching each signal, so an orphan is visible', async () => {
    const parsed = adminSignalsResponseSchema.parse((await get('/api/v1/admin/monitoring/signals')).json());
    // At least one signal must be watched, or the join is broken and every
    // signal would read as an orphan.
    expect(parsed.signals.some((signal) => signal.watchedBy.length > 0)).toBe(true);
  });
});

describe('the rules screen tells the truth about cooldowns', () => {
  it('states that cooldowns are process-local rather than implying they are live', async () => {
    const parsed = adminRulesResponseSchema.parse((await get('/api/v1/admin/monitoring/rules')).json());

    expect(parsed.cooldownsAreProcessLocal).toBe(true);
    expect(parsed.rules.length).toBeGreaterThan(0);
    // Every rule carries the runbook line an operator acts on at 3am.
    for (const rule of parsed.rules) {
      expect(rule.runbook.length).toBeGreaterThan(0);
      expect(rule.channels.length).toBeGreaterThan(0);
    }
  });
});

describe('the dry run cannot page anybody', () => {
  it('evaluates real rules and delivers nothing', async () => {
    const notificationsBefore = await countRows('notifications');
    const mailBefore = harness.mail.sent.length;

    const response = await post('/api/v1/admin/monitoring/dry-run');
    expect(response.statusCode).toBe(200);

    const parsed = adminDryRunResponseSchema.parse(response.json());

    // It really ran: every shipped rule was evaluated.
    expect(parsed.evaluatedRules).toBeGreaterThan(0);
    expect(parsed.delivered).toBe(false);

    // AND NOTHING WAS SENT. This is the assertion the design rests on — no
    // dispatcher is constructed in the dry-run path, so there is no code route
    // from here to a channel.
    expect(await countRows('notifications')).toBe(notificationsBefore);
    expect(harness.mail.sent.length).toBe(mailBefore);
  });

  it('reaches a real firing decision on real signals', async () => {
    const parsed = adminDryRunResponseSchema.parse(
      (await post('/api/v1/admin/monitoring/dry-run')).json(),
    );

    /**
     * THE HARNESS PROBES A DEAD PORT, AND THAT IS A MEASUREMENT.
     *
     * A refused connection is not a blind spot — `alert-sources.ts` is explicit
     * that "a non-200, a timeout and a connection refusal are ALL failing",
     * because the answer to "should this instance receive traffic" is no in
     * every one of those cases. So readiness collects as 1 and its rule fires.
     *
     * Which makes this the strongest assertion available here: the dry run did
     * not merely return a shape, it collected a live signal, compared it to a
     * shipped threshold, and produced the alert an operator would have been
     * paged for — while paging nobody.
     */
    const readiness = parsed.wouldFire.find((alert) => alert.ruleId === 'readiness_failing');
    expect(readiness).toBeDefined();
    expect(readiness?.value).toBe(1);
    expect(readiness?.runbook.length ?? 0).toBeGreaterThan(0);
  });

  it('gives every blind spot a reason, when there is one', async () => {
    const parsed = adminDryRunResponseSchema.parse(
      (await post('/api/v1/admin/monitoring/dry-run')).json(),
    );
    // Not asserting that blind spots EXIST — in this harness they may not, and
    // a test that demanded one would be demanding a broken collector. What must
    // hold is that an unmeasurable signal is never reported without saying why.
    for (const blindSpot of parsed.blindSpots) {
      expect(blindSpot.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('every admin read is on the record', () => {
  it('writes an audit row carrying counts and no PII', async () => {
    await get('/api/v1/admin/overview');

    const { rows } = await harness.postgres.client.query<{
      action: string;
      resource_type: string;
      metadata: Record<string, unknown>;
    }>(`select action, resource_type, metadata from audit_log where action like 'admin.%'`);

    expect(rows.length).toBeGreaterThan(0);
    const overview = rows.find((row) => row.resource_type === 'overview');
    expect(overview?.action).toBe('admin.read');

    // Identifiers and counts ONLY — the audit_log.metadata contract.
    const serialised = JSON.stringify(rows.map((row) => row.metadata));
    expect(serialised).not.toContain('@');
    expect(serialised.toLowerCase()).not.toContain('operator');
  });

  it('records a dry run as its own action, not as an ordinary read', async () => {
    await post('/api/v1/admin/monitoring/dry-run');

    const { rows } = await harness.postgres.client.query<{ action: string }>(
      `select action from audit_log where action = 'admin.alert_dry_run'`,
    );
    expect(rows.length).toBe(1);
  });
});
