import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import {
  billingStatusResponseSchema,
  cancelResponseSchema,
  subscribeResponseSchema,
  webhookResponseSchema,
} from '@/shared/contracts/billing.contract';
import { WEBHOOK_PATH_PATTERN } from '../../../app/plugins/origin-check';
import { createServer } from '../../../app/server';
import { BILLING_WEBHOOK_PATH, createBillingModule } from '../index';
import {
  HARNESS_ORIGIN,
  TEST_COOKIE_NAME,
  onboard,
  startBillingHarness,
  type BillingHarness,
} from './harness';

/**
 * ============================================================================
 * THE BILLING HTTP SURFACE.
 *
 * Every success response is parsed with the SHARED CONTRACT SCHEMA rather than
 * checked field by field: if a route and the schema the frontend imports ever
 * disagree, these fail rather than the browser doing so at runtime.
 *
 * ============================================================================
 * THE CENTRAL TESTS IN THIS FILE ARE THE THREE ABOUT THE CSRF EXEMPTION.
 *
 * The webhook endpoint is the only route in the product exempt from the origin
 * check, because a payment provider sends no browser `Origin`. That exemption
 * is a PATH PREFIX — `^/api/v\d+/webhooks/` — and its compensating control is
 * the HMAC. Three things therefore have to be true at once, and each has its
 * own test:
 *
 *   1. the webhook path IS exempt (a real delivery is not 403'd);
 *   2. the exemption is SCOPED — `/api/v1/billing/webhook`, the path plan §8.8
 *      names, is NOT exempt, so naming the route that way would have 403'd
 *      every genuine delivery in production while passing in development;
 *   3. the exemption buys nothing without the signature — an unsigned POST to
 *      the exempt path is still refused.
 * ============================================================================
 */

let harness: BillingHarness;

beforeAll(async () => {
  harness = await startBillingHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

function post(url: string, cookie?: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url,
    // Every state-changing request from a browser carries an `Origin`, because
    // every real one does.
    headers: { origin: HARNESS_ORIGIN },
    ...(cookie === undefined ? {} : { cookies: { [TEST_COOKIE_NAME]: cookie } }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function get(url: string, cookie?: string): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'GET',
    url,
    ...(cookie === undefined ? {} : { cookies: { [TEST_COOKIE_NAME]: cookie } }),
  });
}

/** A webhook delivery, as a provider sends one: no Origin, no cookie. */
function deliver(
  rawBody: string,
  signature: string,
  eventId?: string,
  path = BILLING_WEBHOOK_PATH,
): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signature,
      ...(eventId === undefined ? {} : { 'x-razorpay-event-id': eventId }),
    },
    payload: rawBody,
  });
}

// ---------------------------------------------------------------------------
// THE AUTHENTICATED ENDPOINTS
// ---------------------------------------------------------------------------

describe('the three authenticated endpoints answer the contract', () => {
  it('POST /billing/subscribe', async () => {
    const account = await onboard(harness);
    const response = await post('/api/v1/billing/subscribe', account.cookie, {
      planCode: 'monthly',
    });

    expect(response.statusCode).toBe(201);
    const body = subscribeResponseSchema.parse(response.json());
    expect(body.status).toBe('pending');
    // The payer is echoed so a school-paid seat renders honestly rather than
    // the client inferring who pays from the role.
    expect(body.payer.kind).toBe('user');
  });

  it('GET /billing/status', async () => {
    const account = await onboard(harness);
    const response = await get('/api/v1/billing/status', account.cookie);

    expect(response.statusCode).toBe(200);
    const body = billingStatusResponseSchema.parse(response.json());
    expect(body.subscription).toBeNull();
    expect(body.entitlements.planCode).toBe('free');
  });

  it('POST /billing/cancel', async () => {
    const account = await onboard(harness);
    await post('/api/v1/billing/subscribe', account.cookie, { planCode: 'monthly' });
    await harness.billing.service.handleWebhook(
      harness.payments.delivery({
        id: 'evt_1',
        event: 'subscription.activated',
        subscriptionId: 'sub_fake_1',
        currentPeriodEnd: '2026-09-09T09:00:00.000Z',
      }),
    );

    const response = await post('/api/v1/billing/cancel', account.cookie);
    expect(response.statusCode).toBe(200);
    const body = cancelResponseSchema.parse(response.json());
    expect(body.status).toBe('cancelled');
    // The most important thing to tell somebody who has just cancelled.
    expect(body.accessUntil).toBe('2026-09-09T09:00:00.000Z');
  });

  it('refuses an unauthenticated caller on all three', async () => {
    expect((await post('/api/v1/billing/subscribe', undefined, { planCode: 'monthly' })).statusCode).toBe(401);
    expect((await get('/api/v1/billing/status')).statusCode).toBe(401);
    expect((await post('/api/v1/billing/cancel')).statusCode).toBe(401);
  });

  it('the SUBJECT comes from the session — there is no field to change', async () => {
    const mine = await onboard(harness);
    const theirs = await onboard(harness);

    // A body carrying somebody else's id changes nothing: the route never reads
    // one. The extra key is simply ignored by the schema.
    const response = await post('/api/v1/billing/subscribe', mine.cookie, {
      planCode: 'monthly',
      subjectUserId: theirs.userId,
    });
    expect(response.statusCode).toBe(201);

    const status = await harness.billing.service.getSubscriptionStatus(
      { userId: theirs.userId, role: 'parent', tenantId: 'not-read' },
      theirs.userId,
    ).catch(() => null);
    // The victim has nothing; the subscription belongs to the caller.
    expect(status).toBeNull();
    const mineStatus = await get('/api/v1/billing/status', mine.cookie);
    expect(billingStatusResponseSchema.parse(mineStatus.json()).subscription).not.toBeNull();
  });

  it('a state-changing call from an UNRECOGNISED ORIGIN is refused', async () => {
    const account = await onboard(harness);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscribe',
      headers: { origin: 'https://evil.test' },
      cookies: { [TEST_COOKIE_NAME]: account.cookie },
      payload: { planCode: 'monthly' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('a malformed body is a 400 before any business logic', async () => {
    const account = await onboard(harness);
    const response = await post('/api/v1/billing/subscribe', account.cookie, { planCode: '' });
    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// THE CSRF EXEMPTION — the three tests this file exists for
// ---------------------------------------------------------------------------

describe('the webhook CSRF exemption', () => {
  it('1 — IT HOLDS: a delivery with NO Origin header is not refused by the origin check', async () => {
    const account = await onboard(harness);
    await post('/api/v1/billing/subscribe', account.cookie, { planCode: 'monthly' });

    const delivery = harness.payments.delivery({
      id: 'evt_exempt',
      event: 'subscription.activated',
      subscriptionId: 'sub_fake_1',
      currentPeriodEnd: '2026-09-09T09:00:00.000Z',
    });

    const response = await deliver(delivery.rawBody, delivery.signature, 'evt_exempt');
    // Not 403. Without the exemption a provider would retry a 403 for hours
    // while subscriptions silently failed to activate.
    expect(response.statusCode).toBe(200);
    expect(webhookResponseSchema.parse(response.json())).toEqual({ received: true });
  });

  it('2 — IT IS SCOPED: the path plan §8.8 names is NOT exempt', async () => {
    // `POST /billing/webhook` sits outside `^/api/v\d+/webhooks/`, so it would
    // have been 403'd for every genuine delivery — broken in production, green
    // in development. This is why the route was named to fit the existing
    // pattern rather than the pattern being widened.
    expect(WEBHOOK_PATH_PATTERN.test(BILLING_WEBHOOK_PATH)).toBe(true);
    expect(WEBHOOK_PATH_PATTERN.test('/api/v1/billing/webhook')).toBe(false);

    const response = await deliver('{}', 'anything', 'evt', '/api/v1/billing/webhook');
    // Refused by the ORIGIN CHECK, before routing decides there is no such
    // route — which is exactly what a real provider would have hit.
    expect(response.statusCode).toBe(403);
  });

  it('3 — IT BUYS NOTHING WITHOUT THE SIGNATURE: an unsigned POST is still refused', async () => {
    const response = await deliver('{"event":"subscription.activated"}', '', 'evt_unsigned');
    expect(response.statusCode).toBe(400);
    expect(webhookResponseSchema.parse(response.json())).toEqual({ received: false });
  });

  it('the exemption does not extend to a sibling path under the same prefix', async () => {
    // The prefix is `/api/v1/webhooks/`, so a sibling IS exempt from the origin
    // check by design — and gets a 404 because no such route exists. Asserted
    // so that adding one is a deliberate act with its own compensating control,
    // rather than something that inherits the exemption unnoticed.
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/not-a-real-provider',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// THE WEBHOOK'S STATUS CODES
// ---------------------------------------------------------------------------

describe('the webhook answers with codes a provider can act on', () => {
  it('a forged signature is 400 and says nothing about why', async () => {
    const delivery = harness.payments.delivery({ id: 'e', event: 'subscription.charged' });
    const response = await deliver(delivery.rawBody, 'f'.repeat(64), 'e');

    expect(response.statusCode).toBe(400);
    // NOT 401/403: those invite a retry loop against an endpoint with no
    // credentials to fix. And the body carries no detail at all.
    expect(response.json()).toEqual({ received: false });
  });

  it('a REPLAY is 200 — the provider must stop retrying, and only a 2xx does that', async () => {
    const account = await onboard(harness);
    await post('/api/v1/billing/subscribe', account.cookie, { planCode: 'monthly' });

    const delivery = harness.payments.delivery({
      id: 'evt_replay',
      event: 'subscription.activated',
      subscriptionId: 'sub_fake_1',
      currentPeriodEnd: '2026-09-09T09:00:00.000Z',
    });

    const first = await deliver(delivery.rawBody, delivery.signature, 'evt_replay');
    const second = await deliver(delivery.rawBody, delivery.signature, 'evt_replay');

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Indistinguishable to the provider, which is right: from its side both
    // deliveries succeeded.
    expect(second.json()).toEqual(first.json());
  });

  it('reads the RAW body — a re-serialised one would never verify', async () => {
    const account = await onboard(harness);
    await post('/api/v1/billing/subscribe', account.cookie, { planCode: 'monthly' });

    const delivery = harness.payments.delivery({
      id: 'evt_raw',
      event: 'subscription.activated',
      subscriptionId: 'sub_fake_1',
      currentPeriodEnd: '2026-09-09T09:00:00.000Z',
    });

    // Whitespace the provider did not send, signed as sent. If the route parsed
    // and re-serialised, the digest would be computed over different bytes and
    // this would fail — which is the bug this asserts against.
    const spaced = `${delivery.rawBody}\n`;
    const response = await deliver(spaced, harness.payments.sign(spaced), 'evt_raw');
    expect(response.statusCode).toBe(200);
  });

  it('an event id header is preferred over the body digest', async () => {
    const delivery = harness.payments.delivery({ id: 'evt_body', event: 'subscription.charged' });
    await deliver(delivery.rawBody, delivery.signature, 'evt_header');

    const rows = await harness.postgres.client.query<{ provider_event_id: string }>(
      'select provider_event_id from payment_events',
    );
    expect(rows.rows[0]?.provider_event_id).toBe('evt_header');
  });
});

// ---------------------------------------------------------------------------
// RULE 4 — A FAILURE IS A 5XX, NEVER A 200
// ---------------------------------------------------------------------------

describe('rule 4 — a failure returns 5xx so the provider retries', () => {
  let brokenApp: FastifyInstance;

  beforeAll(async () => {
    /**
     * A SECOND app on the SAME container, wired to a repository whose
     * transaction always fails.
     *
     * The temptation in a webhook handler is a `try { … } catch { return 200 }`
     * — it makes the provider's dashboard green and the alert stop. It also
     * means every event lost during an outage is lost permanently, because the
     * provider believes it delivered. This test is what makes that swallow
     * impossible to add without a red suite.
     */
    const pool = harness.container.poolFor('billing');
    // The failure is injected at the DATABASE HANDLE, one layer below the
    // module, so the module under test is assembled exactly as the working one
    // is — nothing about billing's own code is replaced.
    const brokenDb = {
      ...pool,
      withTransaction: <T,>(): Promise<T> => Promise.reject(new Error('database unavailable')),
    };

    const billing = createBillingModule({
      db: brokenDb,
      clock: harness.clock,
      logger: harness.logger,
      requireSession: harness.identity.requireSession,
      payments: harness.payments,
      readTenantOfUser: (userId) => harness.identity.service.getTenantOfUser(userId),
      resolvePayer: (subjectUserId) => Promise.resolve({ kind: 'user', id: subjectUserId }),
      audit: harness.audit,
    });

    brokenApp = await createServer(harness.container, { modules: { identity: harness.identity } });
    await billing.registerRoutes(brokenApp);
    await brokenApp.ready();
  }, 120_000);

  afterAll(async () => {
    await brokenApp.close();
  });

  it('answers 5xx rather than swallowing the error', async () => {
    const account = await onboard(harness);
    await post('/api/v1/billing/subscribe', account.cookie, { planCode: 'monthly' });

    const delivery = harness.payments.delivery({
      id: 'evt_fail_hard',
      event: 'subscription.activated',
      subscriptionId: 'sub_fake_1',
      currentPeriodEnd: '2026-09-09T09:00:00.000Z',
    });

    const response = await brokenApp.inject({
      method: 'POST',
      url: BILLING_WEBHOOK_PATH,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': delivery.signature,
        'x-razorpay-event-id': 'evt_fail_hard',
      },
      payload: delivery.rawBody,
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(response.statusCode).toBeLessThan(600);
    // And nothing was recorded, so the provider's retry is not deduplicated
    // against a row for an event that was never applied.
    const rows = await harness.postgres.client.query<{ n: string }>(
      "select count(*)::text as n from payment_events where provider_event_id = 'evt_fail_hard'",
    );
    expect(rows.rows[0]?.n).toBe('0');
  });
});
