import { createHash } from 'node:crypto';
import { DependencyError, ValidationError } from '../errors/index';
import type { HttpClient } from '../http/index';
import { verifySignature } from './signature';
import {
  isPaymentEventKind,
  type CreateSubscriptionRequest,
  type CreatedSubscription,
  type PaymentEventKind,
  type PaymentsPort,
  type VerifiedWebhook,
  type WebhookDelivery,
} from './payments.port';

/**
 * THE REAL PAYMENT ADAPTER — Razorpay.
 *
 * ===========================================================================
 * NOT CALLED BY ANY TEST, AND THAT IS THE POINT.
 *
 * There is no Razorpay account and no key. Every test drives a FAKE
 * `HttpClient`, so this file is fully exercised — success, non-2xx, malformed
 * body, missing id, an unknown event type, a forged signature — without a byte
 * leaving the machine and without anything being charged to anybody. The
 * composition root is the only place that constructs it.
 *
 * THE ONE THING THAT IS GENUINELY EXERCISED AGAINST REAL CRYPTOGRAPHY is
 * `verifyWebhook`, because it makes no network call at all: it is a local
 * HMAC over bytes we already hold. So the security-critical half of this
 * adapter has real coverage even with no vendor relationship, and the half that
 * remains unproven until a live key exists is the HTTP shape — which is why
 * every field this file reads out of a Razorpay response is narrowed rather
 * than cast (see `narrow…` below).
 * ===========================================================================
 *
 * RESILIENCE IS NOT IMPLEMENTED HERE, DELIBERATELY. Timeouts, the concurrency
 * limit and the breaker live in the injected `HttpClient` and in
 * `createGuardedPayments`. An adapter with its own retry loop would stack two
 * backoff curves onto a struggling dependency, and only one of them would show
 * up in the metrics.
 *
 * AND THERE IS NO RETRY ON `createSubscription`, at any layer. §4: "none on
 * writes — retrying a payment is worse than failing it." A failed checkout is a
 * support ticket; a double charge is a refund, a chargeback and a customer who
 * will not come back. `platform/http` derives idempotency from the METHOD and
 * refuses to retry a POST, and this file does NOT pass `idempotent: true` — the
 * flag `voyage-embed.ts` sets for a side-effect-free POST is exactly the flag
 * that must never appear here.
 */

export const RAZORPAY_BASE_URL = 'https://api.razorpay.com/v1';
export const RAZORPAY_PROVIDER = 'razorpay';

/**
 * Razorpay's event names -> the canonical vocabulary.
 *
 * A TABLE, NOT A SWITCH, and not because it is shorter. A switch invites a
 * `default:` that guesses; a table makes "we do not implement this event" a
 * lookup miss, which resolves to `unknown` and is then RECORDED rather than
 * acted on. Razorpay adds event types without asking, and the correct response
 * to an unrecognised-but-authentic event is to store it and change nothing —
 * not to throw, which would turn a new event type into an infinite retry loop.
 */
const EVENT_KINDS: Readonly<Record<string, PaymentEventKind>> = Object.freeze({
  'subscription.activated': 'subscription.activated',
  'subscription.charged': 'subscription.charged',
  'subscription.cancelled': 'subscription.cancelled',
  'subscription.completed': 'subscription.cancelled',
  'subscription.halted': 'subscription.halted',
  'subscription.pending': 'payment.failed',
  'payment.captured': 'payment.captured',
  'payment.failed': 'payment.failed',
});

export interface RazorpayOptions {
  /** Carries the timeout, the concurrency limit and the breaker. */
  readonly http: HttpClient;
  /** `RAZORPAY_KEY_ID`. */
  readonly keyId: string;
  /** `RAZORPAY_KEY_SECRET`. Never logged — see `platform/pii`. */
  readonly keySecret: string;
  /**
   * `RAZORPAY_WEBHOOK_SECRET`. A DIFFERENT secret from the API key, and
   * conflating the two is a real and common misconfiguration: the webhook
   * secret is set in the Razorpay dashboard per endpoint, and using the API
   * secret instead makes every genuine webhook fail its signature check while
   * everything else about the integration appears to work.
   */
  readonly webhookSecret: string;
  /** Overridable so a test never needs a URL matcher. */
  readonly baseUrl?: string;
  /**
   * Our plan code -> Razorpay's `plan_id`.
   *
   * Injected rather than hardcoded, because a Razorpay plan id is created in
   * their dashboard and differs between the test and live accounts. A constant
   * here would mean a staging deployment silently subscribing people to a
   * production plan.
   */
  readonly planIds: Readonly<Record<string, string>>;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function stringAt(source: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Razorpay sends epoch SECONDS. Milliseconds would be 1970 — or the year 56000. */
function epochSecondsAt(source: Readonly<Record<string, unknown>> | null, key: string): Date | null {
  const value = source?.[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000);
}

/**
 * The subscription entity a webhook is about, if it is about one.
 *
 * Razorpay nests it as `payload.subscription.entity`. A `payment.*` event has
 * `payload.payment.entity` instead, which carries the subscription id on
 * `subscription_id` — both shapes are read, because a yearly one-off arrives as
 * a payment and a recurring charge arrives as a subscription, and a billing
 * system that only understands one of them silently drops half its revenue
 * events.
 */
function subscriptionIdOf(payload: Readonly<Record<string, unknown>> | null): string | null {
  const subscription = asRecord(asRecord(payload?.subscription)?.entity);
  const fromSubscription = stringAt(subscription, 'id');
  if (fromSubscription !== null) return fromSubscription;

  const payment = asRecord(asRecord(payload?.payment)?.entity);
  return stringAt(payment, 'subscription_id');
}

function periodEndOf(payload: Readonly<Record<string, unknown>> | null): Date | null {
  const subscription = asRecord(asRecord(payload?.subscription)?.entity);
  // `current_end` is the end of the period this charge paid for. `end_at` is
  // the end of the whole subscription, which is a different fact and must not
  // be used to extend access.
  return epochSecondsAt(subscription, 'current_end');
}

/**
 * A deterministic deduplication key for a delivery with no event-id header.
 *
 * A digest of the exact bytes: a provider retry re-sends them unchanged, so the
 * key is stable across retries, and two different events never share a body.
 */
function bodyDigest(rawBody: string): string {
  return `body:${createHash('sha256').update(rawBody, 'utf8').digest('hex')}`;
}

export function createRazorpayPayments(options: RazorpayOptions): PaymentsPort {
  const baseUrl = (options.baseUrl ?? RAZORPAY_BASE_URL).replace(/\/+$/, '');

  /**
   * AT CONSTRUCTION, NOT AT FIRST CALL.
   *
   * A missing key discovered on a student's first checkout is an outage
   * discovered by a customer. Discovered at boot it is a deployment that
   * refuses to start, which is what `platform/config` is for.
   */
  if (options.keyId.trim().length === 0 || options.keySecret.trim().length === 0) {
    throw new ValidationError('Razorpay credentials are required.', {
      message: 'createRazorpayPayments: keyId or keySecret is empty',
    });
  }
  if (options.webhookSecret.trim().length === 0) {
    // Separately, and with its own message. An empty webhook secret would make
    // `verifySignature` refuse every webhook — which fails closed, but silently
    // and only in production, hours after the deploy, as subscriptions quietly
    // stop activating.
    throw new ValidationError('Razorpay webhook secret is required.', {
      message: 'createRazorpayPayments: webhookSecret is empty',
    });
  }

  const authorization = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString('base64')}`;

  return {
    name: RAZORPAY_PROVIDER,

    async createSubscription(req: CreateSubscriptionRequest): Promise<CreatedSubscription> {
      const planId = options.planIds[req.planCode];
      if (planId === undefined) {
        throw new ValidationError('That plan is not available.', {
          message: `createRazorpayPayments: no Razorpay plan id mapped for "${req.planCode}"`,
          details: { planCode: req.planCode },
        });
      }

      const response = await options.http.request({
        method: 'POST',
        url: `${baseUrl}/subscriptions`,
        headers: {
          authorization,
          // Razorpay collapses repeated creates carrying the same key. The
          // second belt described in the header — the first is that nothing
          // retries this call.
          'x-razorpay-idempotency-key': req.idempotencyKey,
        },
        body: {
          plan_id: planId,
          total_count: 12,
          customer_notify: 1,
          notes: {
            // IDENTIFIERS ONLY. `notes` is echoed back in dashboards, emails
            // and webhooks, so a name or an email here would be personal data
            // exported to a third party as a side effect of a billing call.
            payer_kind: req.payer.kind,
            payer_id: req.payer.id,
            subject_user_id: req.subjectUserId,
            plan_code: req.planCode,
          },
        },
      });

      if (response.status < 200 || response.status >= 300) {
        throw new DependencyError('payments', {
          // The STATUS, never the body: some providers echo the key back in
          // their error text.
          message: `Razorpay responded ${String(response.status)} to a subscription create`,
          details: { status: response.status },
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch (cause) {
        throw new DependencyError('payments', {
          message: 'Razorpay returned a body that is not JSON',
          cause,
        });
      }

      const record = asRecord(parsed);
      const id = stringAt(record, 'id');
      const shortUrl = stringAt(record, 'short_url');
      if (id === null || shortUrl === null) {
        // Refused rather than defaulted. A subscription row with an empty
        // provider id can never be reconciled against a webhook, so the money
        // would move and the entitlement would not.
        throw new DependencyError('payments', {
          message: 'Razorpay subscription response is missing `id` or `short_url`',
        });
      }

      return { providerSubscriptionId: id, checkoutUrl: shortUrl, provider: RAZORPAY_PROVIDER };
    },

    async cancelSubscription(providerSubscriptionId: string): Promise<void> {
      const response = await options.http.request({
        method: 'POST',
        url: `${baseUrl}/subscriptions/${encodeURIComponent(providerSubscriptionId)}/cancel`,
        headers: { authorization },
        body: { cancel_at_cycle_end: 0 },
      });

      // IDEMPOTENT BY DESIGN. Razorpay answers 400 when a subscription is
      // already cancelled, and treating that as a failure would mean a user who
      // cancelled once can never cancel again — the button stays broken for the
      // exact person who already got what they asked for.
      if (response.status === 400 || (response.status >= 200 && response.status < 300)) return;

      throw new DependencyError('payments', {
        message: `Razorpay responded ${String(response.status)} to a cancel`,
        details: { status: response.status },
      });
    },

    verifyWebhook(delivery: WebhookDelivery): VerifiedWebhook | null {
      // ===================================================================
      // RULE 1 OF §8.8, AND IT IS THE FIRST STATEMENT FOR A REASON. Nothing
      // above this line parses, reads or branches on the body. Until this
      // returns true the bytes are attacker-controlled input.
      // ===================================================================
      if (!verifySignature(delivery.rawBody, delivery.signature, options.webhookSecret)) {
        return null;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(delivery.rawBody);
      } catch (cause) {
        /**
         * SIGNATURE-VALID BUT UNPARSEABLE IS NOT FORGERY, AND IS NOT A 5XX.
         *
         * Only somebody holding the shared secret can produce this, so it is
         * either the provider malfunctioning or our own secret leaked. Either
         * way, RETRYING REPRODUCES IT FOREVER — the body will not become valid
         * JSON on the fourth attempt. A 5xx would make the provider retry for
         * hours and page somebody every time.
         *
         * So it is a 400 with a loud log, which is the one case where a
         * non-2xx that stops the retries is the honest answer. This is
         * deliberately NOT the same as swallowing an error and returning 200:
         * the delivery is refused and recorded, not accepted and dropped.
         */
        throw new ValidationError('Malformed webhook body.', {
          message: 'razorpay webhook: signature verified but the body is not JSON',
          cause,
        });
      }

      const root = asRecord(parsed);
      const providerEventName = stringAt(root, 'event') ?? 'unknown';
      const payload = asRecord(root?.payload);

      return {
        providerEventId: delivery.eventId ?? bodyDigest(delivery.rawBody),
        kind: EVENT_KINDS[providerEventName] ?? 'unknown',
        providerEventName,
        providerSubscriptionId: subscriptionIdOf(payload),
        currentPeriodEnd: periodEndOf(payload),
        payload: parsed,
      };
    },
  };
}

/** Exported for the adapter's own tests; nothing else should need it. */
export function razorpayEventKind(providerEventName: string): PaymentEventKind {
  const mapped = EVENT_KINDS[providerEventName];
  if (mapped !== undefined) return mapped;
  return isPaymentEventKind(providerEventName) ? providerEventName : 'unknown';
}
