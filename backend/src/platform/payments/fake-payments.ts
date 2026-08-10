import { ValidationError } from '../errors/index';
import { computeSignature, verifySignature } from './signature';
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
 * THE DETERMINISTIC PAYMENT FAKE — the same role `platform/embed`'s
 * `createDeterministicEmbed` plays, for the same reason.
 *
 * ===========================================================================
 * IT VERIFIES SIGNATURES FOR REAL. THAT IS THE WHOLE DESIGN.
 *
 * The obvious fake accepts any webhook and returns a canned event, and a suite
 * built on one proves that the happy path works while saying NOTHING about the
 * only security property this subsystem has. Every "forged signature is
 * rejected" test would pass against a service with the check deleted.
 *
 * So this fake shares `signature.ts` with the real adapter — the same HMAC, the
 * same timing-safe comparison, the same refusal on an empty secret. The
 * difference between fake and real is the NETWORK, never the cryptography.
 * `sign()` below is how a test produces a genuine signature; there is no way to
 * make this object accept an unsigned body, because there is no code path that
 * would.
 * ===========================================================================
 *
 * DETERMINISTIC IDS. `sub_fake_1`, `sub_fake_2`, … in creation order, so a test
 * can assert on an id it did not have to capture. No clock, no randomness, no
 * ordering surprises between runs.
 */

export const FAKE_PROVIDER = 'fake';

/** The canonical envelope the fake signs and verifies. Deliberately not Razorpay's. */
export interface FakeWebhookBody {
  readonly id: string;
  readonly event: string;
  readonly subscriptionId?: string | null;
  /** ISO-8601. The end of the period this event pays for. */
  readonly currentPeriodEnd?: string | null;
}

export interface FakePaymentsOptions {
  /** The shared webhook secret. Tests sign with the same value. */
  readonly secret: string;
  /** Plan codes this fake will sell. An unknown one is refused, as Razorpay's is. */
  readonly planCodes?: readonly string[];
}

export interface FakePayments extends PaymentsPort {
  /** Every create, in order. */
  readonly created: readonly CreateSubscriptionRequest[];
  /** Every provider subscription id cancelled, in order. May contain repeats. */
  readonly cancelled: readonly string[];
  /** A GENUINE signature for a body. The only way to get one past `verifyWebhook`. */
  sign(rawBody: string): string;
  /** Serialises a body and signs it. The shape most tests want. */
  delivery(body: FakeWebhookBody, eventId?: string | null): WebhookDelivery;
  /** Makes the next `createSubscription` reject. Deliberate failure injection. */
  failNextCreate(error: Error): void;
  reset(): void;
}

export function createFakePayments(options: FakePaymentsOptions): FakePayments {
  const created: CreateSubscriptionRequest[] = [];
  const cancelled: string[] = [];
  const planCodes = options.planCodes ?? null;
  let counter = 0;
  let nextCreateError: Error | null = null;

  return {
    name: FAKE_PROVIDER,
    created,
    cancelled,

    sign(rawBody: string): string {
      return computeSignature(rawBody, options.secret);
    },

    delivery(body: FakeWebhookBody, eventId?: string | null): WebhookDelivery {
      const rawBody = JSON.stringify(body);
      return {
        rawBody,
        signature: computeSignature(rawBody, options.secret),
        eventId: eventId ?? body.id,
      };
    },

    failNextCreate(error: Error): void {
      nextCreateError = error;
    },

    reset(): void {
      created.length = 0;
      cancelled.length = 0;
      counter = 0;
      nextCreateError = null;
    },

    createSubscription(req: CreateSubscriptionRequest): Promise<CreatedSubscription> {
      if (nextCreateError !== null) {
        const error = nextCreateError;
        nextCreateError = null;
        return Promise.reject(error);
      }
      if (planCodes !== null && !planCodes.includes(req.planCode)) {
        return Promise.reject(
          new ValidationError('That plan is not available.', {
            message: `createFakePayments: unknown plan "${req.planCode}"`,
          }),
        );
      }

      created.push(req);
      counter += 1;
      const id = `sub_fake_${String(counter)}`;
      return Promise.resolve({
        providerSubscriptionId: id,
        checkoutUrl: `https://pay.fake.test/${id}`,
        provider: FAKE_PROVIDER,
      });
    },

    cancelSubscription(providerSubscriptionId: string): Promise<void> {
      // Idempotent, exactly as the real adapter is: a repeat is recorded and
      // succeeds. A fake that threw on the second call would make the service
      // look correct against behaviour the provider does not have.
      cancelled.push(providerSubscriptionId);
      return Promise.resolve();
    },

    verifyWebhook(delivery: WebhookDelivery): VerifiedWebhook | null {
      // RULE 1. Before anything is parsed. Same order as the real adapter,
      // because a fake with a different ORDER of operations would let a service
      // pass its tests and parse attacker input in production.
      if (!verifySignature(delivery.rawBody, delivery.signature, options.secret)) {
        return null;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(delivery.rawBody) as unknown;
      } catch (cause) {
        throw new ValidationError('Malformed webhook body.', {
          message: 'fake payments: signature verified but the body is not JSON',
          cause,
        });
      }

      const body = parsed as Partial<FakeWebhookBody>;
      const providerEventName = typeof body.event === 'string' ? body.event : 'unknown';
      const kind: PaymentEventKind = isPaymentEventKind(providerEventName)
        ? providerEventName
        : 'unknown';
      const periodEnd =
        typeof body.currentPeriodEnd === 'string' ? new Date(body.currentPeriodEnd) : null;

      return {
        providerEventId: delivery.eventId ?? (typeof body.id === 'string' ? body.id : ''),
        kind,
        providerEventName,
        providerSubscriptionId: typeof body.subscriptionId === 'string' ? body.subscriptionId : null,
        currentPeriodEnd: periodEnd !== null && !Number.isNaN(periodEnd.getTime()) ? periodEnd : null,
        payload: parsed,
      };
    },
  };
}
