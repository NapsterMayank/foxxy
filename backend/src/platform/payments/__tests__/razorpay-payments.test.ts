import { describe, expect, it } from 'vitest';
import { DependencyError, ValidationError } from '../../errors/index';
import type { HttpClient, HttpRequest, HttpResponse } from '../../http/index';
import { computeSignature } from '../signature';
import { createRazorpayPayments, razorpayEventKind, RAZORPAY_PROVIDER } from '../razorpay-payments';
import type { CreateSubscriptionRequest } from '../payments.port';

/**
 * ============================================================================
 * THE REAL RAZORPAY ADAPTER, FULLY EXERCISED AND NEVER CALLED.
 *
 * There is no Razorpay account and no key, and there will not be one before
 * this ships. So every HTTP call below goes to a RECORDING FAKE `HttpClient`:
 * nothing leaves the machine, nothing is charged, and the adapter still has its
 * success path, its four failure paths and its narrowing covered.
 *
 * WHAT THIS FILE CANNOT PROVE, stated rather than implied: that Razorpay's
 * live responses have the shape asserted here. That is exactly why the adapter
 * NARROWS every field instead of casting — a live response missing `id` fails
 * loudly at the boundary rather than becoming a subscription row with an empty
 * provider id that no webhook can ever reconcile.
 *
 * The one half that IS proven against real cryptography is `verifyWebhook`,
 * because it makes no network call: it is an HMAC over bytes we already hold.
 * ============================================================================
 */

const WEBHOOK_SECRET = 'whsec_live_like';
const PLAN_IDS = { monthly: 'plan_RZP_monthly', yearly: 'plan_RZP_yearly' } as const;

interface Recorded {
  readonly requests: HttpRequest[];
}

function fakeHttp(
  respond: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): HttpClient & Recorded {
  const requests: HttpRequest[] = [];
  return {
    requests,
    async request(req: HttpRequest): Promise<HttpResponse> {
      requests.push(req);
      return respond(req);
    },
  };
}

function ok(body: unknown): HttpResponse {
  return { status: 200, headers: {}, body: JSON.stringify(body) };
}

function build(http: HttpClient): ReturnType<typeof createRazorpayPayments> {
  return createRazorpayPayments({
    http,
    keyId: 'rzp_test_key',
    keySecret: 'rzp_test_secret',
    webhookSecret: WEBHOOK_SECRET,
    baseUrl: 'https://api.razorpay.test/v1',
    planIds: PLAN_IDS,
  });
}

const CREATE: CreateSubscriptionRequest = {
  planCode: 'monthly',
  payer: { kind: 'user', id: 'payer-user-1' },
  subjectUserId: 'student-1',
  amountMinorUnits: 29_900,
  currency: 'INR',
  idempotencyKey: 'idem-abc',
};

// ---------------------------------------------------------------------------
// CONSTRUCTION
// ---------------------------------------------------------------------------

describe('construction refuses missing credentials at boot, not at first charge', () => {
  const http = fakeHttp(() => ok({}));

  it('refuses an empty key id or secret', () => {
    expect(() =>
      createRazorpayPayments({
        http,
        keyId: '  ',
        keySecret: 's',
        webhookSecret: WEBHOOK_SECRET,
        planIds: PLAN_IDS,
      }),
    ).toThrow(ValidationError);
  });

  it('refuses an empty WEBHOOK secret separately', () => {
    // Its own check and its own message: an empty webhook secret fails CLOSED
    // (every webhook is rejected), so without this the symptom is subscriptions
    // silently never activating hours after a deploy.
    expect(() =>
      createRazorpayPayments({
        http,
        keyId: 'k',
        keySecret: 's',
        webhookSecret: '',
        planIds: PLAN_IDS,
      }),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// createSubscription
// ---------------------------------------------------------------------------

describe('createSubscription', () => {
  it('posts to /subscriptions and returns the provider id and checkout url', async () => {
    const http = fakeHttp(() => ok({ id: 'sub_XYZ', short_url: 'https://rzp.io/i/abc' }));
    const created = await build(http).createSubscription(CREATE);

    expect(created).toEqual({
      providerSubscriptionId: 'sub_XYZ',
      checkoutUrl: 'https://rzp.io/i/abc',
      provider: RAZORPAY_PROVIDER,
    });

    const req = http.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('https://api.razorpay.test/v1/subscriptions');
    expect(req?.headers?.['x-razorpay-idempotency-key']).toBe('idem-abc');
    // BASIC AUTH, not a bearer token. Razorpay uses key_id:key_secret.
    expect(req?.headers?.authorization).toBe(
      `Basic ${Buffer.from('rzp_test_key:rzp_test_secret').toString('base64')}`,
    );
  });

  it('NEVER marks the create idempotent for the retry layer — §4, no retries on writes', () => {
    // `platform/http` derives idempotency from the method and refuses to retry
    // a POST. `voyage-embed.ts` overrides that with `idempotent: true` because
    // embedding is side-effect free. THIS call must never carry that flag: a
    // retried create is a second subscription and a second charge.
    const http = fakeHttp(() => ok({ id: 's', short_url: 'u' }));
    return build(http)
      .createSubscription(CREATE)
      .then(() => {
        expect(http.requests[0]?.idempotent).toBeUndefined();
        expect(http.requests[0]?.maxRetries).toBeUndefined();
      });
  });

  it('sends identifiers in `notes` and no personal data', async () => {
    const http = fakeHttp(() => ok({ id: 's', short_url: 'u' }));
    await build(http).createSubscription(CREATE);

    const body = http.requests[0]?.body as { notes: Record<string, unknown>; plan_id: string };
    expect(body.plan_id).toBe(PLAN_IDS.monthly);
    expect(body.notes).toEqual({
      payer_kind: 'user',
      payer_id: 'payer-user-1',
      subject_user_id: 'student-1',
      plan_code: 'monthly',
    });
    // `notes` is echoed into dashboards, receipts and webhooks — a third-party
    // export. Nothing name- or contact-shaped may appear in it.
    expect(JSON.stringify(body.notes)).not.toMatch(/@|name|email|phone/i);
  });

  it('refuses a plan code with no mapped Razorpay plan id', async () => {
    const http = fakeHttp(() => ok({ id: 's', short_url: 'u' }));
    await expect(
      build(http).createSubscription({ ...CREATE, planCode: 'enterprise' }),
    ).rejects.toBeInstanceOf(ValidationError);
    // Nothing was sent. A create with a missing plan id must not reach the
    // provider at all.
    expect(http.requests).toHaveLength(0);
  });

  it('raises a DependencyError on a non-2xx, carrying the status and not the body', async () => {
    const http = fakeHttp(() => ({
      status: 401,
      headers: {},
      body: '{"error":{"description":"key rzp_test_secret is invalid"}}',
    }));
    await expect(build(http).createSubscription(CREATE)).rejects.toMatchObject({
      details: { status: 401 },
    });
    await expect(build(http).createSubscription(CREATE)).rejects.toBeInstanceOf(DependencyError);
  });

  it('raises rather than returns a half-built subscription when `id` is missing', async () => {
    const http = fakeHttp(() => ok({ short_url: 'https://rzp.io/i/abc' }));
    await expect(build(http).createSubscription(CREATE)).rejects.toBeInstanceOf(DependencyError);
  });

  it('raises on a body that is not JSON', async () => {
    const http = fakeHttp(() => ({ status: 200, headers: {}, body: '<html>gateway</html>' }));
    await expect(build(http).createSubscription(CREATE)).rejects.toBeInstanceOf(DependencyError);
  });
});

// ---------------------------------------------------------------------------
// cancelSubscription
// ---------------------------------------------------------------------------

describe('cancelSubscription', () => {
  it('posts to the cancel path with the id escaped', async () => {
    const http = fakeHttp(() => ok({ status: 'cancelled' }));
    await build(http).cancelSubscription('sub_A/B');
    expect(http.requests[0]?.url).toBe(
      'https://api.razorpay.test/v1/subscriptions/sub_A%2FB/cancel',
    );
  });

  it('treats a 400 as success — cancelling twice must not break the button', async () => {
    const http = fakeHttp(() => ({
      status: 400,
      headers: {},
      body: '{"error":{"description":"subscription is not cancellable"}}',
    }));
    await expect(build(http).cancelSubscription('sub_1')).resolves.toBeUndefined();
  });

  it('raises on any other failure', async () => {
    const http = fakeHttp(() => ({ status: 503, headers: {}, body: '' }));
    await expect(build(http).cancelSubscription('sub_1')).rejects.toBeInstanceOf(DependencyError);
  });
});

// ---------------------------------------------------------------------------
// verifyWebhook — REAL CRYPTOGRAPHY, NO NETWORK
// ---------------------------------------------------------------------------

function razorpayBody(event: string, entity: Record<string, unknown> = {}): string {
  return JSON.stringify({
    entity: 'event',
    event,
    payload: { subscription: { entity: { id: 'sub_XYZ', current_end: 1_800_000_000, ...entity } } },
  });
}

describe('verifyWebhook', () => {
  const payments = build(fakeHttp(() => ok({})));

  it('returns null on a forged signature — and never throws', () => {
    const rawBody = razorpayBody('subscription.charged');
    expect(() =>
      payments.verifyWebhook({ rawBody, signature: 'f'.repeat(64), eventId: 'evt_1' }),
    ).not.toThrow();
    expect(
      payments.verifyWebhook({ rawBody, signature: 'f'.repeat(64), eventId: 'evt_1' }),
    ).toBeNull();
  });

  it('returns null when the body was tampered with after signing', () => {
    const original = razorpayBody('subscription.charged');
    const signature = computeSignature(original, WEBHOOK_SECRET);
    const tampered = razorpayBody('subscription.activated');
    expect(payments.verifyWebhook({ rawBody: tampered, signature, eventId: 'e' })).toBeNull();
  });

  it('translates a genuine event into the canonical vocabulary', () => {
    const rawBody = razorpayBody('subscription.charged');
    const verified = payments.verifyWebhook({
      rawBody,
      signature: computeSignature(rawBody, WEBHOOK_SECRET),
      eventId: 'evt_live_1',
    });

    expect(verified).toMatchObject({
      providerEventId: 'evt_live_1',
      kind: 'subscription.charged',
      providerEventName: 'subscription.charged',
      providerSubscriptionId: 'sub_XYZ',
    });
    // Epoch SECONDS, not milliseconds. Read as ms this is 21 January 1970.
    expect(verified?.currentPeriodEnd?.toISOString()).toBe(
      new Date(1_800_000_000 * 1000).toISOString(),
    );
  });

  it('reads the subscription id off a `payment.*` event too', () => {
    const rawBody = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', subscription_id: 'sub_from_payment' } } },
    });
    const verified = payments.verifyWebhook({
      rawBody,
      signature: computeSignature(rawBody, WEBHOOK_SECRET),
      eventId: 'evt_2',
    });
    expect(verified).toMatchObject({
      kind: 'payment.captured',
      providerSubscriptionId: 'sub_from_payment',
      currentPeriodEnd: null,
    });
  });

  it('maps an event type it does not implement to `unknown` rather than throwing', () => {
    // A new Razorpay event type must not become an infinite retry loop. It is
    // recorded (so the history stays complete and dedupe still works) and it
    // changes no subscription.
    const rawBody = JSON.stringify({ event: 'invoice.partially_paid', payload: {} });
    const verified = payments.verifyWebhook({
      rawBody,
      signature: computeSignature(rawBody, WEBHOOK_SECRET),
      eventId: 'evt_3',
    });
    expect(verified).toMatchObject({
      kind: 'unknown',
      providerEventName: 'invoice.partially_paid',
      providerSubscriptionId: null,
    });
  });

  it('falls back to a digest of the body when the provider sends no event id', () => {
    const rawBody = razorpayBody('subscription.activated');
    const signature = computeSignature(rawBody, WEBHOOK_SECRET);
    const first = payments.verifyWebhook({ rawBody, signature });
    const retry = payments.verifyWebhook({ rawBody, signature, eventId: null });

    // A retry re-sends identical bytes, so the dedupe key is stable — which is
    // the only property `payment_events`' unique constraint needs.
    expect(first?.providerEventId).toMatch(/^body:[0-9a-f]{64}$/);
    expect(retry?.providerEventId).toBe(first?.providerEventId);

    const different = razorpayBody('subscription.activated', { id: 'sub_OTHER' });
    expect(
      payments.verifyWebhook({
        rawBody: different,
        signature: computeSignature(different, WEBHOOK_SECRET),
      })?.providerEventId,
    ).not.toBe(first?.providerEventId);
  });

  it('a signature-valid body that is not JSON is a 400, not a retried 5xx', () => {
    // Only the holder of the shared secret can produce this, and retrying
    // reproduces it forever. Refused loudly — which is NOT the same as
    // swallowing it and answering 200.
    const rawBody = 'not json at all';
    expect(() =>
      payments.verifyWebhook({
        rawBody,
        signature: computeSignature(rawBody, WEBHOOK_SECRET),
        eventId: 'evt_4',
      }),
    ).toThrow(ValidationError);
  });

  it('a missing `event` field degrades to `unknown` rather than crashing', () => {
    const rawBody = JSON.stringify({ payload: null });
    const verified = payments.verifyWebhook({
      rawBody,
      signature: computeSignature(rawBody, WEBHOOK_SECRET),
      eventId: 'evt_5',
    });
    expect(verified?.kind).toBe('unknown');
    expect(verified?.providerEventName).toBe('unknown');
  });
});

describe('razorpayEventKind', () => {
  it('maps the vendor vocabulary onto ours', () => {
    expect(razorpayEventKind('subscription.completed')).toBe('subscription.cancelled');
    expect(razorpayEventKind('subscription.pending')).toBe('payment.failed');
    expect(razorpayEventKind('nothing.like.this')).toBe('unknown');
    // A name that is already canonical passes through.
    expect(razorpayEventKind('payment.failed')).toBe('payment.failed');
  });
});
