/**
 * platform/payments — THE PAYMENT-GATEWAY PORT.
 *
 * ===========================================================================
 * TWO THINGS ARE SWAPPABLE HERE, AND ONLY ONE OF THEM IS THE VENDOR.
 *
 * 1. THE PROVIDER. Razorpay today. The adapter is the only file that knows the
 *    word "Razorpay"; everything above this interface speaks the canonical
 *    vocabulary declared below.
 *
 * 2. THE PAYER. This is the one that is easy to get wrong and expensive to
 *    undo. The product may ship as a B2C parent subscription or as a B2B school
 *    pilot where the SCHOOL pays and per-parent subscriptions never exist at
 *    all — that question is unresolved. So `Payer` is a discriminated pair
 *    (`kind`, `id`) and is CARRIED SEPARATELY from the beneficiary: nothing in
 *    this port, in the domain, or in the schema says "a parent pays".
 *
 *    Concretely, `createSubscription` takes a payer AND a subject. In B2C they
 *    are the same user; in B2B the payer is a school and the subject is a
 *    student who has never seen a payment page. Collapsing them into one
 *    `userId` — which this port used to do — would make the B2B case a schema
 *    migration and a rewrite of every call site rather than one line at the
 *    composition root.
 * ===========================================================================
 *
 * `verifyWebhook` takes the RAW body, not a parsed object. The signature is
 * verified before anything is parsed — an unverified webhook is
 * attacker-controlled input (plan §8.8, rule 1), and a JSON parser is a large
 * attack surface to run against bytes nobody has authenticated.
 */

/** Who pays. NOT necessarily who benefits — see the header. */
export type PayerKind = 'user' | 'school';

export interface Payer {
  readonly kind: PayerKind;
  /** A `users.id` for `user`, a `schools.id` for `school`. */
  readonly id: string;
}

/**
 * THE CANONICAL EVENT VOCABULARY — provider-agnostic by construction.
 *
 * The adapter translates Razorpay's names (`subscription.activated`,
 * `subscription.charged`, `payment.failed`, …) into these. Nothing above this
 * port ever matches on a vendor string, which is what makes replacing the
 * vendor an adapter change rather than a search-and-replace through the domain.
 *
 * `unknown` IS A MEMBER ON PURPOSE, and it is the most important one. Providers
 * add event types without asking. An enum that cannot express "a genuine,
 * correctly-signed event whose meaning we do not implement" forces the adapter
 * to either throw (which turns a harmless new event type into an infinite
 * retry loop and a 5xx alert storm) or to guess. Instead it maps to `unknown`,
 * the event row is still recorded — so the history is complete and the event is
 * still deduplicated — and the subscription is left alone.
 */
export const PAYMENT_EVENT_KINDS = [
  'subscription.activated',
  'subscription.charged',
  'subscription.cancelled',
  'subscription.halted',
  'payment.captured',
  'payment.failed',
  'unknown',
] as const;

export type PaymentEventKind = (typeof PAYMENT_EVENT_KINDS)[number];

export function isPaymentEventKind(value: string): value is PaymentEventKind {
  return (PAYMENT_EVENT_KINDS as readonly string[]).includes(value);
}

export interface CreateSubscriptionRequest {
  readonly planCode: string;
  /** Who is charged. See the header — never assumed to be the subject. */
  readonly payer: Payer;
  /**
   * Whose entitlements this subscription grants (`users.id`).
   *
   * Carried through to the provider only as an opaque note; the authoritative
   * link lives in our own `subscriptions` row.
   */
  readonly subjectUserId: string;
  /** Paise, not rupees. An integer, because money is never a float. */
  readonly amountMinorUnits: number;
  /** ISO-4217. `INR` today; a school pilot abroad would change only this. */
  readonly currency: string;
  /**
   * OUR key, not the provider's.
   *
   * A create is a WRITE and §4 forbids retrying it — "retrying a payment is
   * worse than failing it". This key is the second belt: if a retry happens
   * anywhere (a proxy, an operator, a client double-tap), the provider
   * collapses it rather than opening a second subscription.
   */
  readonly idempotencyKey: string;
}

export interface CreatedSubscription {
  readonly providerSubscriptionId: string;
  /** Where the browser is sent to complete payment. */
  readonly checkoutUrl: string;
  /** Which provider issued it. Stored, so a vendor migration stays legible. */
  readonly provider: string;
}

/**
 * A webhook whose signature verified, translated into our vocabulary.
 *
 * `payload` is the parsed body, kept whole so `payment_events` records what the
 * provider actually said rather than our interpretation of it. When the two
 * disagree later, the raw row is the evidence.
 */
export interface VerifiedWebhook {
  readonly providerEventId: string;
  readonly kind: PaymentEventKind;
  /** The provider's own event name, before translation. For the audit trail. */
  readonly providerEventName: string;
  readonly providerSubscriptionId: string | null;
  /** The end of the paid period this event establishes, when it states one. */
  readonly currentPeriodEnd: Date | null;
  readonly payload: unknown;
}

/**
 * One inbound webhook delivery, exactly as it arrived.
 *
 * A STRUCT RATHER THAN POSITIONAL ARGUMENTS, because the two strings are
 * `(rawBody, signature)` and transposing them silently verifies the signature
 * against itself — which fails closed here, but would be a very quiet bug to
 * find. Named fields cannot be transposed.
 */
export interface WebhookDelivery {
  /** The bytes, unparsed. The signature is computed over exactly these. */
  readonly rawBody: string;
  /** The provider's signature header. Attacker-controlled until verified. */
  readonly signature: string;
  /**
   * The provider's own delivery id, from a header (Razorpay sends
   * `x-razorpay-event-id`), or null when it sends none.
   *
   * NULL IS SUPPORTED AND IS NOT A DEGRADED MODE. The adapter falls back to a
   * digest of the raw body, which is a sound deduplication key for the property
   * that matters: a provider retry re-sends the identical bytes, so it produces
   * the identical key and the unique constraint on `payment_events` catches it.
   * Two genuinely different events never share a body — every provider payload
   * carries at least a timestamp and an entity id.
   */
  readonly eventId?: string | null;
}

export interface PaymentsPort {
  /**
   * WHICH PROVIDER THIS IS — `razorpay`, `fake`, …
   *
   * On the PORT rather than in the composition root's head, because it is
   * written into every `subscriptions` row and read back to reconcile every
   * webhook. Two independent copies of "which provider are we on" is exactly
   * the drift that makes a vendor migration a data-repair job: a row created
   * under one name and looked up under another simply is not found, and the
   * symptom is a payment that arrives and grants nothing.
   */
  readonly name: string;
  createSubscription(req: CreateSubscriptionRequest): Promise<CreatedSubscription>;
  /**
   * Cancels at the provider. Idempotent: cancelling an already-cancelled
   * subscription is a no-op rather than an error, because the alternative is a
   * user who cannot cancel because they already did.
   */
  cancelSubscription(providerSubscriptionId: string): Promise<void>;
  /**
   * Returns null when the signature does not verify. NEVER THROWS on a forged
   * signature — the caller answers 400 and logs it, and a throw here would make
   * "forged" indistinguishable from "the provider is down" at the call site.
   *
   * It MAY throw when the signature verifies and the body is unusable, which is
   * a different fact entirely: see the adapter.
   */
  verifyWebhook(delivery: WebhookDelivery): VerifiedWebhook | null;
}
