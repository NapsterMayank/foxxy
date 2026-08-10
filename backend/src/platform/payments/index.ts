/**
 * platform/payments — the payment-gateway port, its deterministic fake, and
 * the Razorpay adapter.
 *
 * The composition root is the only place that chooses between the fake and the
 * real adapter, and — as with `platform/embed` — production REFUSES TO BOOT
 * without credentials rather than quietly taking the fake. The degraded mode a
 * silent fallback would create is not "slower": it is entitlements granted
 * against payments that never happened.
 */
export {
  PAYMENT_EVENT_KINDS,
  isPaymentEventKind,
} from './payments.port';
export type {
  CreateSubscriptionRequest,
  CreatedSubscription,
  Payer,
  PayerKind,
  PaymentEventKind,
  PaymentsPort,
  VerifiedWebhook,
  WebhookDelivery,
} from './payments.port';

/** The HMAC. Shared by the fake and the real adapter — see `signature.ts`. */
export { computeSignature, verifySignature } from './signature';

export { createGuardedPayments } from './guarded-payments';
export { FAKE_PROVIDER, createFakePayments } from './fake-payments';
export type { FakePayments, FakePaymentsOptions, FakeWebhookBody } from './fake-payments';
export {
  RAZORPAY_BASE_URL,
  RAZORPAY_PROVIDER,
  createRazorpayPayments,
  razorpayEventKind,
} from './razorpay-payments';
export type { RazorpayOptions } from './razorpay-payments';
