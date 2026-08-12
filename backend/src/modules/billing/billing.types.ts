import type { Actor } from '@/platform/authz/index';
import type { Payer, PayerKind } from '@/platform/payments/index';
import type { SubscriptionStatus } from '@/shared/contracts/billing.contract';

/**
 * Internal types for the billing module. Nothing here is public except where
 * `index.ts` re-exports it deliberately.
 */

/** The authenticated caller: `{ userId, role, tenantId }`, never a user row. */
export type BillingActor = Actor;

export type { Payer, PayerKind };

/** One subscription, as the service moves it around. */
export interface SubscriptionRecord {
  readonly id: string;
  /** WHOSE entitlements this grants. */
  readonly subjectUserId: string;
  readonly payer: Payer;
  readonly planCode: string;
  readonly status: SubscriptionStatus;
  readonly provider: string;
  readonly providerSubscriptionId: string | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelledAt: Date | null;
  readonly amountMinorUnits: number;
  readonly currency: string;
  readonly tenantId: string;
}

/**
 * WHO PAYS FOR A GIVEN BENEFICIARY — the seam the whole B2C/B2B question hangs
 * on.
 *
 * INJECTED, exactly like `notify`'s `RecipientReader` and `parent`'s
 * `TenantReader`, and for a stronger reason than either: this is not a
 * cross-module edge, it is a COMMERCIAL MODEL that has not been decided. The
 * B2C answer is `{ kind: 'user', id: actor.userId }`; the B2B answer looks the
 * subject's school up and returns `{ kind: 'school', id: schoolId }`.
 *
 * Both are one line at the composition root, and NEITHER is written into this
 * module. `billing` never assumes a parent is paying, because it never
 * constructs a payer at all.
 *
 * Returning null means "nobody can be billed for this user" — a school seat
 * with no school, say — and the service refuses the checkout rather than
 * falling back to charging the actor.
 */
export type PayerResolver = (subjectUserId: string, actor: BillingActor) => Promise<Payer | null>;

/**
 * `users.tenant_id`, read from the DATA.
 *
 * The D-091 mechanism, and the reason it is a separate injected function rather
 * than `actor.tenantId`: passing the actor's own tenant as the RESOURCE tenant
 * makes `assertTenantMatch` compare a value with itself — a check that always
 * passes, wearing the shape of one that sometimes fails. That defect has now
 * been found five times in this codebase, most recently in
 * `parent.authoriseSelf`, where it survived an entire test suite.
 */
export type TenantReader = (userId: string) => Promise<string | null>;

/** What a webhook delivery did. Returned so the route can choose a status code. */
export type WebhookOutcome =
  /** Signature failed. 400, no body detail, logged. */
  | { readonly result: 'rejected' }
  /** Already processed. 200 — the provider must stop retrying. */
  | { readonly result: 'duplicate' }
  /** Recorded; the subscription was updated or deliberately left alone. */
  | { readonly result: 'processed'; readonly changed: boolean };
